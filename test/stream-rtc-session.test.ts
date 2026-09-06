import { describe, expect, it } from "bun:test";
import { GrpcControlError } from "../src/device/grpc";
import { RtcSession, RtcSessionError } from "../src/stream/rtc/session";
import type { RtcAdapter } from "../src/stream/rtc/adapter";
import type { JsepPayload, RtcServerMessage, StreamViewer } from "../src/stream/types";

/**
 * RtcSession — per-viewer RtcId lifecycle + the probe-b2 answer-before-
 * candidates flush + the getStatus watchdog (tasks 2.2/2.3). Runs against an
 * in-memory RtcAdapter double: the adapter contract is all the session cares
 * about; the REAL adapter is conformance-pinned in stream-rtc-adapter.test.ts
 * and the whole stack end-to-end in stream-rtc-integration.test.ts.
 */

/** Deferred payload queue that mirrors the emulator's blocking JSEP stream. */
class FakeAdapter implements RtcAdapter {
  started = 0;
  sends: Array<{ guid: string; payload: string }> = [];
  cancelled: string[] = [];
  stopped = 0;
  failStart: Error | undefined;
  private queues = new Map<string, JsepPayload[]>();
  private waiters = new Map<string, Array<(p: JsepPayload | null) => void>>();
  private ended = new Set<string>();

  async start(): Promise<string> {
    if (this.failStart) throw this.failStart;
    this.started += 1;
    const guid = `guid-${this.started}`;
    this.queues.set(guid, []);
    return guid;
  }

  async sendJsep(guid: string, payload: string): Promise<void> {
    this.sends.push({ guid, payload });
  }

  receive(guid: string): AsyncIterable<JsepPayload> {
    const self = this;
    const iterate = async function* () {
      for (;;) {
        const queue = self.queues.get(guid) ?? [];
        const next = queue.shift();
        self.queues.set(guid, queue);
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (self.ended.has(guid)) return;
        const resume = await new Promise<JsepPayload | null>((resolve) => {
          (self.waiters.get(guid) ?? self.waiters.set(guid, []).get(guid)!).push(resolve);
        });
        if (resume === null) return;
      }
    };
    return { [Symbol.asyncIterator]: () => iterate() };
  }

  /** Emulator side: push a JSEP payload into the stream for guid. */
  push(guid: string, payload: JsepPayload): void {
    const queue = this.queues.get(guid) ?? [];
    queue.push(payload);
    this.queues.set(guid, queue);
    const waiting = this.waiters.get(guid) ?? [];
    const next = waiting.shift();
    if (next) next(payload);
  }

  cancelReceive(guid: string): void {
    this.cancelled.push(guid);
    this.ended.add(guid);
    for (const w of this.waiters.get(guid) ?? []) w(null);
    this.waiters.set(guid, []);
  }

  stop(): void {
    this.stopped += 1;
  }

  sendsFor(guid: string): unknown[] {
    return this.sends.filter((s) => s.guid === guid).map((s) => JSON.parse(s.payload));
  }
}

class RecordingViewer implements StreamViewer {
  readonly id: string;
  messages: RtcServerMessage[] = [];
  open = true;
  closedAt = -1;
  private closeCounter = 0;

  constructor(id: string) {
    this.id = id;
  }
  async sendMessage(msg: RtcServerMessage): Promise<void> {
    this.messages.push(msg);
  }
  get closeCount(): number {
    return this.closeCounter;
  }
  close(): void {
    this.open = false;
    this.closeCounter += 1;
    this.closedAt = this.messages.length;
  }
}

function makeSession(opts: {
  fps?: number;
  codecs?: string[];
  probe?: () => Promise<void>;
  watchdogMs?: number;
} = {}): { session: RtcSession; adapter: FakeAdapter; losses: string[] } {
  const adapter = new FakeAdapter();
  const losses: string[] = [];
  const session = new RtcSession({
    serial: "emulator-5554",
    adapter,
    fps: opts.fps ?? 60,
    ...(opts.codecs !== undefined ? { codecs: opts.codecs } : {}),
    ...(opts.probe !== undefined ? { probe: opts.probe } : {}),
    ...(opts.watchdogMs !== undefined ? { watchdogMs: opts.watchdogMs } : {}),
    onLoss: () => losses.push("loss"),
  });
  return { session, adapter, losses };
}

