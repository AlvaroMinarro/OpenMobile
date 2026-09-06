import { describe, expect, it } from "bun:test";
import { StreamGateway, type RtcCapability } from "../src/stream/gateway";
import { RtcSession } from "../src/stream/rtc/session";
import { GrpcRtcAdapter } from "../src/stream/rtc/adapter";
import { GrpcRtcClient } from "../src/device/grpc";
import type { RtcServerMessage, StreamViewer } from "../src/stream/types";
import { FakeRtcServer } from "./helpers/fake-rtc-server";
import jsepFixture from "./fixtures/jsep-offer.json";

/**
 * RtcSession integration (task 2.9, probe-b2 replay): the REAL GrpcRtcClient
 * + GrpcRtcAdapter + RtcSession + StreamGateway stack against an in-process
 * fake gRPC server (Rtc + EmulatorController) that replays the recorded
 * probe-b2 JSEP fixture. No emulator. Covers: offer/answer/ICE round-trips,
 * the answer-before-candidates flush, the 8-viewer cap, teardown byes, and
 * the loss → active:false + 4409 chain. EVERY test gets its own server —
 * counters and failure injections must never leak across tests.
 */

const TOKEN = "integration-token";

class ViewerDouble implements StreamViewer {
  readonly id: string;
  messages: RtcServerMessage[] = [];
  open = true;
  closeCount = 0;
  constructor(id: string) {
    this.id = id;
  }
  async sendMessage(msg: RtcServerMessage): Promise<void> {
    this.messages.push(msg);
  }
  close(): void {
    this.open = false;
    this.closeCount += 1;
  }
}

interface Harness {
  server: FakeRtcServer;
  gateway: StreamGateway;
}

/** Fresh server + REAL gateway stack per test (isolation is the point). */
async function makeGateway(opts: { watchdogMs?: number } = {}): Promise<Harness> {
  const server = new FakeRtcServer();
  await server.start();
  const client = new GrpcRtcClient(server.addr, TOKEN);
  const adapter = new GrpcRtcAdapter(client);
  const capability: RtcCapability = {
    supported: true,
    endpoint: { addr: server.addr, token: TOKEN },
  };
  const gateway = new StreamGateway({
    serial: "emulator-5554",
    enabled: true,
    fps: 60,
    resolveCapability: () => capability,
    createSession: (endpoint, serial) =>
      new RtcSession({
        serial,
        adapter,
        fps: 60,
        probe: () => client.probe(),
        ...(opts.watchdogMs !== undefined ? { watchdogMs: opts.watchdogMs } : {}),
      }),
    controlFor: async () => null,
    // The manager's adb watchdog stays out of the way: the loss under test
    // here is the gRPC getStatus watchdog (task 2.3).
    pollDevices: async () => [{ serial: "emulator-5554", state: "device" }],
  });
  return { server, gateway };
}

const flush = async (turns = 8): Promise<void> => {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
};

const handshakeOf = (v: ViewerDouble): { rtcId: string } => {
  const hand = v.messages[0];
  if (!hand || hand.type !== "handshake") throw new Error("expected handshake first");
  return hand;
};

const replayOffer = (server: FakeRtcServer, guid: string): void => {
  for (const m of jsepFixture.messages) server.push(guid, m.message);
};

describe("integration — offer/answer/ICE round-trips over the REAL gRPC stack", () => {
  it("handshake first, then the replayed fixture offer, then verbatim answer + candidates", async () => {
    const { server, gateway } = await makeGateway();
    const v = new ViewerDouble("v1");
    const res = await gateway.subscribeVideo(v);
    expect(res.ok).toBe(true);
    const guid = handshakeOf(v).rtcId;
    expect(guid).toBe("guid-1");
    // The emulator (fake server) streams the recorded probe-b2 sequence.
    replayOffer(server, guid);
    await flush();
    expect(v.messages.map((m) => m.type)).toEqual(["handshake", "offer", "ice"]);
    expect(v.messages[1]).toEqual({ type: "offer", sdp: JSON.parse(jsepFixture.messages[1]!.message).sdp });
    expect(v.messages[2]).toEqual({
      type: "ice",
      candidate: JSON.parse(jsepFixture.messages[2]!.message),
    });
    // Client answers — the emulator receives THAT EXACT SDP string verbatim.
    const answerSdp = "v=0\r\no=- 9 9 IN IP4 127.0.0.1\r\ns=client\r\n";
    await gateway.relayViewerMessage("v1", { type: "answer", sdp: answerSdp });
    await flush();
    expect(server.sends[0]).toEqual({
      guid,
      message: JSON.stringify({ type: "answer", sdp: answerSdp }),
      auth: `Bearer ${TOKEN}`,
    });
    // ICE after the answer relays verbatim.
    await gateway.relayViewerMessage("v1", {
      type: "ice",
      candidate: { candidate: "candidate:2 2 UDP 2 127.0.0.1 2222 typ host", sdpMid: "0", sdpMLineIndex: 0 },
    });
    await flush();
    expect(server.sends[1]?.message).toBe(
      JSON.stringify({ candidate: "candidate:2 2 UDP 2 127.0.0.1 2222 typ host", sdpMid: "0", sdpMLineIndex: 0 }),
    );
    gateway.unsubscribeVideo("v1");
  });

  it("buffers candidates sent BEFORE the answer across the real transport (probe-b2 flush)", async () => {
    const { server, gateway } = await makeGateway();
    const v = new ViewerDouble("v1");
    await gateway.subscribeVideo(v);
    const guid = handshakeOf(v).rtcId;
    await gateway.relayViewerMessage("v1", { type: "ice", candidate: { candidate: "candidate:early", sdpMid: "0" } });
    await flush();
    expect(server.sends.filter((s) => s.guid === guid)).toEqual([]); // nothing reached the emulator
    await gateway.relayViewerMessage("v1", { type: "answer", sdp: "v=0 answer" });
    await flush();
    const sent = server.sends.filter((s) => s.guid === guid).map((s) => JSON.parse(s.message));
    expect(sent).toEqual([
      { type: "answer", sdp: "v=0 answer" },
      { candidate: "candidate:early", sdpMid: "0" },
    ]);
    gateway.unsubscribeVideo("v1");
  });

  it("a second viewer runs its own stream (own guid) whose offer does not leak across", async () => {
    const { server, gateway } = await makeGateway();
    const a = new ViewerDouble("a");
    const b = new ViewerDouble("b");
    await gateway.subscribeVideo(a);
    await gateway.subscribeVideo(b);
    const aGuid = handshakeOf(a).rtcId;
    const bGuid = handshakeOf(b).rtcId;
    expect(bGuid).not.toBe(aGuid);
    server.push(aGuid, jsepFixture.messages[1]!.message); // offer only for a
    await flush();
    expect(a.messages.some((m) => m.type === "offer")).toBe(true);
    expect(b.messages.some((m) => m.type === "offer")).toBe(false);
    gateway.unsubscribeVideo("a");
    gateway.unsubscribeVideo("b");
  });
});

