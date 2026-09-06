import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import {
  parseEmulatorVersion,
  isAtLeast,
  parsePidIni,
  findEmulatorConfig,
  GrpcEmulatorControl,
  GrpcControlError,
  type EmulatorControl,
} from "../src/device/grpc";
import { EMULATOR_CONTROLLER_PROTO, PROTOS_DIR, MIN_EMULATOR_VERSION } from "../src/device/grpc";

// ─── pure helpers: version gate + pid-ini token (design D4/D6) ───────────

describe("emulator version gate (design D6: >= 36.5.11, -rtcfps >= 36.6)", () => {
  it("parses the real `emulator -version` header line", () => {
    expect(parseEmulatorVersion("Android emulator version 36.5.11.0 (build 15261927)")).toEqual({
      major: 36,
      minor: 5,
      patch: 11,
    });
  });

  it("parses a 36.6 build (the -rtcfps boundary)", () => {
    expect(parseEmulatorVersion("Android emulator version 36.6.11.0 (build 1234)")?.patch).toBe(11);
  });

  it("returns null for unrecognized output (actionable gate, never a silent pass)", () => {
    expect(parseEmulatorVersion("emulator: ERROR: missing AVD")).toBeNull();
    expect(parseEmulatorVersion("")).toBeNull();
  });

  it("gates at the pinned minimum 36.5.11", () => {
    expect(isAtLeast({ major: 36, minor: 5, patch: 11 }, MIN_EMULATOR_VERSION)).toBe(true);
    expect(isAtLeast({ major: 36, minor: 6, patch: 0 }, MIN_EMULATOR_VERSION)).toBe(true);
    expect(isAtLeast({ major: 36, minor: 5, patch: 10 }, MIN_EMULATOR_VERSION)).toBe(false);
    expect(isAtLeast({ major: 35, minor: 9, patch: 9 }, MIN_EMULATOR_VERSION)).toBe(false);
  });

  it("gates -rtcfps at 36.6 (unknown option on 36.5.11 — live-verified)", () => {
    expect(isAtLeast({ major: 36, minor: 6, patch: 0 }, { major: 36, minor: 6, patch: 0 })).toBe(true);
    expect(isAtLeast({ major: 36, minor: 5, patch: 11 }, { major: 36, minor: 6, patch: 0 })).toBe(false);
  });
});

