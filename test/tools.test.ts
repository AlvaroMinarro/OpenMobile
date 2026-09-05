import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AndroidCli } from "../src/device/androidCli";
import { AdbWrapper } from "../src/device/adb";
import { MemoryRunner } from "./helpers/memoryRunner";
import {
  listDevices,
  getDeviceInfo,
  emulatorList,
  emulatorStart,
  emulatorStop,
  emulatorCreate,
  getUiTree,
  getUiTreeDiff,
  resolveScreenLabels,
  takeScreenshot,
  getAnnotatedScreen,
  readLogcat,
  tempPngPath,
  tap,
  tapRangeError,
  pressKey,
  deployApp,
} from "../src/tools/handlers";
import { createContext } from "../src/tools/context";
import type { DeviceContext } from "../src/tools/context";
import type { CommandRunner } from "../src/device/runner";
import { TimeoutRunner } from "./helpers/timeoutRunner";

function makeCtx(
  runner: CommandRunner,
  timeoutMs = 200,
  spawn?: (argv: string[]) => { exited: Promise<number>; kill(): void },
): DeviceContext {
  const cli = new AndroidCli(runner, spawn);
  const adb = new AdbWrapper(runner);
  return {
    cli,
    adb,
    env: {},
    baselineEstablished: new Set<string>(),
    timeoutMs,
    tempPngPath: () => `/tmp/om-test-${Date.now()}-${Math.random()}.png`,
  };
}

const oneElement = [
  {
    bounds: { left: 0, top: 0, right: 200, bottom: 80 },
    center: { x: 100, y: 40 },
    interactions: ["click"],
    state: "default",
    offScreen: false,
    text: "Login",
  },
];

const textOf = (res: { content: Array<{ type: string; text?: string }> }): string =>
  res.content.find((c) => c.type === "text")?.text ?? "";

describe("list_devices", () => {
  it("returns devices, AVDs and CLI version", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "devices", "-l"], {
      stdout: "List of devices attached\nemulator-5554\tdevice model:Pixel_9_Pro\n",
    });
    runner.expect(["android", "emulator", "list", "--long"], {
      stdout: "AVD ID            AVD Name       API Level    Status   Serial\nPixel_9_Pro       Pixel 9 Pro    android-36   Online   emulator-5554\n",
    });
    runner.expect(["android", "info", "version"], { stdout: "android 1.0.15985488\n" });
    const ctx = makeCtx(runner);
    const res = await listDevices(ctx, {});
    const parsed = JSON.parse(textOf(res)) as {
      devices: Array<{ serial: string; state: string; model?: string }>;
      avds: Array<{ name: string; running: boolean; serial?: string }>;
      cliVersion: string;
    };
    expect(parsed.devices[0]).toEqual({
      serial: "emulator-5554",
      state: "device",
      model: "Pixel_9_Pro",
    });
    expect(parsed.avds[0]).toEqual({ name: "Pixel_9_Pro", running: true, serial: "emulator-5554" });
    expect(parsed.cliVersion).toContain("1.0");
    runner.assertSatisfied();
  });

  it("lists an unauthorized device with a hint to accept the RSA prompt", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "devices", "-l"], {
      stdout: "List of devices attached\nemulator-5556\tunauthorized usb:1-2\n",
    });
    runner.expect(["android", "emulator", "list", "--long"], { stdout: "" });
    runner.expect(["android", "info", "version"], { stdout: "" });
    const ctx = makeCtx(runner);
    const res = await listDevices(ctx, {});
    const parsed = JSON.parse(textOf(res)) as {
      devices: Array<{ serial: string; state: string; hint?: string }>;
    };
    expect(parsed.devices[0]?.state).toBe("unauthorized");
    expect(parsed.devices[0]?.hint).toMatch(/RSA/i);
    runner.assertSatisfied();
  });

  it("returns an empty device list (not an error) when nothing is attached", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "devices", "-l"], { stdout: "List of devices attached\n" });
    runner.expect(["android", "emulator", "list", "--long"], { stdout: "" });
    runner.expect(["android", "info", "version"], { stdout: "" });
    const ctx = makeCtx(runner);
    const res = await listDevices(ctx, {});
    const parsed = JSON.parse(textOf(res)) as { devices: unknown[] };
    expect(parsed.devices).toEqual([]);
    expect(res.isError).toBeFalsy();
    runner.assertSatisfied();
  });
});

describe("emulator_list", () => {
  it("returns every AVD with running status", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "emulator", "list", "--long"], {
      stdout: "AVD ID            AVD Name       API Level    Status   Serial\nPixel_9_Pro       Pixel 9 Pro    android-36   Online   emulator-5554\nMedium_Phone_API_36.1  Medium Phone API 36.1  android-36.1  Offline\n",
    });
    const ctx = makeCtx(runner);
    const res = await emulatorList(ctx, {});
    const parsed = JSON.parse(textOf(res)) as { avds: unknown[] };
    expect(parsed.avds).toEqual([
      { name: "Pixel_9_Pro", running: true, serial: "emulator-5554" },
      { name: "Medium_Phone_API_36.1", running: false },
    ]);
    runner.assertSatisfied();
  });
});

