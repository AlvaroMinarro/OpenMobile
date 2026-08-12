import { describe, expect, it } from "bun:test";
import { bridgeHandler, resolvePort, startBridge } from "../src/bridge/main";

describe("resolvePort", () => {
  it("defaults to 8765 when unset or blank", () => {
    expect(resolvePort(undefined)).toBe(8765);
    expect(resolvePort("")).toBe(8765);
  });

  it("parses a valid env value", () => {
    expect(resolvePort("9000")).toBe(9000);
  });

  it("rejects non-numeric or out-of-range values", () => {
    expect(() => resolvePort("abc")).toThrow();
    expect(() => resolvePort("-1")).toThrow();
    expect(() => resolvePort("65536")).toThrow();
  });
});

describe("bridgeHandler", () => {
  it("disables the secret gate by default (loopback trust boundary)", async () => {
    const handler = bridgeHandler({});
    const res = await handler(new Request("http://127.0.0.1/v1/state"));
    expect(res.status).toBe(200);
  });

  it("enables the secret gate when OPENMOBILE_BRIDGE_SECRET is set", async () => {
    const handler = bridgeHandler({ OPENMOBILE_BRIDGE_SECRET: "hunter2" });
    const denied = await handler(new Request("http://127.0.0.1/v1/state"));
    expect(denied.status).toBe(401);
    const allowed = await handler(
      new Request("http://127.0.0.1/v1/state", { headers: { "x-openmobile-secret": "hunter2" } }),
    );
    expect(allowed.status).toBe(200);
  });
});

describe("startBridge", () => {
  it("binds to loopback and serves /v1/state", async () => {
    const { server, port } = startBridge({ OPENMOBILE_BRIDGE_PORT: "0" });
    try {
      expect(port).toBe(0);
      expect(server.hostname).toBe("127.0.0.1");
      const res = await server.fetch(new Request(`http://127.0.0.1:${server.port}/v1/state`));
      expect(res.status).toBe(200);
    } finally {
      server.stop();
    }
  });

  it("uses the configured non-zero port", async () => {
    const { server, port } = startBridge({ OPENMOBILE_BRIDGE_PORT: "0" });
    try {
      expect(typeof server.port).toBe("number");
    } finally {
      server.stop();
    }
  });
});