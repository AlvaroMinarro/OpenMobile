import { describe, expect, it } from "bun:test";
import {
  createStreamClient,
  type PeerConnectionLike,
  type SignalSocketLike,
  type StreamClient,
  type StreamClientMessage,
  type StreamClientStatus,
} from "../src/stream/client/index";
import type { RtcIceCandidateInit } from "../src/stream/types";

/**
 * Browser RTC stream client (Phase 3 / PR3) — signaling behavior against a
 * fake WS server (task 3.5). The RTCPeerConnection is a fake (Bun has no
 * WebRTC); the sockets are REAL: an in-process Bun.serve WS server plays the
 * daemon (handshake → offer → ice/state) and records every client frame, so
 * the exact wire contract the Phase-2 daemon pins is exercised end-to-end
 * over real WebSockets.
 */

const CLIENT_ANSWER_SDP = "v=0\r\nfake client answer";

/** Fake RTCPeerConnection: records the JSEP dance the client performs. */
class FakePeerConnection implements PeerConnectionLike {
  readonly calls: string[] = [];
  remote: { type: string; sdp: string } | null = null;
  local: { type: string; sdp: string } | null = null;
  readonly addedCandidates: RtcIceCandidateInit[] = [];
  connectionState = "new";
  closed = false;
  onicecandidate: ((ev: { candidate: RtcIceCandidateInit | null }) => void) | null = null;
  ontrack: ((ev: { track: unknown; streams: readonly unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  async setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.calls.push("setRemoteDescription");
    this.remote = desc;
  }

  async createAnswer(): Promise<{ type: string; sdp: string }> {
    this.calls.push("createAnswer");
    return { type: "answer", sdp: CLIENT_ANSWER_SDP };
  }

  async setLocalDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.calls.push("setLocalDescription");
    this.local = desc;
  }

  get localDescription(): { type: string; sdp: string } | null {
    return this.local;
  }

  async addIceCandidate(candidate: RtcIceCandidateInit): Promise<void> {
    this.calls.push("addIceCandidate");
    this.addedCandidates.push(candidate);
  }

  close(): void {
    this.closed = true;
  }

  // Test-side triggers (the browser fires these from the ICE/track threads).
  fireIce(candidate: RtcIceCandidateInit | null): void {
    this.onicecandidate?.({ candidate });
  }

  fireTrack(stream: unknown): void {
    this.ontrack?.({ track: {}, streams: [stream] });
  }

  setState(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

interface ConnCtl {
  url: string;
  received: unknown[];
  send(msg: unknown): void;
  sendRaw(raw: string): void;
  closeFromServer(code: number, reason: string): void;
  opened(): Promise<void>;
  closed(): Promise<{ code: number; reason: string }>;
}

interface FakeServer {
  video: ConnCtl;
  control: ConnCtl;
  stop(): void;
}

/** In-process WS server with video+control routes; plays the daemon side. */
function makeServer(): FakeServer {
  interface RouteState {
    ws: Bun.ServerWebSocket<unknown> | null;
    received: unknown[];
    openResolve: (() => void) | null;
    openPromise: Promise<void>;
    closeResolve: ((c: { code: number; reason: string }) => void) | null;
    closePromise: Promise<{ code: number; reason: string }>;
  }
  const routes: Record<"video" | "control", RouteState> = {
    video: fresh(),
    control: fresh(),
  };

  function fresh(): RouteState {
    let openResolve: (() => void) | null = null;
    const openPromise = new Promise<void>((r) => (openResolve = r));
    let closeResolve: ((c: { code: number; reason: string }) => void) | null = null;
    const closePromise = new Promise<{ code: number; reason: string }>((r) => (closeResolve = r));
    return {
      ws: null,
      received: [],
      openResolve,
      openPromise,
      closeResolve,
      closePromise,
    };
  }

  const server = Bun.serve<string>({
    port: 0,
    fetch(req, srv) {
      const path = new URL(req.url).pathname;
      const kind = path.endsWith("/video") ? "video" : "control";
      if (srv.upgrade(req, { data: kind })) return new Response(null, { status: 101 });
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        const route = routes[ws.data as "video" | "control"];
        route.ws = ws;
        route.openResolve?.();
      },
      message(ws, msg) {
        const route = routes[ws.data as "video" | "control"];
        const text = typeof msg === "string" ? msg : Buffer.from(msg as Uint8Array).toString("utf8");
        try {
          route.received.push(JSON.parse(text));
        } catch {
          route.received.push({ __raw: text });
        }
      },
      close(ws, code, reason) {
        const route = routes[ws.data as "video" | "control"];
        route.closeResolve?.({ code, reason: reason.toString() });
      },
    },
  });

  function ctl(name: "video" | "control"): ConnCtl {
    const route = routes[name];
    return {
      url: `ws://127.0.0.1:${server.port}/v1/stream/${name}`,
      received: route.received,
      send: (msg) => route.ws?.send(JSON.stringify(msg)),
      sendRaw: (raw) => route.ws?.send(raw),
      closeFromServer: (code, reason) => route.ws?.close(code, reason),
      opened: () => route.openPromise,
      closed: () => route.closePromise,
    };
  }

  return { video: ctl("video"), control: ctl("control"), stop: () => server.stop(true) };
}

const servers: FakeServer[] = [];
const pcs: FakePeerConnection[] = [];

function makeClient(opts: {
  server: FakeServer;
  onStatus?: (s: StreamClientStatus) => void;
  pc?: FakePeerConnection;
  createPeerConnection?: () => PeerConnectionLike;
}): StreamClient {
  const pc = opts.pc ?? new FakePeerConnection();
  pcs.push(pc);
  return createStreamClient({
    url: opts.server.video.url,
    video: { srcObject: null },
    onStatus: opts.onStatus,
    deps: {
      createSignalSocket: (url) => new WebSocket(url) as unknown as SignalSocketLike,
      createControlSocket: (url) => new WebSocket(url) as unknown as SignalSocketLike,
      createPeerConnection: opts.createPeerConnection ?? (() => pc),
    },
  });
}

/** Status collector with event-driven waits (fail fast at 4s). */
function collector() {
  const list: StreamClientStatus[] = [];
  const waiters: Array<{ pred: (s: StreamClientStatus) => boolean; resolve: (s: StreamClientStatus) => void }> = [];
  const onStatus = (s: StreamClientStatus): void => {
    list.push(s);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(s)) {
        waiters[i]!.resolve(s);
        waiters.splice(i, 1);
      }
    }
  };
  const waitFor = <P extends StreamClientStatus["phase"]>(
    phase: P,
  ): Promise<Extract<StreamClientStatus, { phase: P }>> => {
    const pred = (s: StreamClientStatus): s is Extract<StreamClientStatus, { phase: P }> =>
      s.phase === phase;
    const hit = list.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`status wait timed out; got ${JSON.stringify(list)}`)), 4000);
      waiters.push({
        pred: (s) => {
          if (pred(s)) {
            clearTimeout(timer);
            return true;
          }
          return false;
        },
        resolve: resolve as (s: StreamClientStatus) => void,
      });
    });
  };
  return { list, onStatus, waitFor, phases: () => list.map((s) => s.phase) };
}

