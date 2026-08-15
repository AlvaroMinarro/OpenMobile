import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  getUiTreeDiff,
  resolveScreenLabels,
  takeScreenshot,
  getAnnotatedScreen,
  tempPngPath,
  tap,
  pressKey,
  deployApp,
} from "../src/tools/handlers";
import { createContext } from "../src/tools/context";
import type { DeviceContext } from "../src/tools/context";

function makeCtx(runner: MemoryRunner, timeoutMs = 200): DeviceContext {
  const cli = new AndroidCli(runner);
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

describe("emulator_start — correlates the STARTED emulator (D5: never first state=device)", () => {
  const listOne =
    "AVD ID            AVD Name       API Level    Status   Serial\nPixel_9_Pro       Pixel 9 Pro    android-36   Offline\n";

  it("starts the single AVD (no name) and waits for the reported serial to reach 'device'", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "emulator", "list", "--long"], { stdout: listOne });
    runner.expect(["adb", "devices", "-l"], { stdout: "List of devices attached\n" }); // pre-start snapshot
    runner.expect(["android", "emulator", "start", "Pixel_9_Pro"], { exitCode: 0 }); // no marker => fallback
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5557\tdevice\n" }); // post-start: NEW serial
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5557\tdevice\n" }); // readiness poll
    const ctx = makeCtx(runner, 200);
    const res = await emulatorStart(ctx, {});
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({ started: "Pixel_9_Pro", serial: "emulator-5557" });
    runner.assertSatisfied();
  });

  it("polls the serial named in the CLI 'started as' marker, ignoring an already-attached device", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "emulator", "list", "--long"], { stdout: listOne });
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5556\tdevice\n" }); // OTHER device is already device
    runner.expect(["android", "emulator", "start", "Pixel_9_Pro"], {
      stdout: "Virtual device successfully started as 'emulator-5554'.\n",
    });
    runner.expect(["adb", "devices", "-l"], {
      stdout: "emulator-5556\tdevice\nemulator-5554\toffline\n",
    });
    runner.expect(["adb", "devices", "-l"], {
      stdout: "emulator-5556\tdevice\nemulator-5554\tdevice\n",
    });
    const ctx = makeCtx(runner, 400);
    const res = await emulatorStart(ctx, { name: "Pixel_9_Pro" });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res)) as { started: string; serial: string };
    expect(parsed.started).toBe("Pixel_9_Pro");
    expect(parsed.serial).toBe("emulator-5554"); // NOT emulator-5556
    runner.assertSatisfied();
  });

  it("falls back to the new emulator-* serial diff when the CLI prints no marker", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "emulator", "list", "--long"], { stdout: listOne });
    runner.expect(["adb", "devices", "-l"], { stdout: "List of devices attached\n" });
    runner.expect(["android", "emulator", "start", "Pixel_9_Pro"], { exitCode: 0 });
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5554\tdevice\n" }); // new serial appears
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5554\tdevice\n" });
    const ctx = makeCtx(runner, 300);
    const res = await emulatorStart(ctx, { name: "Pixel_9_Pro" });
    const parsed = JSON.parse(textOf(res)) as { serial: string };
    expect(parsed.serial).toBe("emulator-5554");
    runner.assertSatisfied();
  });

  it("returns an actionable error when the started serial never reaches 'device'", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "emulator", "list", "--long"], { stdout: listOne });
    runner.expect(["adb", "devices", "-l"], { stdout: "List of devices attached\n" });
    runner.expect(["android", "emulator", "start", "Pixel_9_Pro"], { exitCode: 0 });
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5554\toffline\n" }); // post-start snapshot
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5554\toffline\n" }); // readiness poll
    const ctx = makeCtx(runner, 60);
    const res = await emulatorStart(ctx, { name: "Pixel_9_Pro" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Pixel_9_Pro");
    expect(textOf(res)).toContain("emulator-5554");
    expect(textOf(res)).toContain("offline");
    runner.assertSatisfied();
  });

  it("refuses success when no serial can be correlated (no marker, no new emulator-* device)", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "emulator", "list", "--long"], { stdout: listOne });
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5556\tdevice\n" });
    runner.expect(["android", "emulator", "start", "Pixel_9_Pro"], { exitCode: 0 });
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5556\tdevice\n" }); // nothing new appears
    const ctx = makeCtx(runner, 200);
    const res = await emulatorStart(ctx, { name: "Pixel_9_Pro" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Pixel_9_Pro");
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

describe("createContext production factory", () => {
  it("builds a context bound to BunCommandRunner with an empty baseline set", async () => {
    const ctx = createContext();
    expect(ctx.baselineEstablished.size).toBe(0);
    expect(ctx.cli).toBeInstanceOf(AndroidCli);
    expect(ctx.adb).toBeInstanceOf(AdbWrapper);
    expect(typeof ctx.readFile).toBe("function");
  });
});
