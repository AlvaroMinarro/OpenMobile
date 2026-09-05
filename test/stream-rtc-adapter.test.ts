import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { GrpcRtcClient } from "../src/device/grpc";
import { GrpcRtcAdapter } from "../src/stream/rtc/adapter";
import { FakeRtcServer } from "./helpers/fake-rtc-server";

/**
 * GrpcRtcAdapter — the RtcService v1 conformance pin (task 2.1, design D2).
 * probe B verbatim flow: start → receive (start/offer/candidates) →
 * sendJsep (answer/ice/bye), with sends SERIALIZED (parallel gRPC sends
 * reorder). Runs against the in-process FakeRtcServer — no emulator.
 */

const TOKEN = "adapter-token";
let server: FakeRtcServer;

beforeAll(async () => {
  server = new FakeRtcServer();
  await server.start();
});

afterAll(() => {
  server.stop();
});

function adapter(): GrpcRtcAdapter {
  return new GrpcRtcAdapter(new GrpcRtcClient(server.addr, TOKEN));
}

describe("GrpcRtcAdapter — start (requestRtcStream)", () => {
  it("returns a fresh per-stream guid and the token rides the call", async () => {
    const a = adapter();
    const guid = await a.start();
    expect(guid).toBe("guid-1");
    expect(await a.start()).toBe("guid-2"); // second viewer, own RtcId
    a.stop();
  });
});

describe("GrpcRtcAdapter — receive (server stream, verbatim relay)", () => {
  it("yields the decoded JSEP payload dictionaries in order", async () => {
    const a = adapter();
    const guid = await a.start();
    server.push(guid, '{"start":{}}');
    server.push(guid, '{"type":"offer","sdp":"v=0 offer"}');
    server.push(guid, '{"candidate":"candidate:1 1 UDP 1 127.0.0.1 1111 typ host","sdpMid":"0","sdpMLineIndex":0}');
    server.push(guid, '{"bye":true}');
    const payloads = [];
    for await (const p of a.receive(guid)) {
      payloads.push(p);
      if (payloads.length === 4) break;
    }
    expect(payloads).toEqual([
      { start: {} },
      { type: "offer", sdp: "v=0 offer" },
      { candidate: "candidate:1 1 UDP 1 127.0.0.1 1111 typ host", sdpMid: "0", sdpMLineIndex: 0 },
      { bye: true },
    ]);
    a.stop();
  });

  it("skips malformed payloads instead of crashing the relay", async () => {
    const a = adapter();
    const guid = await a.start();
    server.push(guid, "not json");
    server.push(guid, '{"type":"offer","sdp":"v=0"}');
    const payloads = [];
    for await (const p of a.receive(guid)) {
      payloads.push(p);
      if (payloads.length === 1) break;
    }
    expect(payloads).toEqual([{ type: "offer", sdp: "v=0" }]);
    a.stop();
  });

  it("cancelReceive ends the receive iteration (teardown path)", async () => {
    const a = adapter();
    const guid = await a.start();
    const iter = a.receive(guid)[Symbol.asyncIterator]();
    a.cancelReceive(guid);
    const first = await iter.next();
    expect(first.done).toBe(true);
    a.stop();
  });

  it("stop() cancels every open receive stream (last-viewer teardown)", async () => {
    const a = adapter();
    const g1 = await a.start();
    const g2 = await a.start();
    const it1 = a.receive(g1)[Symbol.asyncIterator]();
    const it2 = a.receive(g2)[Symbol.asyncIterator]();
    a.stop();
    expect((await it1.next()).done).toBe(true);
    expect((await it2.next()).done).toBe(true);
  });
});

describe("GrpcRtcAdapter — sendJsep is SERIALIZED (probe B ordering hazard)", () => {
  it("delivers concurrent sends to the server in issue order", async () => {
    const a = adapter();
    const guid = await a.start();
    // Fire three sends CONCURRENTLY — the adapter must serialize them so
    // the emulator sees answer → ice → ice, never a reordered mix.
    const answer = JSON.stringify({ type: "answer", sdp: "v=0 answer" });
    const ice1 = JSON.stringify({ candidate: "candidate:1", sdpMid: "0" });
    const ice2 = JSON.stringify({ candidate: "candidate:2", sdpMid: "0" });
    await Promise.all([a.sendJsep(guid, answer), a.sendJsep(guid, ice1), a.sendJsep(guid, ice2)]);
    const sent = server.sends.filter((s) => s.guid === guid).map((s) => s.message);
    expect(sent).toEqual([answer, ice1, ice2]);
    expect(server.sends.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
    a.stop();
  });
});