function messages(client: StreamClient): StreamClientMessage[] {
  const list: StreamClientMessage[] = [];
  const prev = client.onMessage;
  client.onMessage = (m) => {
    list.push(m);
    prev?.(m);
  };
  return list;
}

/** Drive the daemon side: handshake then offer once the socket is open. */
function playHandshakeOffer(srv: FakeServer, opts: { codecs?: string[] } = {}): Promise<void> {
  return srv.video.opened().then(() => {
    srv.video.send({ type: "handshake", rtcId: "guid-1", fps: 30, codecs: opts.codecs ?? ["VP8"] });
    srv.video.send({ type: "offer", sdp: "v=0 emulator offer" });
  });
}

const settle = () => Bun.sleep(30);

/** Wait until the fake daemon observes a matching frame (async delivery). */
async function waitForFrame(
  conn: ConnCtl,
  pred: (msg: unknown) => boolean,
): Promise<unknown> {
  for (let i = 0; i < 100; i++) {
    const hit = conn.received.find(pred);
    if (hit !== undefined) return hit;
    await Bun.sleep(20);
  }
  throw new Error(`frame wait timed out; got ${JSON.stringify(conn.received)}`);
}

// ─── Batch A: signaling core (handshake first, VP8 mandatory, answer) ──

describe("RTC stream client — signaling vs fake WS server", () => {
  it("answers the emulator's offer in JSEP order after the VP8 handshake", async () => {
    const srv = makeServer();
    servers.push(srv);
    void playHandshakeOffer(srv);
    const col = collector();
    const pc = new FakePeerConnection();
    const client = makeClient({ server: srv, onStatus: col.onStatus, pc });
    await client.open();
    expect(pc.remote).toEqual({ type: "offer", sdp: "v=0 emulator offer" });
    expect(pc.calls).toEqual(["setRemoteDescription", "createAnswer", "setLocalDescription"]);
    await waitForFrame(srv.video, (m) => (m as { type?: string }).type === "answer");
    expect(srv.video.received).toEqual([{ type: "answer", sdp: CLIENT_ANSWER_SDP }]);
    expect(col.list).toEqual([
      { phase: "connecting" },
      { phase: "handshake", rtcId: "guid-1", fps: 30 },
    ]);
  });

  it("refuses a handshake without VP8 — VP8 is mandatory (no answer, no PC use)", async () => {
    const srv = makeServer();
    servers.push(srv);
    void srv.video.opened().then(() => {
      srv.video.send({ type: "handshake", rtcId: "guid-1", fps: 30, codecs: ["H264"] });
    });
    const col = collector();
    let pcBuilt = 0;
    const client = makeClient({
      server: srv,
      onStatus: col.onStatus,
      createPeerConnection: () => {
        pcBuilt += 1;
        return new FakePeerConnection();
      },
    });
    await client.open().catch(() => {});
    const err = await col.waitFor("error");
    expect(err.message).toContain("VP8");
    expect(srv.video.received).toEqual([]); // never answered
    expect(pcBuilt).toBe(0); // PC never created
    const closed = await srv.video.closed();
    expect(closed.code).toBe(1000); // client tears the socket down itself
  });

  it("rejects an offer that arrives before the handshake (protocol order)", async () => {
    const srv = makeServer();
    servers.push(srv);
    void srv.video.opened().then(() => {
      srv.video.send({ type: "offer", sdp: "v=0 emulator offer" });
    });
    const col = collector();
    const client = makeClient({ server: srv, onStatus: col.onStatus });
    await client.open().catch(() => {});
    const err = await col.waitFor("error");
    expect(err.message).toContain("before");
    expect(srv.video.received).toEqual([]);
  });
});

