import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeHandler, createBridgeDeps, resolvePort, startBridge } from "../src/bridge/main";

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

/**
 * RTC wiring (task 2.8): createBridgeDeps builds the StreamGateway over the
 * REAL capability probe (pid ini + version gate in OPENMOBILE_AVD_RUN_DIR)
 * and the -rtcfps value from OPENMOBILE_RTC_FPS (30 default, 30|60 only).
 */
describe("createBridgeDeps — RTC gateway wiring (task 2.8)", () => {
  function runDirWith5554(): string {
    const dir = mkdtempSync(join(tmpdir(), "om-main-rtc-"));
    writeFileSync(
      join(dir, "pid_101.ini"),
      "port.serial=5554\ngrpc.token=TOK\ngrpc.port=8554\nemulator.version=36.5.11.0\n",
    );
    return dir;
  }

  it("wires a stream gateway that resolves the pid-ini capability (supported + endpoint)", () => {
    const dir = runDirWith5554();
    try {
      const deps = createBridgeDeps({
        ANDROID_DEVICE: "emulator-5554",
        OPENMOBILE_AVD_RUN_DIR: dir,
      });
      const snap = deps.streamGateway?.snapshot();
      expect(snap?.supported).toBe(true);
      expect(snap?.rtc?.fps).toBe(30); // default -rtcfps
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports grpc_permission_denied when no pid ini matches (external launch)", () => {
    const deps = createBridgeDeps({ ANDROID_DEVICE: "emulator-5554" });
    const snap = deps.streamGateway?.snapshot();
    expect(snap?.supported).toBe(false);
    expect(snap?.rtc?.reason).toBe("grpc_permission_denied");
  });

  it("honors OPENMOBILE_RTC_FPS=60 and ignores invalid values (default 30)", () => {
    const dir = runDirWith5554();
    try {
      const fast = createBridgeDeps({
        ANDROID_DEVICE: "emulator-5554",
        OPENMOBILE_AVD_RUN_DIR: dir,
        OPENMOBILE_RTC_FPS: "60",
      });
      expect(fast.streamGateway?.snapshot().rtc?.fps).toBe(60);
      const slow = createBridgeDeps({
        ANDROID_DEVICE: "emulator-5554",
        OPENMOBILE_AVD_RUN_DIR: dir,
        OPENMOBILE_RTC_FPS: "144",
      });
      expect(slow.streamGateway?.snapshot().rtc?.fps).toBe(30);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wires no stream gateway at all when OPENMOBILE_STREAM=off", () => {
    const deps = createBridgeDeps({ OPENMOBILE_STREAM: "off" });
    expect(deps.streamGateway).toBeUndefined();
  });
});