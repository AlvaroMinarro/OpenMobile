import { describe, expect, it } from "bun:test";
import { createBridgeApp } from "../src/bridge/server";
import type { BridgeDeps, StreamGateway, StreamStateView, StreamSubscribeResult } from "../src/bridge/server";
import type { AVD, Device } from "../src/device/types";
import type { ControlEvent, StreamViewer, VideoHandshake } from "../src/stream/types";
import {
  WS_CLOSE_CODES,
  MAX_VIEWERS,
} from "../src/stream/types";

/**
 * Bridge WS integration (task 2.1/2.6): in-memory Bun.serve on port 0 with a
 * REAL Bun WebSocket client, against a FAKE StreamGateway (no adb, no scrcpy —
 * the gateway contract is all the bridge cares about). The gateway double
 * produces a REAL handshake + AU frames for the video route and a REAL
 * control writer for the control route — the WS framing, close codes, CORS,
 * secret gate, and REST freezing are exercised end-to-end through sockets.
 */

// ─── Fake gateway / viewer / deps ────────────────────────────────────────

const HANDSHAKE: VideoHandshake = {
  type: "handshake",
  codec: "h264",
  lengthSize: 12,
  width: 430,
  height: 960,
  sps: "Z0LAKY1oGweeuQgICAg8IhGo",
  pps: "aM4BqDXI",
};

class FakeViewer implements StreamViewer {
  frames: Uint8Array[] = [];
  states: unknown[] = [];
  open = true;
  closed = 0;
  private readonly _id: string;
  constructor(id: string) {
    this._id = id;
  }
  get id(): string {
    return this._id;
  }
  async sendHandshake(): Promise<void> {}
  async sendFrame(f: Uint8Array): Promise<void> {
    this.frames.push(f);
  }
  async sendState(s: unknown): Promise<void> {
    this.states.push(s);
  }
  close(): void {
    this.open = false;
    this.closed++;
  }
}

class FakeGateway implements StreamGateway {
  supported = true;
  active = false;
  reason: string | undefined;
  /** The socket-facing viewers the bridge registered with us. */
  viewers: StreamViewer[] = [];
  ctrlEvents: Array<{ e: ControlEvent; bytes: Buffer[] }> = [];
  lastWriter: { video: { width: number; height: number }; write: (b: Buffer[]) => Promise<void> } | null = null;
  subscribes = 0;
  unsubscribes = 0;

  snapshot(): StreamStateView {
    return {
      supported: this.supported,
      active: this.active,
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
      viewers: this.viewers.length,
    };
  }

  async subscribeVideo(viewer: StreamViewer): Promise<StreamSubscribeResult> {
    this.subscribes++;
    if (!this.supported) return { ok: false, code: "UNSUPPORTED", reason: this.reason ?? "OPENMOBILE_STREAM=off" };
    if (!this.active) return { ok: false, code: "NO_DEVICE", reason: this.reason ?? "no usable device for streaming" };
    if (this.viewers.length >= MAX_VIEWERS) return { ok: false, code: "CAP_REACHED", reason: "viewer cap reached (8)" };
    this.viewers.push(viewer);
    return { ok: true, viewerId: viewer.id };
  }

  unsubscribeVideo(viewerId: string): void {
    this.unsubscribes++;
    const i = this.viewers.findIndex((v) => v.id === viewerId);
    if (i !== -1) this.viewers.splice(i, 1);
  }

  controlActive(): { video: { width: number; height: number }; write: (b: Buffer[]) => Promise<void> } | null {
    return this.active ? this.lastWriter : null;
  }
}

/**
 * FakeGateway whose subscribeVideo blocks until the test releases it —
 * reproduces the connect race: the WS closes while subscribe is pending.
 * Mirrors the real gateway's post-await liveness re-check.
 */