const flush = async (turns = 4): Promise<void> => {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("RtcSession — per-viewer RtcId lifecycle (task 2.2, design D2)", () => {
  it("first viewer attach: requestRtcStream → handshake FIRST (no offer precedes it)", async () => {
    const { session, adapter } = makeSession({ fps: 60 });
    const v = new RecordingViewer("v1");
    await session.attach(v);
    expect(adapter.started).toBe(1);
    expect(v.messages[0]).toEqual({ type: "handshake", rtcId: "guid-1", fps: 60, codecs: ["VP8"] });
  });

  it("relays the emulator's start/offer verbatim AFTER the handshake", async () => {
    const { session, adapter } = makeSession();
    const v = new RecordingViewer("v1");
    await session.attach(v);
    adapter.push("guid-1", { start: {} });
    adapter.push("guid-1", { type: "offer", sdp: "v=0 emulator offer" });
    await flush();
    const kinds = v.messages.map((m) => m.type);
    expect(kinds).toEqual(["handshake", "offer"]);
    expect(v.messages[1]).toEqual({ type: "offer", sdp: "v=0 emulator offer" });
  });

  it("each viewer gets its OWN guid + handshake (per-viewer RtcId, fanout at session level)", async () => {
    const { session, adapter } = makeSession();
    const a = new RecordingViewer("a");
    const b = new RecordingViewer("b");
    await session.attach(a);
    await session.attach(b);
    expect(adapter.started).toBe(2);
    const aHand = a.messages[0] as { type: string; rtcId: string };
    const bHand = b.messages[0] as { type: string; rtcId: string };
    expect(aHand.rtcId).toBe("guid-1");
    expect(bHand.rtcId).toBe("guid-2");
    // The emulator's offer for ONE viewer is not leaked to the other.
    adapter.push("guid-1", { type: "offer", sdp: "offer-for-a" });
    await flush();
    expect((b.messages.find((m) => m.type === "offer") as { sdp?: string } | undefined)?.sdp).toBeUndefined();
    expect(a.messages.some((m) => m.type === "offer" && (m as { sdp: string }).sdp === "offer-for-a")).toBe(true);
  });

  it("detach sends bye:true and cancels that viewer's receive stream only", async () => {
    const { session, adapter } = makeSession();
    const a = new RecordingViewer("a");
    const b = new RecordingViewer("b");
    await session.attach(a);
    await session.attach(b);
    session.detach("a");
    await flush();
    expect(adapter.sendsFor("guid-1")).toEqual([{ bye: true }]);
    expect(adapter.cancelled).toEqual(["guid-1"]);
    expect(adapter.sendsFor("guid-2")).toEqual([]); // survivor untouched
    // A late emulator message for the detached stream is not relayed.
    adapter.push("guid-1", { type: "offer", sdp: "late" });
    await flush();
    expect(a.messages.some((m) => m.type === "offer")).toBe(false);
  });

  it("last viewer detach (close) tears the whole session down: bye for every stream", async () => {
    const { session, adapter } = makeSession();
    const a = new RecordingViewer("a");
    const b = new RecordingViewer("b");
    await session.attach(a);
    await session.attach(b);
    session.detach("a");
    await flush();
    session.close();
    await flush();
    expect(adapter.sendsFor("guid-2")).toEqual([{ bye: true }]);
    expect(adapter.cancelled).toContain("guid-2");
    expect(adapter.stopped).toBe(1);
    expect(session.active).toBe(false);
    expect(session.viewers).toBe(0);
  });

  it("emulator bye ends that viewer's stream: viewer closed, no bye echoed back", async () => {
    const { session, adapter } = makeSession();
    const v = new RecordingViewer("v1");
    await session.attach(v);
    adapter.push("guid-1", { bye: true });
    await flush();
    expect(v.closeCount).toBe(1);
    expect(adapter.sendsFor("guid-1")).toEqual([]); // no bye echo
    expect(session.viewers).toBe(0);
  });

  it("exposes the first active guid + viewer count for the state surface", async () => {
    const { session } = makeSession();
    expect(session.guid).toBeUndefined();
    const a = new RecordingViewer("a");
    const b = new RecordingViewer("b");
    await session.attach(a);
    await session.attach(b);
    expect(session.guid).toBe("guid-1");
    expect(session.viewers).toBe(2);
    session.close();
  });
});

describe("RtcSession — answer-before-candidates flush (task 2.2, probe-b2)", () => {
  it("buffers client ICE that arrives before the answer, flushes AFTER it (emulator drops early candidates)", async () => {
    const { session, adapter } = makeSession();
    const v = new RecordingViewer("v1");
    await session.attach(v);
    // Client trickles candidates BEFORE answering (RTCPeerConnection does).
    await session.relayIce("v1", { candidate: "candidate:1", sdpMid: "0" });
    await session.relayIce("v1", { candidate: "candidate:2", sdpMid: "0" });
    await flush();
    expect(adapter.sendsFor("guid-1")).toEqual([]); // buffered — emulator would drop them
    await session.relayAnswer("v1", "v=0 client answer");
    await flush();
    expect(adapter.sendsFor("guid-1")).toEqual([
      { type: "answer", sdp: "v=0 client answer" },
      { candidate: "candidate:1", sdpMid: "0" },
      { candidate: "candidate:2", sdpMid: "0" },
    ]);
    // Candidates AFTER the answer pass straight through.
    await session.relayIce("v1", { candidate: "candidate:3", sdpMid: "0" });
    await flush();
    expect(adapter.sendsFor("guid-1")).toHaveLength(4);
  });

  it("relays answer/ice as the verbatim gRPC dictionaries", async () => {
    const { session, adapter } = makeSession();
    const v = new RecordingViewer("v1");
    await session.attach(v);
    await session.relayAnswer("v1", "v=0 answer");
    await session.relayIce("v1", { candidate: "candidate:9", sdpMid: "audio", sdpMLineIndex: 1 });
    await flush();
    expect(adapter.sendsFor("guid-1")).toEqual([
      { type: "answer", sdp: "v=0 answer" },
      { candidate: "candidate:9", sdpMid: "audio", sdpMLineIndex: 1 },
    ]);
  });

  it("buffering is PER VIEWER (one viewer's early candidates never leak into another's stream)", async () => {
    const { session, adapter } = makeSession();
    const a = new RecordingViewer("a");
    const b = new RecordingViewer("b");
    await session.attach(a);
    await session.attach(b);
    await session.relayIce("a", { candidate: "candidate:a", sdpMid: "0" });
    await session.relayAnswer("b", "v=0 b answer");
    await flush();
    expect(adapter.sendsFor("guid-1")).toEqual([]); // a still unanswered → buffered
    expect(adapter.sendsFor("guid-2")).toEqual([{ type: "answer", sdp: "v=0 b answer" }]);
    await session.relayAnswer("a", "v=0 a answer");
    await flush();
    expect(adapter.sendsFor("guid-1")).toEqual([
      { type: "answer", sdp: "v=0 a answer" },
      { candidate: "candidate:a", sdpMid: "0" },
    ]);
  });

  it("client state:streaming echoes the state frame to that viewer", async () => {
    const { session } = makeSession();
    const v = new RecordingViewer("v1");
    await session.attach(v);
    session.noteStreaming("v1");
    await flush();
    expect(v.messages).toContainEqual({ type: "state", state: "streaming" });
  });

  it("frames for unknown viewers are ignored (no crash, no ghost sends)", async () => {
    const { session, adapter } = makeSession();
    await session.relayAnswer("ghost", "v=0");
    await session.relayIce("ghost", { candidate: "c" });
    session.noteStreaming("ghost");
    session.detach("ghost");
    await flush();
    expect(adapter.sends).toEqual([]);
  });
});

describe("RtcSession — start failures map onto spec close codes (Error States)", () => {
  it("maps PERMISSION_DENIED at requestRtcStream onto RtcSessionError(4401)", async () => {
    const { session, adapter } = makeSession();
    adapter.failStart = new GrpcControlError("PERMISSION_DENIED", "RtcService is not on the allowlist", undefined, 4401);
    try {
      await session.attach(new RecordingViewer("v1"));
      throw new Error("expected PERMISSION_DENIED");
    } catch (e) {
      expect(e).toBeInstanceOf(RtcSessionError);
      expect((e as RtcSessionError).code).toBe("PERMISSION_DENIED");
      expect((e as RtcSessionError).wsCloseCode).toBe(4401);
    }
  });

  it("maps DEVICE_OFFLINE at requestRtcStream onto NO_DEVICE(4404) (RtcStream cannot start)", async () => {
    const { session, adapter } = makeSession();
    adapter.failStart = new GrpcControlError("DEVICE_OFFLINE", "emulator gRPC unreachable");
    try {
      await session.attach(new RecordingViewer("v1"));
      throw new Error("expected NO_DEVICE");
    } catch (e) {
      expect(e).toBeInstanceOf(RtcSessionError);
      expect((e as RtcSessionError).code).toBe("NO_DEVICE");
      expect((e as RtcSessionError).wsCloseCode).toBe(4404);
    }
  });
});

describe("RtcSession — getStatus watchdog (task 2.3: loss → teardown + reason)", () => {
  it("fires onLoss once when the getStatus probe fails, and tears the session down", async () => {
    let alive = true;
    const { session, adapter, losses } = makeSession({
      probe: async () => {
        if (!alive) throw new GrpcControlError("DEVICE_OFFLINE", "emulator gone");
      },
      watchdogMs: 10,
    });
    const v = new RecordingViewer("v1");
    await session.attach(v);
    expect(session.active).toBe(true);
    alive = false;
    await session.poke();
    await flush();
    expect(losses).toEqual(["loss"]);
    expect(session.active).toBe(false);
    expect(adapter.sendsFor("guid-1")).toEqual([{ bye: true }]);
    expect(adapter.cancelled).toContain("guid-1");
    // Socket closure on loss is the GATEWAY's job (single ownership): the
    // session only tears down the per-guid JSEP streams.
    expect(v.closeCount).toBe(0);
  });

  it("does NOT probe while no viewer is attached (watchdog armed on first attach only)", async () => {
    let probes = 0;
    const { session } = makeSession({
      probe: async () => void probes++,
      watchdogMs: 10,
    });
    await session.poke();
    await flush(5);
    await new Promise((r) => setTimeout(r, 30));
    expect(probes).toBe(0);
  });

  it("disarms after the last viewer leaves (detach stops the probing)", async () => {
    let probes = 0;
    const { session } = makeSession({
      probe: async () => void probes++,
      watchdogMs: 10,
    });
    const v = new RecordingViewer("v1");
    await session.attach(v);
    await flush(5);
    await new Promise((r) => setTimeout(r, 30));
    const armedProbes = probes;
    expect(armedProbes).toBeGreaterThan(0);
    session.detach("v1");
    await flush();
    probes = 0;
    await new Promise((r) => setTimeout(r, 40));
    expect(probes).toBe(0);
  });

  it("a healthy getStatus probe keeps the session running (loss only on failure)", async () => {
    let probes = 0;
    const { session, adapter } = makeSession({
      probe: async () => void probes++,
      watchdogMs: 10,
    });
    const v = new RecordingViewer("v1");
    await session.attach(v);
    await flush(5);
    await new Promise((r) => setTimeout(r, 40));
    expect(probes).toBeGreaterThan(0);
    expect(adapter.cancelled).toEqual([]);
    expect(session.active).toBe(true);
    session.close();
  });
});