describe("integration — viewer cap (8, ours) keeps existing streams running", () => {
  it("the 9th viewer is rejected; the 8 active streams keep relaying", async () => {
    const { server, gateway } = await makeGateway();
    const viewers: ViewerDouble[] = [];
    for (let i = 0; i < 8; i++) {
      const v = new ViewerDouble(`v${i}`);
      const res = await gateway.subscribeVideo(v);
      expect(res.ok).toBe(true);
      viewers.push(v);
    }
    expect(server.requestRtcStreamCalls).toBe(8); // one per viewer, not more
    const ninth = new ViewerDouble("ninth");
    const res = await gateway.subscribeVideo(ninth);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("CAP_REACHED");
    expect(server.requestRtcStreamCalls).toBe(8); // no stream for the rejected viewer
    expect(ninth.closeCount).toBe(0); // the bridge owns the 4429 close
    // Existing streams keep running: relay one more offer to viewer 0.
    replayOffer(server, handshakeOf(viewers[0]!).rtcId);
    await flush();
    expect(viewers[0]!.messages.some((m) => m.type === "offer")).toBe(true);
    for (const v of viewers) gateway.unsubscribeVideo(v.id);
  });
});

describe("integration — teardown (Last viewer scenario)", () => {
  it("unsubscribe sends bye:true per guid and cancels the receive streams", async () => {
    const { server, gateway } = await makeGateway();
    const a = new ViewerDouble("a");
    const b = new ViewerDouble("b");
    await gateway.subscribeVideo(a);
    await gateway.subscribeVideo(b);
    const aGuid = handshakeOf(a).rtcId;
    const bGuid = handshakeOf(b).rtcId;
    gateway.unsubscribeVideo("a");
    await flush();
    expect(server.sends.filter((s) => s.guid === aGuid).map((s) => s.message)).toEqual(["{\"bye\":true}"]);
    expect(gateway.snapshot().active).toBe(true); // b still streaming
    gateway.unsubscribeVideo("b");
    await flush();
    expect(server.sends.filter((s) => s.guid === bGuid).map((s) => s.message)).toEqual(["{\"bye\":true}"]);
    const snap = gateway.snapshot();
    expect(snap.active).toBe(false);
    expect(snap.viewers).toBe(0);
  });
});

describe("integration — getStatus watchdog loss (Emulator dies mid-stream scenario)", () => {
  it("viewers closed + active:false + reason device_lost (never a 500)", async () => {
    const { server, gateway } = await makeGateway({ watchdogMs: 5 });
    const a = new ViewerDouble("a");
    const b = new ViewerDouble("b");
    await gateway.subscribeVideo(a);
    await gateway.subscribeVideo(b);
    await flush();
    expect(gateway.snapshot().active).toBe(true);
    // The emulator dies mid-stream.
    server.getStatusFailure = { code: 14, message: "transport closing" };
    await new Promise((r) => setTimeout(r, 80));
    expect(a.closeCount).toBe(1);
    expect(b.closeCount).toBe(1);
    const snap = gateway.snapshot();
    expect(snap.active).toBe(false);
    expect(snap.reason).toBe("device_lost");
    expect(snap.rtc?.active).toBe(false);
    // The emulator got a bye for every open stream.
    expect(server.sends.filter((s) => s.message === "{\"bye\":true}")).toHaveLength(2);
  });

  it("a healthy getStatus probe keeps the stream alive across polls", async () => {
    const { gateway } = await makeGateway({ watchdogMs: 5 });
    const v = new ViewerDouble("v1");
    await gateway.subscribeVideo(v);
    await new Promise((r) => setTimeout(r, 60));
    expect(v.closeCount).toBe(0);
    expect(gateway.snapshot().active).toBe(true);
    expect(gateway.snapshot().rtc?.guid).toBe("guid-1");
    gateway.unsubscribeVideo("v1");
  });
});