describe("pid-ini token lookup (per-instance grpc.token, design D6)", () => {
  function runDirWith(entries: Array<[string, string]>): string {
    const dir = mkdtempSync(join(tmpdir(), "om-avd-run-"));
    for (const [name, body] of entries) writeFileSync(join(dir, name), body);
    return dir;
  }

  it("parses the REAL recorded pid ini (grpc.token/grpc.port/port.serial keys)", () => {
    const ini = [
      "avd.id=Pixel_9_Pro",
      "port.serial=5554",
      "emulator.version=36.5.11.0",
      "grpc.token=dGVzdC10b2tlbg==",
      "grpc.port=8554",
    ].join("\n");
    const parsed = parsePidIni(ini);
    expect(parsed["port.serial"]).toBe("5554");
    expect(parsed["grpc.token"]).toBe("dGVzdC10b2tlbg==");
    expect(parsed["grpc.port"]).toBe("8554");
  });

  it("finds the config for emulator-5554 among several running pid ini files", () => {
    const dir = runDirWith([
      ["pid_100.ini", "port.serial=5556\ngrpc.token=OTHER\ngrpc.port=8556\n"],
      ["pid_101.ini", "port.serial=5554\ngrpc.token=TOKEN-A\ngrpc.port=8554\n"],
    ]);
    try {
      // emulatorVersion is additive (PR2 capability gate); inis without the
      // field resolve without it.
      expect(findEmulatorConfig(dir, "emulator-5554")).toEqual({ token: "TOKEN-A", port: 8554 });
      expect(findEmulatorConfig(dir, "emulator-5556")).toEqual({ token: "OTHER", port: 8556 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no ini matches the serial (externally launched / no token)", () => {
    const dir = runDirWith([["pid_101.ini", "port.serial=5554\ngrpc.token=T\n"]]);
    try {
      expect(findEmulatorConfig(dir, "emulator-5556")).toBeNull();
      expect(findEmulatorConfig(dir, "ZX1C2A")).toBeNull(); // physical device
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── in-process fake EmulatorController (no emulator needed) ─────────────

interface RecordedCall {
  method: string;
  request: unknown;
  auth: string | undefined;
}

let server: grpc.Server;
let addr: string;
const calls: RecordedCall[] = [];
const display = { width: 1280, height: 2856 };

beforeAll(async () => {
  const pkg = await protoLoader.load(EMULATOR_CONTROLLER_PROTO, {
    includeDirs: [PROTOS_DIR],
    keepCase: true,
    defaults: true,
  });
  const grpcObj = grpc.loadPackageDefinition(pkg) as unknown as {
    android: { emulation: { control: { EmulatorController: { service: grpc.ServiceDefinition } } } };
  };
  const service = grpcObj.android.emulation.control.EmulatorController.service;
  const record = (method: string) => (call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<unknown>) => {
    calls.push({
      method,
      request: call.request,
      auth: call.metadata.get("authorization")[0] as string | undefined,
    });
    if (method === "getDisplayConfigurations") {
      cb(null, { displays: [{ ...display, display: 0 }] });
      return;
    }
    // Deny configurable: PERMISSION_DENIED when the token is "deny".
    const token = call.metadata.get("authorization")[0] as string | undefined;
    if (token === "Bearer deny") {
      cb({ code: grpc.status.PERMISSION_DENIED, message: "token is not on the allowlist" });
      return;
    }
    cb(null, {});
  };
  server = new grpc.Server();
  server.addService(service, {
    sendTouch: record("sendTouch"),
    sendKey: record("sendKey"),
    getDisplayConfigurations: record("getDisplayConfigurations"),
  } as unknown as grpc.UntypedServiceImplementation);
  const port = await new Promise<number>((res, rej) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))),
  );
  addr = `127.0.0.1:${port}`;
});

afterAll(() => {
  server.forceShutdown();
});

async function control(token = "tok"): Promise<EmulatorControl> {
  const c = new GrpcEmulatorControl(addr, token);
  await c.refreshDisplay(); // deterministic display size for validation tests
  return c;
}

describe("GrpcEmulatorControl — unary sendTouch/sendKey + client-side validation (D3/D5)", () => {
  it("tap sends ONE sendTouch (identifier + pressure 1) with the Bearer token attached", async () => {
    calls.length = 0;
    const c = await control();
    await c.tap(640, 2680);
    const touchCalls = calls.filter((c) => c.method === "sendTouch");
    expect(touchCalls).toHaveLength(2); // DOWN + UP
    expect(touchCalls[0]!.auth).toBe("Bearer tok");
    // NOTE: `defaults: true` materializes every proto scalar, so the decoded
    // TouchEvent carries extra zero fields (touch_major, expiration, ...) —
    // assert the meaningful subset instead of an exact shape.
    const req = touchCalls[0]!.request as { touches: Array<Record<string, unknown>>; display?: number };
    expect(req.display ?? 0).toBe(0); // main display
    expect(req.touches).toHaveLength(1);
    expect(req.touches[0]).toMatchObject({ x: 640, y: 2680, identifier: 1, pressure: 1 });
  });

  it("swipe sends DOWN → MOVE steps → UP as sequential sendTouch calls", async () => {
    calls.length = 0;
    const c = await control();
    await c.swipe(10, 20, 100, 200, 100);
    // `control()` refreshes the display first — that getDisplayConfigurations
    // call is also recorded, so filter to the actual touch injections.
    const sendTouchCalls = calls.filter((cl) => cl.method === "sendTouch");
    expect(sendTouchCalls.length).toBeGreaterThanOrEqual(3);
    const touches = sendTouchCalls.map(
      (cl) => (cl.request as { touches: Array<{ x: number; y: number; pressure: number }> }).touches[0]!,
    );
    expect(touches[0]).toMatchObject({ x: 10, y: 20, pressure: 1 });
    expect(touches[touches.length - 1]).toMatchObject({ x: 100, y: 200, pressure: 0 });
    // every intermediate point stays inside the physical bounds
    for (const t of touches) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThan(display.width);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeLessThan(display.height);
    }
  });

  it("text injects via sendKey KeyboardEvent{text} (no sendText RPC exists in 36.5.11 — design D3)", async () => {
    calls.length = 0;
    const c = await control();
    await c.text("hello world");
    const keyCalls = calls.filter((c) => c.method === "sendKey");
    expect(keyCalls).toHaveLength(1);
    const req = keyCalls[0]!.request as Record<string, unknown>;
    expect(req["text"]).toBe("hello world");
    expect(req["eventType"]).toBe(2); // keypress
  });

  it("keyPress uses the W3C key name (probe D: key:'GoHome'", async () => {
    calls.length = 0;
    const c = await control();
    await c.keyPress("Home");
    expect(calls.filter((c) => c.method === "sendKey")[0]!.request as Record<string, unknown>).toMatchObject({ key: "Home" });
  });

  it("validates coordinates against the PHYSICAL display before any gRPC call (never a silent accept)", async () => {
    calls.length = 0;
    const c = await control();
    const outOfRange = async (): Promise<void> => { await c.tap(display.width, display.height); };
    try {
      await outOfRange();
      throw new Error("expected OUT_OF_RANGE");
    } catch (e) {
      expect(e).toBeInstanceOf(GrpcControlError);
      expect((e as GrpcControlError).code).toBe("OUT_OF_RANGE");
    }
    expect(calls.filter((c) => c.method === "sendTouch")).toHaveLength(0); // validation is client-side (probe D finding)
    await expect(c.tap(-1, 10)).rejects.toMatchObject({ code: "OUT_OF_RANGE" });
  });

  it("maps gRPC PERMISSION_DENIED to the 4401 close-code semantics (external launch)", async () => {
    const c = new GrpcEmulatorControl(addr, "deny");
    await c.refreshDisplay();
    try {
      await c.tap(10, 10);
      throw new Error("expected PERMISSION_DENIED");
    } catch (e) {
      expect(e).toBeInstanceOf(GrpcControlError);
      expect((e as GrpcControlError).code).toBe("PERMISSION_DENIED");
      expect((e as GrpcControlError).wsCloseCode).toBe(4401);
    }
  });

  it("maps gRPC UNAVAILABLE to DEVICE_OFFLINE (emulator not reachable)", async () => {
    const dead = new GrpcEmulatorControl("127.0.0.1:1", "tok");
    try {
      await dead.tap(1, 1);
      throw new Error("expected DEVICE_OFFLINE");
    } catch (e) {
      expect(e).toBeInstanceOf(GrpcControlError);
      expect((e as GrpcControlError).code).toBe("DEVICE_OFFLINE");
    }
  });

  it("reportDisplaySize resolves from getDisplayConfigurations display 0 (physical px)", async () => {
    const c = await control();
    expect(c.reportDisplaySize()).toEqual(display);
  });
});