describe("get_device_info — device props via adb getprop (D6: never android info)", () => {
  it("reports SDK/model from getprop with best-effort screen metrics", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "devices", "-l"], {
      stdout: "List of devices attached\nemulator-5554\tdevice model:Pixel_9_Pro\n",
    });
    runner.expect(
      ["adb", "-s", "emulator-5554", "shell", "getprop", "ro.build.version.sdk"],
      { stdout: "36\n" },
    );
    runner.expect(
      ["adb", "-s", "emulator-5554", "shell", "getprop", "ro.product.model"],
      { stdout: "Pixel_9_Pro\n" },
    );
    runner.expect(["adb", "-s", "emulator-5554", "shell", "wm", "size"], {
      stdout: "Physical size: 1280x2856\n",
    });
    runner.expect(["adb", "-s", "emulator-5554", "shell", "wm", "density"], {
      stdout: "Physical density: 480\n",
    });
    const ctx = makeCtx(runner);
    const res = await getDeviceInfo(ctx, {});
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res)) as Record<string, unknown>;
    expect(parsed).toEqual({
      serial: "emulator-5554",
      state: "device",
      model: "Pixel_9_Pro",
      sdk: "36",
      screenSize: "1280x2856",
      density: "480",
    });
    runner.assertSatisfied();
  });

  it("degrades gracefully when wm metrics or props are unavailable", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5554\tdevice\n" }); // no model from devices -l
    runner.expect(
      ["adb", "-s", "emulator-5554", "shell", "getprop", "ro.build.version.sdk"],
      { stdout: "36\n" },
    );
    runner.expect(
      ["adb", "-s", "emulator-5554", "shell", "getprop", "ro.product.model"],
      { stdout: "\n" },
    ); // model prop empty
    runner.expect(["adb", "-s", "emulator-5554", "shell", "wm", "size"], { exitCode: 1 }); // wm unsupported
    const ctx = makeCtx(runner);
    const res = await getDeviceInfo(ctx, {});
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res)) as Record<string, unknown>;
    expect(parsed.sdk).toBe("36");
    expect(parsed.screenSize).toBeUndefined();
    runner.assertSatisfied();
  });

  it("never calls `android info` for device metadata", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5554\tdevice\n" });
    runner.expect(
      ["adb", "-s", "emulator-5554", "shell", "getprop", "ro.build.version.sdk"],
      { stdout: "36\n" },
    );
    runner.expect(
      ["adb", "-s", "emulator-5554", "shell", "getprop", "ro.product.model"],
      { stdout: "Pixel_9_Pro\n" },
    );
    const ctx = makeCtx(runner);
    const res = await getDeviceInfo(ctx, {});
    expect(res.isError).toBeFalsy();
    expect(runner.called("android", "info")).toBe(false);
    runner.assertSatisfied();
  });
});