// ─── Batch B: ICE, streaming state, close codes, malformed frames ────────

describe("RTC stream client — ICE relay and stream state", () => {
  it("relays local ICE candidates as ice frames (trickle, after the answer)", async () => {
    const srv = makeServer();
    servers.push(srv);
    const pc = new FakePeerConnection();
    void playHandshakeOffer(srv);
    const client = makeClient({ server: srv, pc });
    await client.open();
    pc.fireIce({ candidate: "candidate:1 1 UDP 2124417 127.0.0.1 54321 typ host", sdpMid: "0", sdpMLineIndex: 0 });
    await waitForFrame(srv.video, (m) => (m as { type?: string }).type === "ice");
    expect(srv.video.received).toEqual([
      { type: "answer", sdp: CLIENT_ANSWER_SDP },
      {
        type: "ice",
        candidate: { candidate: "candidate:1 1 UDP 2124417 127.0.0.1 54321 typ host", sdpMid: "0", sdpMLineIndex: 0 },
      },
    ]);
  });

  it("never relays end-of-candidates (null) ice events", async () => {
    const srv = makeServer();
    servers.push(srv);
    const pc = new FakePeerConnection();
    void playHandshakeOffer(srv);
    const client = makeClient({ server: srv, pc });
    await client.open();
    pc.fireIce(null);
    await settle();
    expect(srv.video.received).toEqual([{ type: "answer", sdp: CLIENT_ANSWER_SDP }]);
  });

  it("applies the emulator's ice frames onto the peer connection", async () => {
    const srv = makeServer();
    servers.push(srv);
    const pc = new FakePeerConnection();
    void playHandshakeOffer(srv);
    const client = makeClient({ server: srv, pc });
    await client.open();
    srv.video.send({
      type: "ice",
      candidate: { candidate: "candidate:2 1 UDP 2124417 127.0.0.1 54322 typ host", sdpMid: "0", sdpMLineIndex: 0 },
    });
    await settle();
    expect(pc.addedCandidates).toEqual([
      { candidate: "candidate:2 1 UDP 2124417 127.0.0.1 54322 typ host", sdpMid: "0", sdpMLineIndex: 0 },
    ]);
  });

  it("buffers remote ice arriving before the answer is set, then flushes", async () => {
    const srv = makeServer();
    servers.push(srv);
    const pc = new FakePeerConnection();
    void srv.video.opened().then(() => {
      srv.video.send({ type: "handshake", rtcId: "guid-1", fps: 30, codecs: ["VP8"] });
      srv.video.send({ type: "offer", sdp: "v=0 emulator offer" });
      srv.video.send({
        type: "ice",
        candidate: { candidate: "candidate:early", sdpMid: "0", sdpMLineIndex: 0 },
      });
    });
    const client = makeClient({ server: srv, pc });
    await client.open();
    expect(pc.addedCandidates).toEqual([{ candidate: "candidate:early", sdpMid: "0", sdpMLineIndex: 0 }]);
  });

  it("reports streaming + relays state:streaming when the peer connects, attaching the track", async () => {
    const srv = makeServer();
    servers.push(srv);
    const pc = new FakePeerConnection();
    const sink = { srcObject: null as unknown };
    void playHandshakeOffer(srv);
    const col = collector();
    const client = createStreamClient({
      url: srv.video.url,
      video: sink,
      onStatus: col.onStatus,
      deps: {
        createSignalSocket: (url) => new WebSocket(url) as unknown as SignalSocketLike,
        createPeerConnection: () => pc,
      },
    });
    await client.open();
    const fakeStream = { id: "stream-1" };
    pc.fireTrack(fakeStream);
    expect(sink.srcObject).toBe(fakeStream);
    pc.setState("connected");
    await col.waitFor("streaming");
    await waitForFrame(srv.video, (m) => (m as { type?: string }).type === "state");
    expect(srv.video.received).toEqual([
      { type: "answer", sdp: CLIENT_ANSWER_SDP },
      { type: "state", state: "streaming" },
    ]);
  });

  it("surfaces peer connection failure as an error status", async () => {
    const srv = makeServer();
    servers.push(srv);
    const pc = new FakePeerConnection();
    void playHandshakeOffer(srv);
    const col = collector();
    const client = makeClient({ server: srv, onStatus: col.onStatus, pc });
    await client.open();
    pc.setState("failed");
    const err = await col.waitFor("error");
    expect(err.message).toContain("peer connection");
  });
});

