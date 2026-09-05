import { describe, expect, it } from "bun:test";
import { createBridgeApp } from "../src/bridge/server";
import type { BridgeDeps, StreamGateway, StreamStateView, StreamSubscribeResult } from "../src/bridge/server";
import type { AVD, Device } from "../src/device/types";
import type { ControlEvent, StreamViewer } from "../src/stream/types";
import { WS_CLOSE_CODES } from "../src/stream/types";
import { grpcControlInjector, type ControlInjector } from "../src/stream/control";
import { GrpcControlError } from "../src/device/grpc";
import type { EmulatorControl } from "../src/device/grpc";

/**
 * Bridge WS integration (task 2.1/2.6): in-memory Bun.serve on port 0 with a
 * REAL Bun WebSocket client, against a FAKE StreamGateway (no adb, no
 * emulator — the gateway contract is all the bridge cares about). In PR1 the
 * real gateway reports streaming UNSUPPORTED, so the video route always
 * rejects 4403 and the control route rejects at upgrade unless the (fake)
 * gateway reports an active injector.
 */

// ─── Fake gateway / viewer / deps ────────────────────────────────────────

class FakeViewer implements StreamViewer {
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
  async sendFrame(): Promise<void> {}
  async sendState(s: unknown): Promise<void> {
    this.states.push(s);
  }
  close(): void {
    this.open = false;
    this.closed++;
  }
}

/** Recording EmulatorControl double backing the fake gateway's injector. */
function fakeControl(opts: { failWith?: GrpcControlError } = {}): EmulatorControl & { calls: string[] } {
  const calls: string[] = [];
  const wrap = async (name: string, fn: () => Promise<void>): Promise<void> => {
    if (opts.failWith) throw opts.failWith;
    calls.push(name);
  };
  return {
    calls,
    tap: (x, y) => wrap(`tap(${x},${y})`, async () => {}),
    swipe: (x1, y1, x2, y2, durationMs) => wrap(`swipe(${x1},${y1},${x2},${y2},${durationMs})`, async () => {}),
    text: (t) => wrap(`text(${t})`, async () => {}),
    keyPress: (k) => wrap(`key(${k})`, async () => {}),
    keyCode: (c, t) => wrap(`keyCode(${c},${t})`, async () => {}),
    reportDisplaySize: () => undefined,
    refreshDisplay: async () => ({ width: 1080, height: 2400 }),
  };
}

class FakeGateway implements StreamGateway {
  supported = false;
  active = false;
  reason: string | undefined;
  /** The socket-facing viewers the bridge registered with us. */
  viewers: StreamViewer[] = [];
  /** Active control injector; null = no stream (upgrade → 409 STREAM_OFF). */
  injector: ControlInjector | null = null;
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
    if (!this.supported) return { ok: false, code: "UNSUPPORTED", reason: this.reason ?? "unsupported" };
    if (this.viewers.length >= 8) return { ok: false, code: "CAP_REACHED", reason: "viewer cap reached (8)" };
    this.viewers.push(viewer);
    return { ok: true, viewerId: viewer.id };
  }

  unsubscribeVideo(viewerId: string): void {
    this.unsubscribes++;
    const i = this.viewers.findIndex((v) => v.id === viewerId);
    if (i !== -1) this.viewers.splice(i, 1);
  }

  controlActive(): ControlInjector | null {
    return this.active ? this.injector : null;
  }
}

