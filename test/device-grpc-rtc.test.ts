import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { GrpcControlError, GrpcRtcClient } from "../src/device/grpc";
import { FakeRtcServer } from "./helpers/fake-rtc-server";

/**
 * GrpcRtcClient — the RtcService v1 transport stubs (task 2.6). Every test
 * runs against the in-process FakeRtcServer: no emulator, real gRPC wire.
 * The 5MB message proves the 64MB receive limit overrides grpc-js' 4MB
 * default (a fat SDP must never trip a receive-limit RST).
 */

const TOKEN = "test-token";

let server: FakeRtcServer;

beforeAll(async () => {
  server = new FakeRtcServer();
  await server.start();
});

afterAll(() => {
  server.stop();
});

function client(): GrpcRtcClient {
  return new GrpcRtcClient(server.addr, TOKEN);
}

describe("GrpcRtcClient — requestRtcStream (v1 conformance)", () => {
  it("returns the opaque guid the server issued and attaches the Bearer token", async () => {
    const c = client();
    const guid = await c.requestRtcStream();
    expect(guid).toBe("guid-1");
    // A second viewer gets its OWN guid (per-viewer RtcId, design D2).
    const second = await c.requestRtcStream();
    expect(second).toBe("guid-2");
    expect(second).not.toBe(guid);
    c.close();
  });

  it("maps PERMISSION_DENIED on requestRtcStream to a 4401-mapped error", async () => {
    server.requestRtcStreamFailure = { code: 7, message: "RtcService is not on the allowlist" }; // PERMISSION_DENIED
    const c = client();
    try {
      await c.requestRtcStream();
      throw new Error("expected PERMISSION_DENIED");
    } catch (e) {
      expect(e).toBeInstanceOf(GrpcControlError);
      expect((e as GrpcControlError).code).toBe("PERMISSION_DENIED");
      expect((e as GrpcControlError).wsCloseCode).toBe(4401);
    } finally {
      server.requestRtcStreamFailure = undefined;
      c.close();
    }
  });
});

describe("GrpcRtcClient — receiveJsepMessages (server stream)", () => {
  it("yields the queued wire messages {id:{guid}, message} in order", async () => {
    const c = client();
    const guid = await c.requestRtcStream();
    server.push(guid, '{"start":{}}');
    server.push(guid, '{"type":"offer","sdp":"v=0"}');
    const received: unknown[] = [];
    for await (const msg of c.receiveJsepMessages(guid)) {
      received.push(msg);
      if (received.length === 2) break;
    }
    expect(received).toEqual([
      { id: { guid }, message: '{"start":{}}' },
      { id: { guid }, message: '{"type":"offer","sdp":"v=0"}' },
    ]);
    c.close();
  });

  it("receives a >4MB message intact (64MB receive limit overrides the grpc-js default)", async () => {
    const c = client();
    const guid = await c.requestRtcStream();
    const fatSdp = "x".repeat(5 * 1024 * 1024);
    server.push(guid, JSON.stringify({ type: "offer", sdp: fatSdp }));
    for await (const msg of c.receiveJsepMessages(guid)) {
      const parsed = JSON.parse(msg.message) as { sdp: string };
      expect(parsed.sdp.length).toBe(5 * 1024 * 1024);
      break;
    }
    c.close();
  });

  it("cancelReceive ends the stream cleanly (no dangling iteration)", async () => {
    const c = client();
    const guid = await c.requestRtcStream();
    const iter = c.receiveJsepMessages(guid)[Symbol.asyncIterator]();
    c.cancelReceive(guid); // teardown while the stream is pended on the server
    const first = await iter.next();
    expect(first.done).toBe(true); // cancel ends the iteration — never a hang
    c.close();
  });
});

describe("GrpcRtcClient — sendJsepMessage (verbatim relay)", () => {
  it("delivers {id:{guid}, message} with the Bearer token attached", async () => {
    const c = client();
    const guid = await c.requestRtcStream();
    const payload = JSON.stringify({ type: "answer", sdp: "v=0 answer" });
    await c.sendJsepMessage(guid, payload);
    expect(server.sends).toEqual([{ guid, message: payload, auth: `Bearer ${TOKEN}` }]);
    c.close();
  });
});

describe("GrpcRtcClient — getStatus probe (watchdog, task 2.3)", () => {
  it("resolves while the emulator is alive", async () => {
    const c = client();
    await expect(c.probe()).resolves.toBeUndefined();
    c.close();
  });

  it("maps UNAVAILABLE on getStatus to DEVICE_OFFLINE (watchdog loss signal)", async () => {
    server.getStatusFailure = { code: 14, message: "transport closing" }; // UNAVAILABLE
    const c = client();
    try {
      await c.probe();
      throw new Error("expected DEVICE_OFFLINE");
    } catch (e) {
      expect(e).toBeInstanceOf(GrpcControlError);
      expect((e as GrpcControlError).code).toBe("DEVICE_OFFLINE");
    } finally {
      server.getStatusFailure = undefined;
      c.close();
    }
  });
});