describe("emulator_start — direct-spawn launch (D4/D6) correlating the STARTED emulator (D5)", () => {
  const SDK = "/opt/fake-sdk";
  const EMU = `${SDK}/emulator/emulator`;
  const VERSION_36_5 = "Android emulator version 36.5.11.0 (build_id 15261951) (CL:N/A)\n";
  const listOne =
    "AVD ID            AVD Name       API Level    Status   Serial\nPixel_9_Pro       Pixel 9 Pro    android-36   Offline\n";
  const listOnline =
    "AVD ID            AVD Name       API Level    Status   Serial\nPixel_9_Pro       Pixel 9 Pro    android-36   Online   emulator-5554\n";

  /** Detached-spawn double: the emulator keeps running (exited stays pending). */
  const detachedSpawn = () => () => ({
    exited: new Promise<number>(() => {}),
    kill: () => {},
  });

  /** Allowlist dir the CLI's writeAllowlist() honors (env contract). */
  function useAllowlistDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "om-tools-allowlist-"));
    process.env["OPENMOBILE_ALLOWLIST_DIR"] = dir;
    return dir;
  }

  function cleanupAllowlist(dir?: string): void {
    delete process.env["OPENMOBILE_ALLOWLIST_DIR"];
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  /** Record the shared happy-path expectations: pre-check, sdk, version, then a poll that goes Online. */
  function expectLaunchFlow(runner: MemoryRunner, pollList: string): void {
    runner.expect(["android", "emulator", "list", "--long"], { stdout: listOne }); // pre-start pre-check
    runner.expect(["android", "info", "sdk"], { stdout: `${SDK}\n` });
    runner.expect([EMU, "-version"], { stdout: VERSION_36_5 });
    runner.expect(["android", "emulator", "list", "--long"], { stdout: pollList }); // registration poll
  }

  it("starts the single AVD (no name) via direct spawn and waits for its serial to reach 'device'", async () => {
    const dir = useAllowlistDir();
    try {
      const runner = new MemoryRunner();
      expectLaunchFlow(runner, listOnline);
      runner.expect(["adb", "devices", "-l"], {
        stdout: "emulator-5556\tdevice\nemulator-5554\toffline\n",
      }); // readiness poll 1: not ready yet
      runner.expect(["adb", "devices", "-l"], {
        stdout: "emulator-5556\tdevice\nemulator-5554\tdevice\n",
      }); // readiness poll 2: ready
      const calls: string[][] = [];
      const spawn = (argv: string[]) => {
        calls.push([...argv]);
        return { exited: new Promise<number>(() => {}), kill: () => {} };
      };
      const ctx = makeCtx(runner, 400, spawn);
      const res = await emulatorStart(ctx, {});
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(textOf(res))).toEqual({ started: "Pixel_9_Pro", serial: "emulator-5554" });
      // The emulator binary was launched directly with the allowlist flag.
      expect(calls[0]![0]).toBe(EMU);
      expect(calls[0]).toContain("-grpc-allowlist");
      // D5: the OTHER already-attached device (emulator-5556) is never mistaken for ours.
      runner.assertSatisfied();
    } finally {
      cleanupAllowlist(dir);
    }
  });

  it("polls the serial registered in the AVD list, ignoring an already-attached device", async () => {
    const dir = useAllowlistDir();
    try {
      const runner = new MemoryRunner();
      runner.expect(["android", "emulator", "list", "--long"], { stdout: listOne }); // pre-start pre-check
      runner.expect(["android", "info", "sdk"], { stdout: `${SDK}\n` });
      runner.expect([EMU, "-version"], { stdout: VERSION_36_5 });
      runner.expect(["android", "emulator", "list", "--long"], { stdout: listOne }); // still booting
      runner.expect(["android", "emulator", "list", "--long"], { stdout: listOnline }); // registered
      runner.expect(["adb", "devices", "-l"], {
        stdout: "emulator-5556\tdevice\nemulator-5554\tdevice\n",
      }); // readiness: 5554 ready while 5556 was already device
      const ctx = makeCtx(runner, 400, detachedSpawn());
      const res = await emulatorStart(ctx, { name: "Pixel_9_Pro" });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(textOf(res)) as { started: string; serial: string };
      expect(parsed.started).toBe("Pixel_9_Pro");
      expect(parsed.serial).toBe("emulator-5554"); // NOT emulator-5556
      runner.assertSatisfied();
    } finally {
      cleanupAllowlist(dir);
    }
  });

  it("passes an explicit fps: 60 through to the -rtcfps launch flag", async () => {
    const dir = useAllowlistDir();
    try {
      const runner = new MemoryRunner();
      runner.expect(["android", "emulator", "list", "--long"], { stdout: listOne }); // pre-start pre-check
      runner.expect(["android", "info", "sdk"], { stdout: `${SDK}\n` });
      // 36.6 knows -rtcfps (36.5.11 does not — live-verified).
      runner.expect([EMU, "-version"], {
        stdout: "Android emulator version 36.6.11.0 (build_id 16000000) (CL:N/A)\n",
      });
      runner.expect(["android", "emulator", "list", "--long"], { stdout: listOnline }); // registration poll
      runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5554\tdevice\n" }); // readiness
      const calls: string[][] = [];
      const spawn = (argv: string[]) => {
        calls.push([...argv]);
        return { exited: new Promise<number>(() => {}), kill: () => {} };
      };
      const ctx = makeCtx(runner, 400, spawn);
      const res = await emulatorStart(ctx, { name: "Pixel_9_Pro", fps: 60 });
      expect(res.isError).toBeFalsy();
      expect(calls[0]!.slice(calls[0]!.indexOf("-rtcfps") + 1)[0]).toBe("60");
      runner.assertSatisfied();
    } finally {
      cleanupAllowlist(dir);
    }
  });

  it("returns an actionable error when the started serial never reaches 'device'", async () => {
    const dir = useAllowlistDir();
    try {
      const runner = new MemoryRunner();
      expectLaunchFlow(runner, listOnline);
      runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5554\toffline\n" }); // readiness poll
      const ctx = makeCtx(runner, 60, detachedSpawn());
      const res = await emulatorStart(ctx, { name: "Pixel_9_Pro" });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("Pixel_9_Pro");
      expect(textOf(res)).toContain("emulator-5554");
      expect(textOf(res)).toContain("offline");
      runner.assertSatisfied();
    } finally {
      cleanupAllowlist(dir);
    }
  });

  it("surfaces an actionable launch failure (version gate) instead of starting", async () => {
    const dir = useAllowlistDir();
    try {
      const runner = new MemoryRunner();
      runner.expect(["android", "emulator", "list", "--long"], { stdout: listOne }); // pre-start pre-check
      runner.expect(["android", "info", "sdk"], { stdout: `${SDK}\n` });
      runner.expect([EMU, "-version"], {
        stdout: "Android emulator version 36.4.9.0 (build_id 1) (CL:N/A)\n",
      });
      const ctx = makeCtx(runner, 200, detachedSpawn());
      const res = await emulatorStart(ctx, { name: "Pixel_9_Pro" });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("36.5.11");
      runner.assertSatisfied();
    } finally {
      cleanupAllowlist(dir);
    }
  });

  it("returns an error naming the unknown AVD and listing the available ones", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "emulator", "list", "--long"], { stdout: listOne });
    const ctx = makeCtx(runner);
    const res = await emulatorStart(ctx, { name: "Ghost_AVD" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Ghost_AVD");
    expect(textOf(res)).toContain("Pixel_9_Pro"); // lists available AVDs
    runner.assertSatisfied(); // no start command was ever issued
  });
});

describe("emulator_create — rejects duplicates (Create AVD spec)", () => {
  const listWithPixel =
    "AVD ID            AVD Name       API Level    Status   Serial\nPixel_9_Pro       Pixel 9 Pro    android-36   Offline\n";

  it("rejects a duplicate AVD name and creates nothing", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "emulator", "list", "--long"], { stdout: listWithPixel });
    const ctx = makeCtx(runner);
    const res = await emulatorCreate(ctx, { name: "Pixel_9_Pro" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("already exists");
    runner.assertSatisfied(); // the create command was NEVER issued
  });

  it("creates an AVD that then appears in emulator_list (Create-from-local-image spec)", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "emulator", "list", "--long"], { stdout: listWithPixel });
    runner.expect(["android", "emulator", "create", "Fresh_AVD"], { exitCode: 0 });
    // THEN: the created AVD shows up in the next listing…
    runner.expect(["android", "emulator", "list", "--long"], {
      stdout: `${listWithPixel}Fresh_AVD        Fresh AVD      android-36   Offline\n`,
    });
    const ctx = makeCtx(runner);
    const res = await emulatorCreate(ctx, { name: "Fresh_AVD" });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({ created: "Fresh_AVD" });
    // …proving create → visible-in-list end to end through the real handlers.
    const listed = await emulatorList(ctx, {});
    const avds = JSON.parse(textOf(listed)) as { avds: Array<{ name: string }> };
    expect(avds.avds.some((a) => a.name === "Fresh_AVD")).toBe(true);
    runner.assertSatisfied();
  });
});