/** Recording injector fake (no gRPC client involved). */
function recordingInjector(calls: string[]): ControlInjector {
  return {
    async inject(event: ControlEvent): Promise<void> {
      calls.push(JSON.stringify(event));
    },
  };
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

describe("WS /v1/stream/video — unsupported until native RTC (PR1)", () => {
  it("rejects with close code 4403 (unsupported) and a JSON error body naming the reason", async () => {
    const gw = new FakeGateway();
    gw.supported = false;
    gw.reason = "rtc_streaming_not_deployed";
    const srv = makeServer(makeDeps(gw));
    try {
      let closeCode: number | undefined;
      let body = "";
      const ws = await srv.ws("/v1/stream/video");
      ws.addEventListener("close", (ev) => {
        closeCode = ev.code;
      });
      ws.addEventListener("message", (ev) => {
        body = String(ev.data);
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(closeCode).toBe(WS_CLOSE_CODES.UNSUPPORTED);
      expect(body).toContain("rtc_streaming_not_deployed");
    } finally {
      srv.stop();
    }
  });

  it("maps a NO_DEVICE subscription failure onto close 4404 with a JSON error", async () => {
    const gw = new FakeGateway();
    gw.supported = true;
    gw.reason = "no usable device for streaming";
    gw.subscribeVideo = async () => ({ ok: false, code: "NO_DEVICE", reason: gw.reason });
    const srv = makeServer(makeDeps(gw));
    try {
      let code: number | undefined;
      const ws = await srv.ws("/v1/stream/video");
      ws.addEventListener("close", (ev) => (code = ev.code));
      const err = await nextMessage(ws);
      const body = JSON.parse(String(err)) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("STREAM_NO_DEVICE");
      await new Promise((r) => setTimeout(r, 300));
      expect(code).toBe(WS_CLOSE_CODES.NO_DEVICE);
    } finally {
      srv.stop();
    }
  });

  it("rejects a 9th viewer with close code 4429 (viewer cap)", async () => {
    const gw = new FakeGateway();
    gw.supported = true;
    gw.active = true;
    for (let i = 0; i < 8; i++) {
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
    const gw = new FakeGateway();
    gw.supported = true;
    gw.active = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = gw.subscribeVideo.bind(gw);
    gw.subscribeVideo = async (viewer) => {
      gw.subscribes++;
      await gate;
      if (!viewer.open) return { ok: false, code: "NO_DEVICE", reason: "viewer closed during subscribe" };
      return orig(viewer);
    };
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
});

describe("WS /v1/stream/control — JSON inject → gRPC unary injector (design D3/D5)", () => {
  it("acks a tap during an active stream and routes it through the injector", async () => {
    const gw = new FakeGateway();
    gw.active = true;
    const control = fakeControl();
    gw.injector = grpcControlInjector(control);
    const srv = makeServer(makeDeps(gw));
    try {
      const ws = await srv.ws("/v1/stream/control");
      ws.send(JSON.stringify({ type: "inject", event: "tap", x: 540, y: 1200 }));
      const ack = await nextMessage(ws);
      expect(JSON.parse(String(ack))).toEqual({ type: "ack" });
      // The injector delivered the tap in device physical px.
      expect(control.calls).toEqual(["tap(540,1200)"]);
    } finally {
      srv.stop();
    }
  });

  it("returns a JSON error for an unknown inject type and KEEPS the connection open", async () => {
    const gw = new FakeGateway();
    gw.active = true;
    gw.injector = grpcControlInjector(fakeControl());
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
    gw.injector = grpcControlInjector(
      fakeControl({
        failWith: new GrpcControlError(
          "OUT_OF_RANGE",
          "coordinates out of physical display space (0..1079, 0..2339)",
          { x: 9999, y: 9999 },
        ),
      }),
    );
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

  it("returns INJECTION_FAILED (never an ack) when the injector fails mid-stream (Control injection failure)", async () => {
    const gw = new FakeGateway();
    gw.active = true;
    const injected: string[] = [];
    gw.injector = {
      async inject(): Promise<void> {
        injected.length = 0;
        throw new Error("control socket broke");
      },
    };
    void recordingInjector;
    const srv = makeServer(makeDeps(gw));
    try {
      const ws = await srv.ws("/v1/stream/control");
      ws.send(JSON.stringify({ type: "inject", event: "tap", x: 215, y: 480 }));
      const err = await nextMessage(ws);
      const body = JSON.parse(String(err)) as { type: string; code: string; message: string };
      expect(body.type).toBe("error");
      expect(body.code).toBe("INJECTION_FAILED");
      // The control WS itself stays open (error frame, not a close).
      await new Promise((r) => setTimeout(r, 100));
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    } finally {
      srv.stop();
    }
  });
});

describe("Bridge WS gating — secret + CORS (design §Stream Configuration)", () => {
  it("requires the shared secret on WS upgrades when the secret gate is on", async () => {
    const gw = new FakeGateway();
    gw.supported = false;
    gw.reason = "rtc_streaming_not_deployed";
    const srv = makeServer(makeDeps(gw), { secret: "s3cret" });
    try {
      // No secret header → upgrade rejected (HTTP 401, not a WS).
      const res = await srv.http("/v1/stream/video", {
        headers: { connection: "upgrade", upgrade: "websocket" },
      });
      expect(res.status).toBe(401);
      // With the secret header → WS connects, and only THEN hits the
      // unsupported gateway reject — proving the AUTH seam ran FIRST.
      let code: number | undefined;
      const ws = await srv.ws("/v1/stream/video", "s3cret");
      ws.addEventListener("close", (ev) => (code = ev.code));
      const first = await nextMessage(ws); // the unsupported JSON error body
      expect(String(first)).toContain("rtc_streaming_not_deployed");
      await new Promise((r) => setTimeout(r, 300));
      expect(code).toBe(WS_CLOSE_CODES.UNSUPPORTED);
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

describe("REST fallback — streaming state leaves /v1 frozen (Fallback contract)", () => {
  it("still injects taps through adb when NO stream is active (polling picks adb)", async () => {
    const gw = new FakeGateway();
    gw.active = false;
    const srv = makeServer(makeDeps(gw));
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

  it("still captures screenshots regardless of stream state (stills still captured)", async () => {
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

  it("reports stream state on /v1/state via the gateway snapshot (unsupported + reason)", async () => {
    const gw = new FakeGateway();
    gw.reason = "rtc_streaming_not_deployed";
    const srv = makeServer(makeDeps(gw));
    try {
      const res = await srv.http("/v1/state");
      const body = (await res.json()) as { stream?: { supported: boolean; active: boolean; viewers: number; reason?: string } };
      expect(body.stream).toEqual({
        supported: false,
        active: false,
        reason: "rtc_streaming_not_deployed",
        viewers: 0,
      });
    } finally {
      srv.stop();
    }
  });
});
