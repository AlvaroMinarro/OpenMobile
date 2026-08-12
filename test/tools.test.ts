import { describe, expect, it } from "bun:test";
import { AndroidCli } from "../src/device/androidCli";
import { AdbWrapper } from "../src/device/adb";
import { MemoryRunner } from "./helpers/memoryRunner";
import {
  listDevices,
  emulatorList,
  emulatorStart,
  getUiTreeDiff,
  resolveScreenLabels,
  tap,
  pressKey,
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
    runner.expect(["android", "emulator", "list"], { stdout: "* Pixel_9_Pro\n" });
    runner.expect(["android", "info", "version"], { stdout: "android 1.0.15985488\n" });
    const ctx = makeCtx(runner);
    const res = await listDevices(ctx, {});
    const parsed = JSON.parse(textOf(res)) as {
      devices: Array<{ serial: string; state: string; model?: string }>;
      avds: Array<{ name: string; running: boolean }>;
      cliVersion: string;
    };
    expect(parsed.devices[0]).toEqual({
      serial: "emulator-5554",
      state: "device",
      model: "Pixel_9_Pro",
    });
    expect(parsed.avds[0]).toEqual({ name: "Pixel_9_Pro", running: true });
    expect(parsed.cliVersion).toContain("1.0");
    runner.assertSatisfied();
  });

  it("returns an empty device list (not an error) when nothing is attached", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "devices", "-l"], { stdout: "List of devices attached\n" });
    runner.expect(["android", "emulator", "list"], { stdout: "" });
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
    runner.expect(["android", "emulator", "list"], {
      stdout: "* Pixel_9_Pro\nMedium_Phone_API_36.1\n",
    });
    const ctx = makeCtx(runner);
    const res = await emulatorList(ctx, {});
    const parsed = JSON.parse(textOf(res)) as { avds: unknown[] };
    expect(parsed.avds).toEqual([
      { name: "Pixel_9_Pro", running: true },
      { name: "Medium_Phone_API_36.1", running: false },
    ]);
    runner.assertSatisfied();
  });
});

describe("emulator_start — CLI-delegated readiness gated on adb state 'device'", () => {
  it("starts the AVD and reports success once adb reports state 'device'", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "emulator", "list"], { stdout: "Pixel_9_Pro\n" });
    runner.expect(["android", "emulator", "start", "Pixel_9_Pro"], { exitCode: 0 });
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5554\tdevice\n" });
    const ctx = makeCtx(runner, 100);
    const res = await emulatorStart(ctx, {}); // no name => single AVD
    const parsed = JSON.parse(textOf(res)) as { started: string; serial: string };
    expect(parsed.started).toBe("Pixel_9_Pro");
    expect(parsed.serial).toBe("emulator-5554");
    runner.assertSatisfied();
  });

  it("returns an actionable error when the device never reaches 'device' within the timeout", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "emulator", "list"], { stdout: "Pixel_9_Pro\n" });
    runner.expect(["android", "emulator", "start", "Pixel_9_Pro"], { exitCode: 0 });
    // adb keeps reporting offline so readiness never flips within the tiny timeout
    runner.expect(["adb", "devices", "-l"], { stdout: "emulator-5554\toffline\n" });
    const ctx = makeCtx(runner, 60);
    const res = await emulatorStart(ctx, {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Pixel_9_Pro");
    expect(textOf(res)).toContain("offline");
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