class GatedGateway extends FakeGateway {
  gate!: Promise<void>;
  async subscribeVideo(viewer: StreamViewer): Promise<StreamSubscribeResult> {
    this.subscribes++;
    await this.gate;
    if (!viewer.open) return { ok: false, code: "NO_DEVICE", reason: "viewer closed during subscribe" };
    return super.subscribeVideo(viewer);
  }
}

function makeDeps(gateway: StreamGateway | undefined, overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  const state: {
    devices: Device[];
    emulators: AVD[];
    taps: Array<{ s: string; x: number; y: number }>;
    captures: Array<{ serial: string; outPath: string }>;
  } = {
    devices: [{ serial: "emulator-5554", state: "device", model: "Pixel_9_Pro" }],
    emulators: [{ name: "Pixel_9_Pro", running: true }],
    taps: [],
    captures: [],
  };
  const deps: BridgeDeps = {
    bridge: { version: "test", pid: 1234 },
    adb: {
      devices: async () => state.devices,
      inputTap: async (s, x, y) => void state.taps.push({ s, x, y }),
      inputSwipe: async () => {},
      inputText: async () => {},
    },
    cli: {
      emulatorList: async () => state.emulators,
      capture: async (t) => void state.captures.push(t),
    },
    env: {},
    readFile: async () => {
      // A real 2x2 PNG (sharp-generated) so the JPEG-param paths decode.
      return new Uint8Array([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
        0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0, 253, 212, 154, 115,
        0, 0, 0, 9, 112, 72, 89, 115, 0, 0, 3, 232, 0, 0, 3, 232,
        1, 181, 123, 82, 107, 0, 0, 0, 18, 73, 68, 65, 84, 8, 153, 99,
        56, 145, 98, 116, 34, 197, 136, 1, 66, 1, 0, 40, 174, 5, 121,
        159, 94, 63, 149, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
      ]);
    },
    tempPngPath: () => "/tmp/om-ws-mock.png",
    streamGateway: gateway,
    ...overrides,
  };
  return deps;
}

function makeServer(deps: BridgeDeps, opts?: { secret?: string }) {
  const app = createBridgeApp(deps, opts);
  const server = Bun.serve<Record<string, unknown>>({
    port: 0,
    fetch: app.fetch,
    websocket: app.websocket,
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    http: (path: string, init?: RequestInit) => server.fetch(new Request(`${base}${path}`, init)),
    ws: (path: string, secret?: string) => {
      return new Promise<WebSocket>((resolve, reject) => {
        const url = `ws://127.0.0.1:${server.port}${path}`;
        const headers: Record<string, string> = {};
        if (secret !== undefined) headers["x-openmobile-secret"] = secret;
        const ws = new WebSocket(url, { headers });
        ws.addEventListener("open", () => resolve(ws));
        ws.addEventListener("error", (e) => reject(new Error(`ws error: ${(e as ErrorEvent).message ?? "open failed"}`)));
      });
    },
    stop: () => server.stop(),
  };
}

function nextMessage(ws: WebSocket, pred?: (data: unknown) => boolean): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("nextMessage timed out")), 4000);
    const onMsg = (ev: MessageEvent) => {
      const data = ev.data;
      if (pred && !pred(data)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      resolve(data);
    };
    ws.addEventListener("message", onMsg);
  });
}

function au(tag: number): Uint8Array {
  return Uint8Array.from([0, 0, 0, 1, tag, 0x11, 0x22, 0x33]);
}

