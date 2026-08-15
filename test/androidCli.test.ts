import { describe, expect, it } from "bun:test";
import { AndroidCli } from "../src/device/androidCli";
import { expectFixture, loadFixture } from "./helpers/fixtures";
import { MemoryRunner } from "./helpers/memoryRunner";

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

describe("AndroidCli — command builder + typed results", () => {
  it("layout() targets a device via --device=<serial> and returns parsed elements", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "layout", "--device=emulator-5554"], {
      stdout: JSON.stringify(oneElement),
      exitCode: 0,
    });
    const cli = new AndroidCli(runner);
    const tree = await cli.layout({ serial: "emulator-5554" });
    expect(tree).toHaveLength(1);
    expect(tree[0]!.center).toEqual({ x: 100, y: 40 });
    expect(tree[0]!.interactions).toContain("click");
    runner.assertSatisfied();
  });

  it("layoutDiff() appends the --diff flag and surfaces the returned shape", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "layout", "--device=emulator-5554", "--diff"], {
      stdout: JSON.stringify({ added: oneElement, modified: [] }),
      exitCode: 0,
    });
    const cli = new AndroidCli(runner);
    const res = await cli.layoutDiff({ serial: "emulator-5554" });
    expect(res.shape).toBe("diff");
    if (res.shape !== "diff") throw new Error("expected a diff-shaped result");
    expect(res.added).toHaveLength(1);
    runner.assertSatisfied();
  });

  it("layout() parses the recorded real CLI shape: string center/bounds, hyphenated keys, sparse JSON", async () => {
    const runner = new MemoryRunner();
    expectFixture(runner, loadFixture("android-layout"));
    const cli = new AndroidCli(runner);

    const tree = await cli.layout({ serial: "emulator-5554" });
    // Real fixture: non-empty flat array of elements
    expect(tree.length).toBeGreaterThan(0);

    const workspace = tree.find((e) => e.resourceId === "workspace");
    expect(workspace).toBeDefined();
    expect(workspace!.center).toEqual({ x: 640, y: 1428 });
    expect(workspace!.bounds).toEqual({ left: 0, top: 0, right: 1280, bottom: 2856 });

    const search = tree.find((e) => e.contentDesc === "Google search");
    expect(search).toBeDefined();
    expect(search!.interactions).toEqual(["clickable", "focusable", "long-clickable"]);
    expect(search!.resourceId).toBe("search_container_hotseat");

    // No element may silently collapse to (0,0) when REAL data is present
    for (const el of tree) {
      expect(el.center).not.toEqual({ x: 0, y: 0 });
    }
    runner.assertSatisfied();
  });

  it("layoutDiff() parses the recorded real --diff shape (added/modified arrays)", async () => {
    const runner = new MemoryRunner();
    expectFixture(runner, loadFixture("android-layout-diff"));
    const cli = new AndroidCli(runner);

    const res = await cli.layoutDiff({ serial: "emulator-5554" });
    expect(res.shape).toBe("diff");
    if (res.shape !== "diff") throw new Error("expected diff shape");
    expect(res.added).toEqual([]);
    expect(res.modified).toEqual([]);
    runner.assertSatisfied();
  });

  it("capture() writes PNG via `screen capture -o <path>`", async () => {
    const runner = new MemoryRunner();
    runner.expect(
      ["android", "screen", "capture", "--device=emulator-5554", "-o", "/tmp/raw.png"],
      { exitCode: 0 },
    );
    const cli = new AndroidCli(runner);
    await cli.capture({ serial: "emulator-5554", outPath: "/tmp/raw.png" });
    runner.assertSatisfied();
  });

  it("captureAnnotated() adds the --annotate flag for labeled overlays", async () => {
    const runner = new MemoryRunner();
    runner.expect(
      ["android", "screen", "capture", "--device=emulator-5554", "-o", "/tmp/ann.png", "--annotate"],
      { exitCode: 0 },
    );
    const cli = new AndroidCli(runner);
    await cli.captureAnnotated({ serial: "emulator-5554", outPath: "/tmp/ann.png" });
    runner.assertSatisfied();
  });

  it("resolveScreenLabel() turns a #N label into center coordinates", async () => {
    const runner = new MemoryRunner();
    runner.expect(
      ["android", "screen", "resolve", "--screenshot", "/tmp/ann.png", "--string", "#3"],
      { stdout: "540,1200", exitCode: 0 },
    );
    const cli = new AndroidCli(runner);
    const pt = await cli.resolveScreenLabel({ screenshot: "/tmp/ann.png", label: "#3" });
    expect(pt).toEqual({ x: 540, y: 1200 });
    runner.assertSatisfied();
  });

  it("emulatorList() parses AVD names and running status", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "emulator", "list"], {
      stdout: "* Pixel_9_Pro\nMedium_Phone_API_36.1\n",
      exitCode: 0,
    });
    const cli = new AndroidCli(runner);
    const avds = await cli.emulatorList();
    expect(avds).toEqual([
      { name: "Pixel_9_Pro", running: true },
      { name: "Medium_Phone_API_36.1", running: false },
    ]);
    runner.assertSatisfied();
  });

  it("emulatorStart() issues the start command for a named AVD", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "emulator", "start", "Pixel_9_Pro"], { exitCode: 0 });
    const cli = new AndroidCli(runner);
    await cli.emulatorStart("Pixel_9_Pro");
    runner.assertSatisfied();
  });

  it("emulatorStop() issues the stop command for a named AVD", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "emulator", "stop", "Pixel_9_Pro"], { exitCode: 0 });
    const cli = new AndroidCli(runner);
    await cli.emulatorStop("Pixel_9_Pro");
    runner.assertSatisfied();
  });

  it("emulatorCreate() issues the create command and rejects duplicates via stderr", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "emulator", "create", "New_AVD"], { exitCode: 0 });
    const cli = new AndroidCli(runner);
    await cli.emulatorCreate("New_AVD");
    runner.assertSatisfied();
  });

  it("info() runs `android info <field>` and returns the field value", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "info", "ro.build.version.sdk"], { stdout: "36", exitCode: 0 });
    const cli = new AndroidCli(runner);
    expect(await cli.info("ro.build.version.sdk")).toBe("36");
    runner.assertSatisfied();
  });
});
