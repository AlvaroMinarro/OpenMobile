import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRtcCapability } from "../src/device/grpc";

/**
 * resolveRtcCapability — the pid-ini + version-gate probe the gateway uses
 * for stream.rtc.supported (task 2.8; Launch Flags and Token + Fallback
 * requirements). Externally launched emulators degrade to
 * grpc_permission_denied; old versions name the requirement.
 */

function runDirWith(entries: Array<[string, string]>): string {
  const dir = mkdtempSync(join(tmpdir(), "om-rtc-cap-"));
  for (const [name, body] of entries) writeFileSync(join(dir, name), body);
  return dir;
}

describe("resolveRtcCapability — pid-ini endpoint + version gate (task 2.8)", () => {
  it("resolves an eligible emulator (36.5.11) to a supported endpoint", () => {
    const dir = runDirWith([
      ["pid_101.ini", "port.serial=5554\ngrpc.token=TOKEN-A\ngrpc.port=8554\nemulator.version=36.5.11.0\n"],
    ]);
    try {
      const cap = resolveRtcCapability(dir, "emulator-5554");
      expect(cap?.supported).toBe(true);
      expect(cap?.endpoint).toEqual({ addr: "localhost:8554", token: "TOKEN-A" });
      expect(cap?.reason).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("degrades an externally launched emulator (no pid ini) to grpc_permission_denied", () => {
    const dir = runDirWith([]);
    try {
      const cap = resolveRtcCapability(dir, "emulator-5554");
      expect(cap).toEqual({ supported: false, reason: "grpc_permission_denied" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gates an emulator below 36.5.11 naming the version requirement + upgrade path", () => {
    const dir = runDirWith([
      ["pid_101.ini", "port.serial=5554\ngrpc.token=T\ngrpc.port=8554\nemulator.version=36.4.0.0\n"],
    ]);
    try {
      const cap = resolveRtcCapability(dir, "emulator-5554");
      expect(cap?.supported).toBe(false);
      expect(cap?.reason).toContain("36.5.11");
      expect(cap?.reason).toContain("upgrade");
      expect(cap?.endpoint).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gates 36.5.10 (one patch below the pin) too", () => {
    const dir = runDirWith([
      ["pid_101.ini", "port.serial=5554\ngrpc.token=T\ngrpc.port=8554\nemulator.version=36.5.10.0\n"],
    ]);
    try {
      expect(resolveRtcCapability(dir, "emulator-5554")?.supported).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts an ini without a version field (cannot prove it is below the gate)", () => {
    const dir = runDirWith([
      ["pid_101.ini", "port.serial=5554\ngrpc.token=T\ngrpc.port=8554\n"],
    ]);
    try {
      const cap = resolveRtcCapability(dir, "emulator-5554");
      expect(cap?.supported).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