describe("RTC stream client — server lifecycle frames and closes", () => {
  it("surfaces server state:error frames with their reason", async () => {
    const srv = makeServer();
    servers.push(srv);
    void playHandshakeOffer(srv);
    const col = collector();
    const client = makeClient({ server: srv, onStatus: col.onStatus });
    await client.open();
    srv.video.send({ type: "state", state: "error", reason: "device lost" });
    const err = await col.waitFor("error");
    expect(err.message).toBe("device lost");
  });

  it("surfaces server close codes on the closed status (4429 cap, 4409 lost)", async () => {
    for (const code of [4429, 4409]) {
      const srv = makeServer();
      servers.push(srv);
      void playHandshakeOffer(srv);
      const col = collector();
      const client = makeClient({ server: srv, onStatus: col.onStatus });
      await client.open();
      srv.video.closeFromServer(code, code === 4429 ? "viewer cap reached (8)" : "device lost");
      const s = await col.waitFor("closed");
      expect(s.code).toBe(code);
    }
  });

  it("rejects malformed signaling frames: invalid JSON and unknown types", async () => {
    for (const raw of ["this is not json", JSON.stringify({ type: "zap" })]) {
      const srv = makeServer();
      servers.push(srv);
      void srv.video.opened().then(() => srv.video.sendRaw(raw));
      const col = collector();
      const client = makeClient({ server: srv, onStatus: col.onStatus });
      await client.open().catch(() => {});
      const err = await col.waitFor("error");
      expect(err.message.length).toBeGreaterThan(0);
      const closed = await srv.video.closed();
      expect(closed.code).toBe(1000); // client tears the socket down itself
    }
  });
});

// ─── Batch C: control socket (sendInput) + client lifecycle ─────────────