describe("emulator_stop — reports success only once the AVD is no longer running (Stop AVD spec)", () => {
  const listRunning =
    "AVD ID            AVD Name       API Level    Status   Serial\nPixel_9_Pro       Pixel 9 Pro    android-36   Online   emulator-5554\n";
  const listStopped =
    "AVD ID            AVD Name       API Level    Status   Serial\nPixel_9_Pro       Pixel 9 Pro    android-36   Offline\n";

  it("stops a running emulator which is then no longer listed as running", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "emulator", "stop", "Pixel_9_Pro"], { exitCode: 0 });
    runner.expect(["android", "emulator", "list", "--long"], { stdout: listStopped });
    const ctx = makeCtx(runner);
    const res = await emulatorStop(ctx, { name: "Pixel_9_Pro" });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({ stopped: "Pixel_9_Pro" });
    runner.assertSatisfied();
  });

  it("refuses success while the emulator is STILL listed as running after the stop command", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "emulator", "stop", "Pixel_9_Pro"], { exitCode: 0 });
    runner.expect(["android", "emulator", "list", "--long"], { stdout: listRunning });
    const ctx = makeCtx(runner);
    const res = await emulatorStop(ctx, { name: "Pixel_9_Pro" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("still listed as running");
    runner.assertSatisfied();
  });
});

describe("deploy_app — android CLI install/run with adb fallback", () => {
  const serial = "emulator-5554";
  const apk = "/tmp/app.apk";

  it("installs via the android CLI (no activity)", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "install", `--device=${serial}`, apk], { exitCode: 0 });
    const ctx = makeCtx(runner);
    const res = await deployApp(ctx, { apk, device: serial });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res)) as {
      installed: string;
      serial: string;
      launched: unknown;
    };
    expect(parsed.installed).toBe(apk);
    expect(parsed.serial).toBe(serial);
    expect(parsed.launched).toBe(false);
    runner.assertSatisfied();
  });

  it("installs and launches via the android CLI when an activity is given", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "install", `--device=${serial}`, apk], { exitCode: 0 });
    runner.expect(["android", "run", `--device=${serial}`, apk, "com.x/.Main"], {
      exitCode: 0,
    });
    const ctx = makeCtx(runner);
    const res = await deployApp(ctx, { apk, activity: "com.x/.Main", device: serial });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res)) as { launched: unknown };
    expect(parsed.launched).toBe("com.x/.Main");
    runner.assertSatisfied();
  });

  it("falls back to adb install when the CLI install fails", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "install", `--device=${serial}`, apk], {
      exitCode: 1,
      stderr: "CLI install exploded",
    });
    runner.expect(["adb", "-s", serial, "install", "-r", apk], { exitCode: 0 });
    const ctx = makeCtx(runner);
    const res = await deployApp(ctx, { apk, device: serial });
    expect(res.isError).toBeFalsy();
    expect(runner.called("adb", "-s", serial, "install", "-r", apk)).toBe(true);
    runner.assertSatisfied();
  });

  it("falls back to adb am start when the CLI run fails", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "install", `--device=${serial}`, apk], { exitCode: 0 });
    runner.expect(["android", "run", `--device=${serial}`, apk, "com.x/.Main"], {
      exitCode: 1,
      stderr: "CLI run exploded",
    });
    runner.expect(["adb", "-s", serial, "shell", "am", "start", "-n", "com.x/.Main"], {
      exitCode: 0,
    });
    const ctx = makeCtx(runner);
    const res = await deployApp(ctx, { apk, activity: "com.x/.Main", device: serial });
    expect(res.isError).toBeFalsy();
    expect(runner.called("adb", "-s", serial, "shell", "am", "start", "-n", "com.x/.Main")).toBe(
      true,
    );
    runner.assertSatisfied();
  });

  it("refuses with an actionable error when multiple devices are present", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "devices", "-l"], {
      stdout: "emulator-5554\tdevice\ndeadbeef\tdevice\n",
    });
    const ctx = makeCtx(runner);
    const res = await deployApp(ctx, { apk });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("multiple devices");
    runner.assertSatisfied();
  });

  it("returns an error indicating no target device when NOTHING is attached (zero-device e2e)", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "devices", "-l"], { stdout: "List of devices attached\n" });
    const ctx = makeCtx(runner);
    const res = await deployApp(ctx, { apk }); // no --device, empty env → auto-detect over zero devices
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("no usable Android device");
    runner.assertSatisfied(); // proves NO install/launch command was ever issued
  });

  it("surfaces a signature conflict from the CLI install without masking it via adb", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "install", `--device=${serial}`, apk], {
      exitCode: 1,
      stderr: "INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package com.x signatures do not match previously installed version",
    });
    const ctx = makeCtx(runner);
    const res = await deployApp(ctx, { apk, device: serial });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("signature conflict");
    expect(textOf(res)).toContain(apk);
    runner.assertSatisfied(); // no adb fallback masked the conflict
  });

  it("surfaces a signature conflict when only the adb fallback detects it", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "install", `--device=${serial}`, apk], {
      exitCode: 1,
      stderr: "CLI unavailable",
    });
    runner.expect(["adb", "-s", serial, "install", "-r", apk], {
      exitCode: 1,
      stderr: "[INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]",
    });
    const ctx = makeCtx(runner);
    const res = await deployApp(ctx, { apk, device: serial });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("signature conflict");
    expect(textOf(res)).toContain(apk);
    runner.assertSatisfied();
  });
});

