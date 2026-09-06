import { describe, expect, it, afterAll } from "bun:test";
import { createBridgeApp, type BridgeDeps } from "../src/bridge/server";
import { StreamGateway, type RtcCapability } from "../src/stream/gateway";
import { RtcSession } from "../src/stream/rtc/session";
import type { AVD, Device } from "../src/device/types";
import { WS_CLOSE_CODES, type RtcServerMessage } from "../src/stream/types";
import { FakeRtcAdapter } from "./helpers/fake-rtc-adapter";

/**
 * WS /v1/stream/video — the JSON JSEP signaling contract (task 2.7) over the
 * REAL gateway + REAL RtcSession + FakeRtcAdapter + in-process Bun.serve +
 * a REAL Bun WebSocket client. No gRPC, no emulator: the adapter double
 * plays the emulator side (the gRPC transport itself is conformance-pinned
 * in stream-rtc-adapter.test.ts and re-joined end-to-end in
 * stream-rtc-integration.test.ts).
 */

interface Stack {
  adapter: FakeRtcAdapter;
  http: (path: string) => Promise<Response>;
  connect: () => Promise<WebSocket>;
  stop: () => void;
}

function makeStack(opts: { fps?: number; capability?: RtcCapability; failStart?: Error } = {}): Stack {
  const adapter = new FakeRtcAdapter();
  if (opts.failStart) adapter.failStart = opts.failStart;
  const capability: RtcCapability =
    opts.capability ?? { supported: true, endpoint: { addr: "localhost:8554", token: "tok" } };
  const gateway = new StreamGateway({
    serial: "emulator-5554",
    enabled: true,
    fps: opts.fps ?? 60,
    resolveCapability: () => capability,
    createSession: (_endpoint, serial) =>
      new RtcSession({ serial, adapter, fps: opts.fps ?? 60 }),
    controlFor: async () => null,
    pollDevices: async () => [{ serial: "emulator-5554", state: "device" }] as Device[],
  });
  const deps: BridgeDeps = {
    bridge: { version: "test", pid: 1234 },
    adb: {
      devices: async () => [{ serial: "emulator-5554", state: "device" }] as Device[],
      inputTap: async () => {},
      inputSwipe: async () => {},
      inputText: async () => {},
    },
    cli: { emulatorList: async () => [] as AVD[], capture: async () => {} },
    env: {},
    readFile: async () => new Uint8Array(),
    tempPngPath: () => "/tmp/om-signaling-test.png",
    streamGateway: gateway,
  };
  const app = createBridgeApp(deps);
  const server = Bun.serve<Record<string, unknown>>({
    port: 0,
    fetch: app.fetch,
    websocket: app.websocket,
  });
  return {
    adapter,
    http: async (path: string) => server.fetch(new Request(`http://127.0.0.1:${server.port}${path}`)),
    connect: () => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/stream/video`);
      return new Promise((resolve, reject) => {
        ws.addEventListener("open", () => resolve(ws));
        ws.addEventListener("error", () => reject(new Error("ws open failed")));
      });
    },
    stop: () => server.stop(),
  };
}

function nextMessage(ws: WebSocket, pred?: (data: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("nextMessage timed out")), 4000);
    const onMsg = (ev: MessageEvent) => {
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      if (pred && !pred(data)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      resolve(data);
    };
    ws.addEventListener("message", onMsg);
  });
}

function nextClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.addEventListener("close", (ev) => resolve(ev.code), { once: true });
  });
}

const parse = (raw: string): RtcServerMessage => JSON.parse(raw) as RtcServerMessage;

const stacks: Stack[] = [];
afterAll(() => {
  for (const s of stacks) s.stop();
});

async function withStack(
  opts: Parameters<typeof makeStack>[0],
  run: (stack: Stack) => Promise<void>,
): Promise<void> {
  const stack = makeStack(opts);
  stacks.push(stack);
  try {
    await run(stack);
  } finally {
    // Best-effort teardown of any sockets the test opened.
  }
}

describe("WS /v1/stream/video — handshake first (Handshake first scenario)", () => {
  it("sends the handshake as the FIRST frame with rtcId/fps/VP8 codecs", async () => {
    await withStack({}, async (stack) => {
      const ws = await stack.connect();
      const first = parse(await nextMessage(ws));
      expect(first.type).toBe("handshake");
      if (first.type !== "handshake") return;
      expect(first.rtcId).toBe("guid-1");
      expect(first.fps).toBe(60);
      expect(first.codecs).toEqual(["VP8"]);
      ws.close();
    });
  });

  it("reports the configured fps (60) in the handshake (FPS reported scenario)", async () => {
    await withStack({ fps: 60 }, async (stack) => {
      const ws = await stack.connect();
      const first = parse(await nextMessage(ws));
      if (first.type !== "handshake") throw new Error("expected handshake");
      expect(first.fps).toBe(60);
      ws.close();
    });
  });
});

describe("WS /v1/stream/video — verbatim JSEP relay (Opaque JSEP Relay)", () => {
  it("relays the emulator's offer verbatim AFTER the handshake", async () => {
    await withStack({}, async (stack) => {
      const ws = await stack.connect();
      const hand = parse(await nextMessage(ws));
      if (hand.type !== "handshake") throw new Error("expected handshake");
      stack.adapter.push(hand.rtcId, { type: "offer", sdp: "v=0 emulator offer" });
      const offer = parse(await nextMessage(ws));
      expect(offer).toEqual({ type: "offer", sdp: "v=0 emulator offer" });
      ws.close();
    });
  });

  it("buffers client ice sent BEFORE the answer and flushes after it (probe-b2)", async () => {
    await withStack({}, async (stack) => {
      const ws = await stack.connect();
      const hand = parse(await nextMessage(ws));
      if (hand.type !== "handshake") throw new Error("expected handshake");
      const guid = hand.rtcId;
      // Client trickles an ICE candidate, THEN answers.
      ws.send(JSON.stringify({ type: "ice", candidate: { candidate: "candidate:1", sdpMid: "0" } }));
      await new Promise((r) => setTimeout(r, 50));
      expect(stack.adapter.sendsFor(guid)).toEqual([]); // buffered — emulator would drop it
      ws.send(JSON.stringify({ type: "answer", sdp: "v=0 client answer" }));
      await new Promise((r) => setTimeout(r, 50));
      expect(stack.adapter.sendsFor(guid)).toEqual([
        { type: "answer", sdp: "v=0 client answer" },
        { candidate: "candidate:1", sdpMid: "0" },
      ]);
      // ICE after the answer passes straight through.
      ws.send(JSON.stringify({ type: "ice", candidate: { candidate: "candidate:2", sdpMid: "0" } }));
      await new Promise((r) => setTimeout(r, 50));
      expect(stack.adapter.sendsFor(guid)).toHaveLength(3);
      ws.close();
    });
  });

  it("relays the emulator's ICE candidates as ice frames", async () => {
    await withStack({}, async (stack) => {
      const ws = await stack.connect();
      const hand = parse(await nextMessage(ws));
      if (hand.type !== "handshake") throw new Error("expected handshake");
      stack.adapter.push(hand.rtcId, {
        candidate: "candidate:1 1 UDP 1 127.0.0.1 1111 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
      const ice = parse(await nextMessage(ws));
      expect(ice).toEqual({
        type: "ice",
        candidate: { candidate: "candidate:1 1 UDP 1 127.0.0.1 1111 typ host", sdpMid: "0", sdpMLineIndex: 0 },
      });
      ws.close();
    });
  });

  it("echoes state:streaming back when the client reports its peer connected", async () => {
    await withStack({}, async (stack) => {
      const ws = await stack.connect();
      await nextMessage(ws); // handshake
      ws.send(JSON.stringify({ type: "state", state: "streaming" }));
      const echoed = parse(await nextMessage(ws));
      expect(echoed).toEqual({ type: "state", state: "streaming" });
      ws.close();
    });
  });

  it("closes the viewer socket with 4409 when the emulator hangs up (bye)", async () => {
    await withStack({}, async (stack) => {
      const ws = await stack.connect();
      const hand = parse(await nextMessage(ws));
      if (hand.type !== "handshake") throw new Error("expected handshake");
      const code = nextClose(ws);
      stack.adapter.push(hand.rtcId, { bye: true });
      expect(await code).toBe(WS_CLOSE_CODES.DEVICE_LOST);
    });
  });
});

describe("WS /v1/stream/video — malformed signaling (Malformed signaling scenario)", () => {
  it("non-JSON frame → JSON error body + close 4400, never a silent hang", async () => {
    await withStack({}, async (stack) => {
      const ws = await stack.connect();
      await nextMessage(ws); // handshake
      const code = nextClose(ws);
      ws.send("this is not json");
      const err = parse(await nextMessage(ws)) as unknown as { error: { code: string; message: string } };
      expect(err.error.code).toBe("BAD_MESSAGE");
      expect(await code).toBe(WS_CLOSE_CODES.BAD_MESSAGE);
    });
  });

  it("unknown type frame → JSON error body naming the type + close", async () => {
    await withStack({}, async (stack) => {
      const ws = await stack.connect();
      await nextMessage(ws); // handshake
      const code = nextClose(ws);
      ws.send(JSON.stringify({ type: "offer", sdp: "clients cannot offer" }));
      const err = (await nextMessage(ws)) as string;
      expect(JSON.parse(err).error.code).toBe("BAD_MESSAGE");
      expect(JSON.parse(err).error.message).toContain("offer");
      expect(await code).toBe(WS_CLOSE_CODES.BAD_MESSAGE);
    });
  });
});

describe("WS /v1/stream/video — degraded capability + start failures (Error States)", () => {
  it("externally launched emulator (unsupported capability) → close 4403 + permission reason", async () => {
    await withStack(
      { capability: { supported: false, reason: "grpc_permission_denied" } },
      async (stack) => {
        const ws = await stack.connect();
        const code = nextClose(ws);
        const body = await nextMessage(ws);
        expect(JSON.parse(body).error.message).toBe("grpc_permission_denied");
        expect(await code).toBe(WS_CLOSE_CODES.UNSUPPORTED);
      },
    );
  });

  it("PERMISSION_DENIED at requestRtcStream → close 4401 naming PERMISSION_DENIED", async () => {
    await withStack(
      { failStart: Object.assign(new Error("RtcService is not on the allowlist"), { code: "PERMISSION_DENIED" }) },
      async (stack) => {
        const ws = await stack.connect();
        const code = nextClose(ws);
        const body = await nextMessage(ws);
        expect(JSON.parse(body).error.code).toBe("PERMISSION_DENIED");
        expect(await code).toBe(WS_CLOSE_CODES.PERMISSION_DENIED);
      },
    );
  });

  it("a start that cannot begin (device offline) → close 4404", async () => {
    await withStack(
      { failStart: Object.assign(new Error("emulator gRPC unreachable"), { code: "DEVICE_OFFLINE" }) },
      async (stack) => {
        const ws = await stack.connect();
        const code = nextClose(ws);
        await nextMessage(ws); // error body
        expect(await code).toBe(WS_CLOSE_CODES.NO_DEVICE);
      },
    );
  });
});

describe("WS /v1/stream/video — additive /v1/state stream.rtc", () => {
  it("reports supported/active/viewers/guid/fps while a viewer is attached", async () => {
    await withStack({}, async (stack) => {
      const ws = await stack.connect();
      const hand = parse(await nextMessage(ws));
      if (hand.type !== "handshake") throw new Error("expected handshake");
      const res = await stack.http("/v1/state");
      const body = (await res.json()) as {
        stream?: { supported: boolean; active: boolean; viewers: number; rtc?: Record<string, unknown> };
      };
      expect(body.stream?.supported).toBe(true);
      expect(body.stream?.active).toBe(true);
      expect(body.stream?.viewers).toBe(1);
      expect(body.stream?.rtc).toMatchObject({ supported: true, active: true, viewers: 1, guid: hand.rtcId, fps: 60 });
      ws.close();
      await new Promise((r) => setTimeout(r, 100));
      const after = (await (await stack.http("/v1/state")).json()) as {
        stream?: { active: boolean; viewers: number };
      };
      expect(after.stream?.active).toBe(false); // last viewer gone → torn down
      expect(after.stream?.viewers).toBe(0);
    });
  });
});