describe("WS /v1/stream/video — handshake + binary AUs (design D2)", () => {
  it("upgrades, sends the JSON handshake first, then streams binary Annex-B AUs (Stream connects)", async () => {
    const gw = new FakeGateway();
    gw.active = true;
    gw.lastWriter = {
      video: { width: 430, height: 960 },
      write: async () => {},
    };
    const deps = makeDeps(gw);
    const srv = makeServer(deps);
    try {
      const ws = await srv.ws("/v1/stream/video");
      // 1) The gateway got the socket-facing viewer.
      expect(gw.viewers).toHaveLength(1);
      const viewer = gw.viewers[0]!;
      // 2) The daemon's handshake → JSON handshake over the socket.
      await viewer.sendHandshake(HANDSHAKE);
      const first = await nextMessage(ws);
      const hs = JSON.parse(String(first)) as VideoHandshake;
      expect(hs.type).toBe("handshake");
      expect(hs.codec).toBe("h264");
      expect(hs.lengthSize).toBe(12);
      expect(hs.width).toBe(430);
      expect(hs.height).toBe(960);
      expect(hs.sps).toBe("Z0LAKY1oGweeuQgICAg8IhGo");
      expect(hs.pps).toBe("aM4BqDXI");
      // 3) Push an AU through the gateway → binary frame over the socket.
      await viewer.sendFrame(au(0x65)); // IDR
      const second = await nextMessage(ws);
      const bin = second instanceof Uint8Array ? second : typeof second === "string" ? Buffer.from(second, "binary") : new Uint8Array(second as ArrayBuffer);
      expect(Buffer.from(bin.subarray(0, 4)).toString("hex")).toBe("00000001");
      expect(bin[4]).toBe(0x65);
      // 4) State message flows too.
      await viewer.sendState({ type: "state", state: "streaming" });
      const st = await nextMessage(ws);
      expect(JSON.parse(String(st))).toEqual({ type: "state", state: "streaming" });
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(gw.viewers).toHaveLength(0); // close → unsubscribe
    } finally {
      srv.stop();
    }
  });

  it("rejects with close code 4403 (unsupported) when the kill-switch is off", async () => {
    const gw = new FakeGateway();
    gw.supported = false;
    gw.reason = "OPENMOBILE_STREAM=off";
    const srv = makeServer(makeDeps(gw));
    try {
      let closeCode: number | undefined;
      const ws = await srv.ws("/v1/stream/video");
      ws.addEventListener("close", (ev) => {
        closeCode = ev.code;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(closeCode).toBe(WS_CLOSE_CODES.UNSUPPORTED);
    } finally {
      srv.stop();
    }
  });

  it("rejects with close code 4404 (no device) when the gateway cannot start", async () => {
    const gw = new FakeGateway();
    gw.active = false;
    gw.reason = "push failed: adb: device offline";
    const srv = makeServer(makeDeps(gw));
    try {
      const ws = await srv.ws("/v1/stream/video");
      // The daemon's push failed → the bridge rejects with 4404.
      let code: number | undefined;
      ws.addEventListener("close", (ev) => (code = ev.code));
      const err = await nextMessage(ws);
      const body = JSON.parse(String(err)) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("STREAM_NO_DEVICE");
      expect(body.error.message).toContain("push failed");
      await new Promise((r) => setTimeout(r, 300));
      expect(code).toBe(WS_CLOSE_CODES.NO_DEVICE);
    } finally {
      srv.stop();
    }
  });

  it("rejects an 9th viewer with close code 4429 (viewer cap)", async () => {
    const gw = new FakeGateway();
    gw.active = true;
    for (let i = 0; i < MAX_VIEWERS; i++) {
      const v = new FakeViewer(`pre-${i}`);
      gw.viewers.push(v);
    }
    const srv = makeServer(makeDeps(gw));
    try {
      const ws = await srv.ws("/v1/stream/video");
      let code: number | undefined;
      ws.addEventListener("close", (ev) => (code = ev.code));
      await new Promise((r) => setTimeout(r, 300));
      expect(code).toBe(WS_CLOSE_CODES.VIEWER_CAP);
    } finally {
      srv.stop();
    }
  });

  it("unsubscribes a video viewer whose socket closes while subscribe is still pending (connect race ghost)", async () => {
    const gw = new GatedGateway();
    gw.active = true;
    let release!: () => void;
    gw.gate = new Promise((r) => (release = r));
    const srv = makeServer(makeDeps(gw));
    try {
      const ws = await srv.ws("/v1/stream/video");
      // Wait until the bridge is actually blocked inside subscribeVideo.
      for (let i = 0; i < 100 && gw.subscribes === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(gw.subscribes).toBe(1);
      ws.close(); // tab reload / rapid close while subscribe is pending
      await new Promise((r) => setTimeout(r, 50)); // let the server process the close
      release(); // subscribe resolves AFTER the close landed
      await new Promise((r) => setTimeout(r, 100));
      // viewerId must have been assigned BEFORE the await, so the close
      // handler could unsubscribe; the gateway never registered the ghost.
      expect(gw.unsubscribes).toBe(1);
      expect(gw.viewers).toHaveLength(0);
    } finally {
      srv.stop();
    }
  });

  it("sends a state message with reason device_lost and closes 4409 when the stream dies", async () => {
    const gw = new FakeGateway();
    gw.active = true;
    const srv = makeServer(makeDeps(gw));
    try {
      const ws = await srv.ws("/v1/stream/video");
      await new Promise((r) => setTimeout(r, 50));
      const viewer = gw.viewers[0]!;
      // Send the handshake so the client is decoding, then the daemon →
      // gateway layer emits a device_lost state and closes the viewer.
      await viewer.sendHandshake(HANDSHAKE);
      const first = await nextMessage(ws);
      expect(JSON.parse(String(first)).type).toBe("handshake");
      await viewer.sendState({ type: "state", state: "error", reason: "device_lost" });
      const st = await nextMessage(ws);
      expect(JSON.parse(String(st))).toEqual({ type: "state", state: "error", reason: "device_lost" });
      let code: number | undefined;
      ws.addEventListener("close", (ev) => (code = ev.code));
      viewer.close(); // gateway closes the socket → bridge closes with 4409
      await new Promise((r) => setTimeout(r, 300));
      expect(code).toBe(WS_CLOSE_CODES.DEVICE_LOST);
    } finally {
      srv.stop();
    }
  });
});

describe("WS /v1/stream/control — JSON inject → scrcpy bytes (design D3)", () => {
  it("acks a tap during an active stream and writes the scrcpy touch bytes", async () => {
    const gw = new FakeGateway();
    gw.active = true;
    const written: Buffer[] = [];
    gw.lastWriter = {
      video: { width: 430, height: 960 },
      write: async (b: Buffer[]) => {
        written.push(...b);
      },
    };
    const srv = makeServer(makeDeps(gw));
    try {
      const ws = await srv.ws("/v1/stream/control");
      ws.send(JSON.stringify({ type: "inject", event: "tap", x: 215, y: 480 }));
      const ack = await nextMessage(ws);
      expect(JSON.parse(String(ack))).toEqual({ type: "ack" });
      // The gateway's control writer got the scrcpy bytes: touch DOWN + UP.
      expect(written.length).toBe(2);
      expect(written[0]![0]).toBe(2); // TYPE_INJECT_TOUCH_EVENT
      expect(written[1]![0]).toBe(2);
    } finally {
      srv.stop();
    }
  });

  it("returns a JSON error for an unknown inject type and KEEPS the connection open", async () => {
    const gw = new FakeGateway();
    gw.active = true;
    gw.lastWriter = { video: { width: 430, height: 960 }, write: async () => {} };
    const srv = makeServer(makeDeps(gw));
    try {
      const ws = await srv.ws("/v1/stream/control");
      ws.send(JSON.stringify({ type: "inject", event: "pinch" }));
      const err = await nextMessage(ws);
      const body = JSON.parse(String(err)) as { type: string; code: string; message: string };
      expect(body.type).toBe("error");
      expect(body.code).toBe("UNSUPPORTED_EVENT");
      // Connection still open (spec: Unknown inject type)
      await new Promise((r) => setTimeout(r, 150));
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    } finally {
      srv.stop();
    }
  });

  it("rejects control without an active stream (Control without stream)", async () => {
    const gw = new FakeGateway();
    gw.active = false; // no stream
    const srv = makeServer(makeDeps(gw));
    try {
      // The upgrade is REJECTED (never a silent hang): an HTTP 409 with the
      // STREAM_OFF error body naming the REST fallback.
      const res = await srv.http("/v1/stream/control", {
        headers: { connection: "upgrade", upgrade: "websocket" },
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("STREAM_OFF");
    } finally {
      srv.stop();
    }
  });

  it("returns a JSON error for out-of-range tap coordinates (Out-of-range coordinates)", async () => {
    const gw = new FakeGateway();
    gw.active = true;
    gw.lastWriter = { video: { width: 430, height: 960 }, write: async () => {} };
    const srv = makeServer(makeDeps(gw));
    try {
      const ws = await srv.ws("/v1/stream/control");
      ws.send(JSON.stringify({ type: "inject", event: "tap", x: 9999, y: 9999 }));
      const err = await nextMessage(ws);
      const body = JSON.parse(String(err)) as { code: string };
      expect(body.code).toBe("OUT_OF_RANGE");
      ws.close();
    } finally {
      srv.stop();
    }
  });
});

describe("Bridge WS gating — secret + CORS + kill-switch (design §Stream Configuration)", () => {
  it("requires the shared secret on WS upgrades when the secret gate is on", async () => {
    const gw = new FakeGateway();
    gw.active = true;
    const srv = makeServer(makeDeps(gw), { secret: "s3cret" });
    try {
      // No secret header → upgrade rejected (HTTP 401, not a WS).
      const res = await srv.http("/v1/stream/video", {
        headers: { connection: "upgrade", upgrade: "websocket" },
      });
      expect(res.status).toBe(401);
      // With the secret header → WS connects.
      const ws = await srv.ws("/v1/stream/video", "s3cret");
      await new Promise((r) => setTimeout(r, 50)); // let subscribeVideo settle
      await gw.viewers[0]!.sendHandshake(HANDSHAKE);
      const first = await nextMessage(ws);
      expect(JSON.parse(String(first)).type).toBe("handshake");
      ws.close();
    } finally {
      srv.stop();
    }
  });

  it("answers OPTIONS with CORS headers (preflight)", async () => {
    const gw = new FakeGateway();
    gw.active = true;
    const srv = makeServer(makeDeps(gw));
    try {
      const res = await srv.http("/v1/stream/video", {
        method: "OPTIONS",
        headers: { origin: "http://im-dot.example", "access-control-request-method": "GET" },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://im-dot.example");
      expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    } finally {
      srv.stop();
    }
  });
});

describe("REST fallback — streaming on/off leaves /v1 frozen (Fallback contract)", () => {
  it("still injects taps through adb when NO stream is active (polling picks adb)", async () => {
    const { deps, state } = (() => {
      const gw = new FakeGateway();
      gw.active = false;
      const d = makeDeps(gw);
      return { deps: d, state: (d.adb as unknown as { __state?: never }) ?? null };
    })();
    void state;
    const srv = makeServer(deps);
    try {
      const res = await srv.http("/v1/input/tap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: 100, y: 200 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; serial: string };
      expect(body.ok).toBe(true);
      expect(body.serial).toBe("emulator-5554");
    } finally {
      srv.stop();
    }
  });

  it("still captures screenshots when streaming is active (stills still captured)", async () => {
    const gw = new FakeGateway();
    gw.active = true;
    const srv = makeServer(makeDeps(gw));
    try {
      const res = await srv.http("/v1/screenshot");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("image/png");
    } finally {
      srv.stop();
    }
  });

  it("reports stream state on /v1/state via the gateway snapshot (Active stream reports)", async () => {
    const gw = new FakeGateway();
    gw.active = true;
    const srv = makeServer(makeDeps(gw));
    try {
      const res = await srv.http("/v1/state");
      const body = (await res.json()) as { stream?: { supported: boolean; active: boolean; viewers: number } };
      expect(body.stream).toEqual({ supported: true, active: true, viewers: 0 });
    } finally {
      srv.stop();
    }
  });
});