describe("get_ui_tree_diff — server-owned baselineEstablished set", () => {
  const serial = "emulator-5554";

  it("first call in a process establishes a baseline and returns a full tree", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "layout", `--device=${serial}`], {
      stdout: JSON.stringify(oneElement),
    });
    const ctx = makeCtx(runner);
    const res = await getUiTreeDiff(ctx, { device: serial });
    const parsed = JSON.parse(textOf(res)) as { baseline: string; tree: unknown[] };
    expect(parsed.baseline).toBe("set");
    expect(parsed.tree).toHaveLength(1);
    expect(ctx.baselineEstablished.has(serial)).toBe(true);
    runner.assertSatisfied();
  });

  it("later calls use --diff and return only changed elements", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "layout", `--device=${serial}`, "--diff"], {
      stdout: JSON.stringify({ added: oneElement, modified: [] }),
    });
    const ctx = makeCtx(runner);
    ctx.baselineEstablished.add(serial); // baseline already set
    const res = await getUiTreeDiff(ctx, { device: serial });
    const parsed = JSON.parse(textOf(res)) as { diff: { added: unknown[] } };
    expect(parsed.diff.added).toHaveLength(1);
    runner.assertSatisfied();
  });

  it("a fresh context re-establishes the baseline (no stale diff after restart)", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "layout", `--device=${serial}`], {
      stdout: JSON.stringify(oneElement),
    });
    const freshCtx = makeCtx(runner); // brand-new context => empty baseline set
    expect(freshCtx.baselineEstablished.has(serial)).toBe(false);
    const res = await getUiTreeDiff(freshCtx, { device: serial });
    expect(JSON.parse(textOf(res))).toMatchObject({ baseline: "set" });
    runner.assertSatisfied();
  });

  it("when --diff falls back to a full tree it reports baseline re-set, not a stale diff", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "layout", `--device=${serial}`, "--diff"], {
      stdout: JSON.stringify(oneElement[0]), // full-tree shape (no added/modified keys)
    });
    const ctx = makeCtx(runner);
    ctx.baselineEstablished.add(serial);
    const res = await getUiTreeDiff(ctx, { device: serial });
    const parsed = JSON.parse(textOf(res)) as { baseline: string };
    expect(parsed.baseline).toBe("re-set");
    runner.assertSatisfied();
  });
});

describe("get_ui_tree — CLI→XML fallback composition (Full UI Tree spec)", () => {
  const serial = "emulator-5554";
  const loginXml =
    '<hierarchy rotation="0"><node index="0" text="Login" resource-id="com.app:id/login" class="android.widget.Button" clickable="true" bounds="[0,0][200,80]" displayed="true"/></hierarchy>';
  const emptyXml = '<hierarchy rotation="0"></hierarchy>';
  type ExpectArgs = Parameters<MemoryRunner["expect"]>;
  const dump = (): ExpectArgs => [
    ["adb", "-s", serial, "shell", "uiautomator", "dump", "/sdcard/window_dump.xml"],
    { stdout: "UI hierchary dumped to: /sdcard/window_dump.xml" },
  ];
  const cat = (body: string): ExpectArgs => [
    ["adb", "-s", serial, "shell", "cat", "/sdcard/window_dump.xml"],
    { stdout: body },
  ];

  it("returns the CLI layout tree when the CLI answers with content", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "layout", `--device=${serial}`], {
      stdout: JSON.stringify(oneElement),
    });
    const ctx = makeCtx(runner);
    const res = await getUiTree(ctx, { device: serial });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res)) as {
      serial: string;
      empty: boolean;
      tree: Array<{ center: { x: number; y: number } }>;
    };
    expect(parsed.serial).toBe(serial);
    expect(parsed.empty).toBe(false);
    expect(parsed.tree[0]?.center).toEqual({ x: 100, y: 40 });
    runner.assertSatisfied(); // never touched uiautomator
  });

  it("falls back to parsed uiautomator XML when the CLI layout is empty", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "layout", `--device=${serial}`], { stdout: "" });
    runner.expect(...dump());
    runner.expect(...cat(loginXml));
    const ctx = makeCtx(runner);
    const res = await getUiTree(ctx, { device: serial });
    const parsed = JSON.parse(textOf(res)) as {
      empty: boolean;
      tree: Array<{ text?: string }>;
    };
    expect(parsed.empty).toBe(false); // XML rescued the screen — not a false empty
    expect(parsed.tree[0]?.text).toBe("Login");
    runner.assertSatisfied();
  });

  it("signals empty explicitly when BOTH the CLI layout and the XML dump are empty", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "layout", `--device=${serial}`], { stdout: "" });
    runner.expect(...dump());
    runner.expect(...cat(emptyXml));
    const ctx = makeCtx(runner);
    const res = await getUiTree(ctx, { device: serial });
    const parsed = JSON.parse(textOf(res)) as { empty: boolean; tree: unknown[] };
    expect(parsed.empty).toBe(true); // explicit signal, never a misleading success
    expect(parsed.tree).toEqual([]);
    runner.assertSatisfied();
  });

  it("returns the parsed uiautomator XML as the tree when the android CLI is unavailable", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "layout", `--device=${serial}`], {
      exitCode: 1,
      stderr: "android: command not found",
    });
    runner.expect(...dump());
    runner.expect(...cat(loginXml));
    const ctx = makeCtx(runner);
    const res = await getUiTree(ctx, { device: serial });
    expect(res.isError).toBeFalsy(); // adb present ⇒ the tool still delivers the tree
    const parsed = JSON.parse(textOf(res)) as {
      empty: boolean;
      tree: Array<{ text?: string }>;
    };
    expect(parsed.empty).toBe(false);
    expect(parsed.tree[0]?.text).toBe("Login");
    runner.assertSatisfied();
  });
});