describe("RTC stream client — control socket and lifecycle", () => {
  it("sends inject frames over the derived /control socket and surfaces acks", async () => {
    const srv = makeServer();
    servers.push(srv);
    void playHandshakeOffer(srv);
    const col = collector();
    const client = makeClient({ server: srv, onStatus: col.onStatus });
    await client.open();
    const msgs = messages(client);
    // Lazy connect: the first call triggers the control socket and reports
    // not-open (caller falls back to REST /v1/input/* meanwhile).
    expect(client.sendInput({ type: "inject", event: "tap", x: 10, y: 20 })).toBe(false);
    await srv.control.opened();
    await settle(); // client-side open event may lag the server-side accept
    expect(client.sendInput({ type: "inject", event: "tap", x: 10, y: 20 })).toBe(true);
    await waitForFrame(srv.control, (m) => (m as { type?: string }).type === "inject");
    expect(srv.control.received).toEqual([{ type: "inject", event: "tap", x: 10, y: 20 }]);
    // Daemon acks; the client surfaces it through the assignable onMessage.
    srv.control.send({ type: "ack" });
    await settle();
    await settle();
    expect(msgs).toEqual([{ type: "ack" }]);
  });

  it("returns false for input while closed and surfaces control error frames", async () => {
    const srv = makeServer();
    servers.push(srv);
    void playHandshakeOffer(srv);
    const client = makeClient({ server: srv });
    await client.open();
    const msgs = messages(client);
    expect(client.sendInput({ type: "inject", event: "tap", x: 1, y: 2 })).toBe(false);
    await srv.control.opened();
    await settle(); // client-side open event may lag the server-side accept
    expect(client.sendInput({ type: "inject", event: "tap", x: 1, y: 2 })).toBe(true);
    srv.control.send({ type: "error", code: "VALIDATION_ERROR", message: "x out of bounds" });
    await settle();
    await settle();
    expect(msgs).toEqual([{ type: "error", code: "VALIDATION_ERROR", message: "x out of bounds" }]);
    client.close();
    expect(client.sendInput({ type: "inject", event: "tap", x: 1, y: 2 })).toBe(false);
  });

  it("close() is idempotent: closes pc + both sockets, emits one closed status", async () => {
    const srv = makeServer();
    servers.push(srv);
    const pc = new FakePeerConnection();
    void playHandshakeOffer(srv);
    const col = collector();
    const client = makeClient({ server: srv, onStatus: col.onStatus, pc });
    await client.open();
    // The lazy control socket must exist to be closed by close().
    expect(client.sendInput({ type: "inject", event: "tap", x: 1, y: 2 })).toBe(false);
    await srv.control.opened();
    client.close();
    client.close(); // idempotent
    expect(pc.closed).toBe(true);
    await srv.video.closed();
    await srv.control.closed();
    expect(col.phases()).toEqual(["connecting", "handshake", "closed"]);
  });

  it("derives the control URL from the video URL (pure helper)", () => {
    // Imported lazily so this stays a unit check on the exported helper.
    return import("../src/stream/client/index").then(({ deriveControlUrl, hasVp8 }) => {
      expect(deriveControlUrl("ws://127.0.0.1:8765/v1/stream/video")).toBe(
        "ws://127.0.0.1:8765/v1/stream/control",
      );
      expect(deriveControlUrl("ws://127.0.0.1:8765/v1/stream/video?device=e")).toBe(
        "ws://127.0.0.1:8765/v1/stream/control?device=e",
      );
      expect(hasVp8(["VP8"])).toBe(true);
      expect(hasVp8(["vp8", "H264"])).toBe(true);
      expect(hasVp8(["H264"])).toBe(false);
      expect(hasVp8([])).toBe(false);
    });
  });
});

// ─── Package surface (task 3.2): exports/scripts wiring ─────────────────

describe("package surface for the RTC demo client (task 3.2)", () => {
  it("keeps the ./stream-client export pointed at the RTC client entry", () => {
    const pkg = JSON.parse(require("node:fs").readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.exports["./stream-client"]).toBe("./src/stream/client/index.ts");
    // Demo bundle regenerates from the same entry (old build:stream-demo wiring).
    expect(pkg.scripts["build:stream-demo"]).toBe(
      "bun build src/stream/client/index.ts --outfile examples/stream-client.js --target browser",
    );
    // The legacy in-guest-encoder fixture recorder stays gone; the
    // screenshot fixture recorder (record-fixtures) is unrelated and stays.
    expect(pkg.scripts["record-stream-fixture"]).toBeUndefined();
  });
});