describe("read_logcat — dump-and-tail handler (logcat-read spec)", () => {
  const serial = "emulator-5554";
  const mixedLevels = [
    "08-12 17:00:01.000  1234  1234 D/Tag( 1234): debug noise",
    "08-12 17:00:02.000  1234  1234 E/Tag( 1234): boom one",
    "08-12 17:00:03.000   999   999 I/Tag(  999): info noise",
    "08-12 17:00:04.000  1234  1234 E/Other( 1234): boom two",
    "08-12 17:00:05.000   999   999 W/Tag(  999): warn noise",
    "",
  ].join("\n");

  it("with NO filter it defaults to errors-only (E) and returns them newest first", async () => {
    const runner = new MemoryRunner();
    // The argv itself carries the DEFAULT `E:*` filterspec — proving the
    // handler executed `priority ?? "E"`, not just the wrapper's filter logic.
    runner.expect(
      ["adb", "-s", serial, "logcat", "-d", "-t", "100", "-v", "time", "E:*"],
      { stdout: mixedLevels },
    );
    const ctx = makeCtx(runner);
    const res = await readLogcat(ctx, { device: serial });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res)) as { serial: string; truncated: boolean; lines: string[] };
    expect(parsed.serial).toBe(serial);
    expect(parsed.truncated).toBe(false);
    expect(parsed.lines).toEqual([
      "08-12 17:00:04.000  1234  1234 E/Other( 1234): boom two",
      "08-12 17:00:02.000  1234  1234 E/Tag( 1234): boom one",
    ]);
    runner.assertSatisfied();
  });

  it("passes an explicit priority through instead of the E default (W scoped)", async () => {
    const runner = new MemoryRunner();
    runner.expect(
      ["adb", "-s", serial, "logcat", "-d", "-t", "100", "-v", "time", "W:*"],
      { stdout: mixedLevels },
    );
    const ctx = makeCtx(runner);
    const res = await readLogcat(ctx, { device: serial, priority: "W" });
    const parsed = JSON.parse(textOf(res)) as { lines: string[] };
    expect(parsed.lines).toEqual(["08-12 17:00:05.000   999   999 W/Tag(  999): warn noise"]);
    runner.assertSatisfied();
  });
});

describe("resolve_screen_labels", () => {
  it("maps valid labels to center coordinates", async () => {
    const runner = new MemoryRunner();
    runner.expect(
      ["android", "screen", "resolve", "--screenshot", "/tmp/ann.png", "--string", "#3"],
      { stdout: "540,1200\n" },
    );
    runner.expect(
      ["android", "screen", "resolve", "--screenshot", "/tmp/ann.png", "--string", "#7"],
      { stdout: "100,200\n" },
    );
    const ctx = makeCtx(runner);
    const res = await resolveScreenLabels(ctx, { screenshot: "/tmp/ann.png", labels: ["#3", "#7"] });
    const parsed = JSON.parse(textOf(res)) as { points: Array<{ label: string }> };
    expect(parsed.points.length).toBe(2);
    runner.assertSatisfied();
  });

  it("returns an actionable error listing the valid labels when one is unknown", async () => {
    const runner = new MemoryRunner();
    runner.expect(
      ["android", "screen", "resolve", "--screenshot", "/tmp/ann.png", "--string", "#9"],
      { stdout: "no match\n" }, // label absent on this screen → no coordinates
    );
    const ctx = makeCtx(runner);
    const res = await resolveScreenLabels(ctx, { screenshot: "/tmp/ann.png", labels: ["#9"] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("#9"); // names the offender
    expect(textOf(res)).toMatch(/valid labels/i); // actionable: points at what IS valid
    runner.assertSatisfied();
  });
});

describe("temp PNG hygiene — unique names and cleanup after read (D7)", () => {
  const serial = "emulator-5554";

  it("tempPngPath() returns unique, sanitized, serial-bearing names per call", async () => {
    const a = tempPngPath("shot", "emulator-5554");
    const b = tempPngPath("shot", "emulator-5554");
    expect(a).toMatch(/^\/tmp\/om-shot-emulator-5554-\d+-\w{6}\.png$/);
    expect(b).toMatch(/^\/tmp\/om-shot-emulator-5554-\d+-\w{6}\.png$/);
    expect(a).not.toBe(b); // never the same path, even same-process same-ms
    expect(tempPngPath("annotated", "emulator-5554")).toMatch(
      /^\/tmp\/om-annotated-emulator-5554-\d+-\w{6}\.png$/,
    );
  });

  it("takeScreenshot reads its temp file THEN deletes it (file gone after result)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "om-shot-test-"));
    const shotPath = join(dir, "shot.png");
    const runner = new MemoryRunner();
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5554\tdevice\n" });
    runner.expect(["android", "screen", "capture", `--device=${serial}`, "-o", shotPath], {
      exitCode: 0,
    });
    const ctx = makeCtx(runner);
    ctx.tempPngPath = (_kind: string, _serial: string) => shotPath;
    ctx.readFile = async (path: string) => {
      // Simulate the capture having written a real file: created HERE so a
      // premature deletion (before read) leaves the file behind and FAILS.
      await writeFile(path, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
      return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    };
    const res = await takeScreenshot(ctx, {});
    expect(res.isError).toBeFalsy();
    expect(res.content.some((c) => c.type === "image")).toBe(true);
    expect(existsSync(shotPath)).toBe(false); // cleanup ran after the read
    await rm(dir, { recursive: true, force: true });
    runner.assertSatisfied();
  });

  it("cleans up the temp file even when the read throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "om-fail-test-"));
    const shotPath = join(dir, "shot.png");
    const runner = new MemoryRunner();
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5554\tdevice\n" });
    runner.expect(["android", "screen", "capture", `--device=${serial}`, "-o", shotPath], {
      exitCode: 0,
    });
    const ctx = makeCtx(runner);
    ctx.tempPngPath = (_kind: string, _serial: string) => shotPath;
    ctx.readFile = async (path: string) => {
      await writeFile(path, new Uint8Array([1]));
      throw new Error("read exploded");
    };
    const res = await takeScreenshot(ctx, {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("read exploded");
    expect(existsSync(shotPath)).toBe(false); // cleanup on failure too
    await rm(dir, { recursive: true, force: true });
    runner.assertSatisfied();
  });

  it("getAnnotatedScreen uses the annotated kind with the same hygiene", async () => {
    const dir = await mkdtemp(join(tmpdir(), "om-ann-test-"));
    const annPath = join(dir, "ann.png");
    const runner = new MemoryRunner();
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5554\tdevice\n" });
    runner.expect(
      ["android", "screen", "capture", `--device=${serial}`, "-o", annPath, "--annotate"],
      { exitCode: 0 },
    );
    const ctx = makeCtx(runner);
    ctx.tempPngPath = (kind: string, _serial: string) => {
      expect(kind).toBe("annotated");
      return annPath;
    };
    ctx.readFile = async (path: string) => {
      await writeFile(path, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
      return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    };
    const res = await getAnnotatedScreen(ctx, {});
    expect(res.isError).toBeFalsy();
    expect(res.content.some((c) => c.type === "image")).toBe(true);
    expect(existsSync(annPath)).toBe(false);
    await rm(dir, { recursive: true, force: true });
    runner.assertSatisfied();
  });

  it("two CONCURRENT captures each read their own unique temp file bytes (no cross-talk)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "om-conc-test-"));
    const pathA = join(dir, "shot-a.png");
    const pathB = join(dir, "shot-b.png");
    let issued = 0;
    const runner = new MemoryRunner();
    // Explicit --device on both calls: no adb devices round-trip occurs.
    runner.expect(["android", "screen", "capture", `--device=${serial}`, "-o", pathA], {
      exitCode: 0,
    });
    runner.expect(["android", "screen", "capture", `--device=${serial}`, "-o", pathB], {
      exitCode: 0,
    });
    const reads: string[] = [];
    const ctx = makeCtx(runner);
    ctx.tempPngPath = (_kind: string, _serial: string) => (issued === 0 ? ((issued = 1), pathA) : ((issued = 2), pathB));
    const bytesA = new Uint8Array([1, 1, 1, 1]);
    const bytesB = new Uint8Array([2, 2, 2, 2]);
    ctx.readFile = async (path: string) => {
      reads.push(path);
      return path === pathA ? bytesA : bytesB;
    };
    // WHEN two screenshot requests are handled concurrently…
    const [resA, resB] = await Promise.all([
      takeScreenshot(ctx, { device: serial }),
      takeScreenshot(ctx, { device: serial }),
    ]);
    // …THEN each request read its OWN unique temp file exactly once.
    expect(resA.isError).toBeFalsy();
    expect(resB.isError).toBeFalsy();
    expect(reads.sort()).toEqual([pathA, pathB]);
    const dataA = resA.content.find((c) => c.type === "image")?.data;
    const dataB = resB.content.find((c) => c.type === "image")?.data;
    expect(dataA).not.toBe(dataB); // distinct bytes ⇒ no shared/collided file
    expect(existsSync(pathA)).toBe(false);
    expect(existsSync(pathB)).toBe(false);
    await rm(dir, { recursive: true, force: true });
    runner.assertSatisfied();
  });
});

describe("take_screenshot — CLI→adb screencap fallback (Raw Screenshot)", () => {
  it("falls back to adb screencap when the android CLI capture fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "om-fb-test-"));
    const shotPath = join(dir, "shot.png");
    const runner = new MemoryRunner();
    // GIVEN the android CLI capture path failing…
    runner.expect(["android", "screen", "capture", "--device=emulator-5554", "-o", shotPath], {
      exitCode: 1,
      stderr: "CLI capture exploded",
    });
    const screencaps: Array<{ serial: string; localPath: string }> = [];
    const ctx = makeCtx(runner);
    ctx.tempPngPath = () => shotPath;
    ctx.readFile = async (path: string) => {
      await writeFile(path, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
      return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    };
    // Wrapper internals are covered by adb.test.ts; this asserts the handler
    // COMPOSITION: CLI failure routes into AdbWrapper.screencap(serial, path).
    ctx.adb = {
      devices: async () => [{ serial: "emulator-5554", state: "device" }],
      screencap: async (serial: string, localPath: string) => {
        screencaps.push({ serial, localPath });
      },
    } as unknown as AdbWrapper;
    // WHEN take_screenshot is called THEN PNG bytes come back via screencap.
    const res = await takeScreenshot(ctx, {});
    expect(res.isError).toBeFalsy();
    expect(res.content.some((c) => c.type === "image")).toBe(true);
    expect(screencaps).toEqual([{ serial: "emulator-5554", localPath: shotPath }]);
    runner.assertSatisfied(); // nothing else ran: no second CLI attempt, no adb CLI calls
    expect(existsSync(shotPath)).toBe(false); // temp hygiene still holds on the fallback path
    await rm(dir, { recursive: true, force: true });
  });
});

describe("tap — out-of-range validation (Tap spec: reject when screen size is known)", () => {
  it("rejects coordinates beyond the screen with an error stating the valid range", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5554\tdevice\n" });
    runner.expect(["adb", "-s", "emulator-5554", "shell", "wm", "size"], {
      stdout: "Physical size: 1080x2400\n",
    });
    const ctx = makeCtx(runner);
    const res = await tap(ctx, { x: 2000, y: 50 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("valid range");
    expect(textOf(res)).toContain("1080x2400");
    runner.assertSatisfied(); // no input tap was ever injected
  });

  it("injects normally when coordinates are inside the known screen", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5554\tdevice\n" });
    runner.expect(["adb", "-s", "emulator-5554", "shell", "wm", "size"], {
      stdout: "Physical size: 1080x2400\n",
    });
    runner.expect(["adb", "-s", "emulator-5554", "shell", "input", "tap", "540", "1200"], {
      exitCode: 0,
    });
    const ctx = makeCtx(runner);
    const res = await tap(ctx, { x: 540, y: 1200 });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toMatchObject({ injected: "tap", x: 540, y: 1200 });
    runner.assertSatisfied();
  });

  it("pure gate: unknown/unparsable size never blocks; negatives and bounds do", () => {
    expect(tapRangeError(540, 1200, undefined)).toBeNull();
    expect(tapRangeError(540, 1200, "garbage")).toBeNull();
    expect(tapRangeError(540, 1200, "1080x2400")).toBeNull();
    expect(tapRangeError(2000, 50, "1080x2400")).toContain("valid range");
    expect(tapRangeError(-1, 50, "1080x2400")).toContain("valid range");
    expect(tapRangeError(540, 2400, "1080x2400")).toContain("valid range"); // y is exclusive
  });
});

describe("input gating and retry", () => {
  it("tap refuses an offline device with an actionable error naming serial and state", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5554\toffline\n" });
    const ctx = makeCtx(runner);
    const res = await tap(ctx, { x: 100, y: 200 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("emulator-5554");
    expect(textOf(res)).toContain("offline");
    runner.assertSatisfied();
  });

  it("tap retries once on a transient adb failure and succeeds on the second attempt", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5554\tdevice\n" });
    // Range gate probe (size unknown on this quirky device ⇒ never blocks).
    runner.expect(["adb", "-s", "emulator-5554", "shell", "wm", "size"], { exitCode: 1 });
    runner.expect(["adb", "-s", "emulator-5554", "shell", "input", "tap", "100", "200"], {
      exitCode: 1,
      stderr: "transient adb error",
    });
    runner.expect(["adb", "-s", "emulator-5554", "shell", "input", "tap", "100", "200"], {
      exitCode: 0,
    });
    const ctx = makeCtx(runner);
    const res = await tap(ctx, { x: 100, y: 200 });
    expect(res.isError).toBeFalsy();
    expect(runner.called("adb", "-s", "emulator-5554", "shell", "input", "tap", "100", "200")).toBe(
      true,
    );
    runner.assertSatisfied();
  });

  it("press_key maps the named app_switch key for the adb input channel", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5554\tdevice\n" });
    runner.expect(
      ["adb", "-s", "emulator-5554", "shell", "input", "keyevent", "187"],
      { exitCode: 0 },
    );
    const ctx = makeCtx(runner);
    const res = await pressKey(ctx, { key: "app_switch" });
    expect(res.isError).toBeFalsy();
    runner.assertSatisfied();
  });
});

describe("stuck-spawn end-to-end — SpawnTimeoutError surfaces as an actionable tool error", () => {
  // TimeoutRunner turns EVERY spawn into a SpawnTimeoutError carrying the
  // wrapper's real per-op SPAWN_TIMEOUTS entry — proving the FULL surfacing
  // path (handler → wrapper → runner timeout → safe() → isError result).
  const ctx = makeCtx(new TimeoutRunner());

  it("list_devices surfaces a stuck discovery spawn within the configured timeout", async () => {
    const res = await listDevices(ctx, {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("adb devices -l timed out after 10000ms");
    expect(textOf(res)).toMatch(/retry or raise the timeout/);
  });

  it("emulator_list surfaces a stuck lifecycle spawn instead of blocking", async () => {
    const res = await emulatorList(ctx, {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("android emulator list --long timed out after 30000ms");
  });

  it("get_ui_tree surfaces a stuck layout spawn instead of blocking", async () => {
    const res = await getUiTree(ctx, { device: "emulator-5554" });
    expect(res.isError).toBe(true);
    // The hung `android layout` falls back to the XML path; the stuck
    // `adb uiautomator dump` — the requirement's OTHER layout subprocess,
    // guarded by the same SPAWN_TIMEOUTS.layout entry — is what surfaces.
    expect(textOf(res)).toContain("uiautomator dump");
    expect(textOf(res)).toContain("timed out after 15000ms");
    expect(textOf(res)).toMatch(/retry or raise the timeout/);
  });

  it("take_screenshot surfaces a stuck capture spawn (through the adb screencap fallback)", async () => {
    const res = await takeScreenshot(ctx, { device: "emulator-5554" });
    expect(res.isError).toBe(true);
    // The CLI capture timed out, the adb screencap fallback timed out too —
    // the actionable screencap error is what reaches the caller.
    expect(textOf(res)).toContain("screencap");
    expect(textOf(res)).toContain("timed out after 30000ms");
  });

  it("read_logcat surfaces a stuck logcat dump instead of blocking", async () => {
    const res = await readLogcat(ctx, { device: "emulator-5554" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("logcat -d");
    expect(textOf(res)).toContain("timed out after 15000ms");
  });
});

describe("createContext production factory", () => {
  it("builds a context bound to BunCommandRunner with an empty baseline set", async () => {
    const ctx = createContext();
    expect(ctx.baselineEstablished.size).toBe(0);
    expect(ctx.cli).toBeInstanceOf(AndroidCli);
    expect(ctx.adb).toBeInstanceOf(AdbWrapper);
    expect(typeof ctx.readFile).toBe("function");
  });
});
