import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidCli, type SpawnedProcess } from "../src/device/androidCli";
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

  it("emulatorList() parses the recorded `--long` table: Online/Offline + serial", async () => {
    const runner = new MemoryRunner();
    expectFixture(runner, loadFixture("android-emulator-list-long"));
    const cli = new AndroidCli(runner);
    const avds = await cli.emulatorList();
    expect(avds).toEqual([
      { name: "Medium_Phone_API_36.1", running: false },
      { name: "Pixel_9_Pro", running: true, serial: "emulator-5554" },
      { name: "Pixel_9_Pro_Fold", running: false },
    ]);
    runner.assertSatisfied();
  });

  it("emulatorList() reads the AVD ID column as the name (spaces only in the display name)", async () => {
    const runner = new MemoryRunner();
    expectFixture(runner, loadFixture("android-emulator-list-long"));
    const cli = new AndroidCli(runner);
    const avds = await cli.emulatorList();
    // "Pixel 9 Pro" display name contains spaces but the ID token is "Pixel_9_Pro"
    expect(avds.find((a) => a.running)?.name).toBe("Pixel_9_Pro");
    runner.assertSatisfied();
  });

describe("emulatorStart() — direct spawn with -grpc-allowlist (design D4/D6, -rtcfps ≥ 36.6)", () => {
  const SDK = "/opt/fake-sdk";
  const EMU = `${SDK}/emulator/emulator`;
  const VERSION_36_5 = "Android emulator version 36.5.11.0 (build_id 15261951) (CL:N/A)\n";
  const VERSION_36_6 = "Android emulator version 36.6.11.0 (build_id 16000000) (CL:N/A)\n";
  const LIST_OFFLINE =
    "AVD ID            AVD Name       API Level    Status   Serial\nPixel_9_Pro       Pixel 9 Pro    android-36   Offline\n";
  const LIST_ONLINE =
    "AVD ID            AVD Name       API Level    Status   Serial\nPixel_9_Pro       Pixel 9 Pro    android-36   Online   emulator-5554\n";

  /** Detached-spawn double: the emulator keeps running (exited stays pending). */
  function fakeSpawn(opts: { exitCode?: number } = {}): {
    spawn: (argv: string[]) => SpawnedProcess;
    calls: string[][];
  } {
    const calls: string[][] = [];
    return {
      calls,
      spawn: (argv: string[]) => {
        calls.push([...argv]);
        return {
          exited: opts.exitCode === undefined ? new Promise<number>(() => {}) : Promise.resolve(opts.exitCode),
          kill: () => {},
        };
      },
    };
  }

  /** Deterministic allowlist location for assertions; returns the tmp dir. */
  function allowlistDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "om-test-allowlist-"));
    process.env["OPENMOBILE_ALLOWLIST_DIR"] = dir;
    return dir;
  }

  function cleanup(dir?: string): void {
    delete process.env["OPENMOBILE_ALLOWLIST_DIR"];
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  it("spawns <sdk>/emulator/emulator @<avd> -grpc-allowlist <generated> directly (no `android emulator start`)", async () => {
    const dir = allowlistDir();
    try {
      const runner = new MemoryRunner();
      runner.expect(["android", "info", "sdk"], { stdout: `${SDK}\n` });
      runner.expect([EMU, "-version"], { stdout: VERSION_36_5 });
      runner.expect(["android", "emulator", "list", "--long"], { stdout: LIST_ONLINE });
      const { spawn, calls } = fakeSpawn();
      const cli = new AndroidCli(runner, spawn);
      const serial = await cli.emulatorStart("Pixel_9_Pro", { pollMs: 1 });
      expect(serial).toBe("emulator-5554");
      expect(calls).toHaveLength(1);
      const argv = calls[0]!;
      expect(argv[0]).toBe(EMU);
      expect(argv[1]).toBe("@Pixel_9_Pro");
      expect(argv).toContain("-grpc-allowlist");
      const flagIdx = argv.indexOf("-grpc-allowlist");
      expect(argv[flagIdx + 1]).toBe(join(dir, "om_allowlist.json"));
      // 36.5.11 has NO -rtcfps (unknown option — live-verified, design D6).
      expect(argv).not.toContain("-rtcfps");
      // The old CLI-mediated start is gone entirely.
      expect(runner.called("android", "emulator", "start", "Pixel_9_Pro")).toBe(false);
      runner.assertSatisfied();
    } finally {
      cleanup(dir);
    }
  });

  it("writes a usable allowlist permitting RtcService + reflection for the android-studio issuer", async () => {
    const dir = allowlistDir();
    try {
      const runner = new MemoryRunner();
      runner.expect(["android", "info", "sdk"], { stdout: `${SDK}\n` });
      runner.expect([EMU, "-version"], { stdout: VERSION_36_5 });
      runner.expect(["android", "emulator", "list", "--long"], { stdout: LIST_ONLINE });
      const { spawn } = fakeSpawn();
      const cli = new AndroidCli(runner, spawn);
      await cli.emulatorStart("Pixel_9_Pro", { pollMs: 1 });
      const written = JSON.parse(readFileSync(join(dir, "om_allowlist.json"), "utf8")) as {
        allowlist: Array<{ iss: string; allowed: string[] }>;
      };
      const entry = written.allowlist.find((e) => e.iss === "android-studio");
      expect(entry).toBeDefined();
      expect(entry!.allowed).toContain("/android.emulation.control.Rtc/.*");
      expect(entry!.allowed).toContain("/grpc.reflection.v1alpha.ServerReflection/.*");
      runner.assertSatisfied();
    } finally {
      cleanup(dir);
    }
  });

  it("adds -rtcfps 30 by default when the emulator is ≥ 36.6", async () => {
    const dir = allowlistDir();
    try {
      const runner = new MemoryRunner();
      runner.expect(["android", "info", "sdk"], { stdout: `${SDK}\n` });
      runner.expect([EMU, "-version"], { stdout: VERSION_36_6 });
      runner.expect(["android", "emulator", "list", "--long"], { stdout: LIST_ONLINE });
      const { spawn, calls } = fakeSpawn();
      const cli = new AndroidCli(runner, spawn);
      await cli.emulatorStart("Pixel_9_Pro", { pollMs: 1 });
      const argv = calls[0]!;
      const idx = argv.indexOf("-rtcfps");
      expect(idx).toBeGreaterThan(-1);
      expect(argv[idx + 1]).toBe("30");
      runner.assertSatisfied();
    } finally {
      cleanup(dir);
    }
  });

  it("honors an explicit fps: 60 for -rtcfps", async () => {
    const dir = allowlistDir();
    try {
      const runner = new MemoryRunner();
      runner.expect(["android", "info", "sdk"], { stdout: `${SDK}\n` });
      runner.expect([EMU, "-version"], { stdout: VERSION_36_6 });
      runner.expect(["android", "emulator", "list", "--long"], { stdout: LIST_ONLINE });
      const { spawn, calls } = fakeSpawn();
      const cli = new AndroidCli(runner, spawn);
      await cli.emulatorStart("Pixel_9_Pro", { fps: 60, pollMs: 1 });
      expect(calls[0]!.slice(calls[0]!.indexOf("-rtcfps") + 1)[0]).toBe("60");
      runner.assertSatisfied();
    } finally {
      cleanup(dir);
    }
  });

  it("rejects an fps outside {30, 60} BEFORE spawning anything", async () => {
    const dir = allowlistDir();
    try {
      const runner = new MemoryRunner();
      runner.expect(["android", "info", "sdk"], { stdout: `${SDK}\n` });
      runner.expect([EMU, "-version"], { stdout: VERSION_36_6 });
      const { spawn, calls } = fakeSpawn();
      const cli = new AndroidCli(runner, spawn);
      await expect(cli.emulatorStart("Pixel_9_Pro", { fps: 144, pollMs: 1 })).rejects.toThrow(/fps/);
      expect(calls).toHaveLength(0);
      runner.assertSatisfied();
    } finally {
      cleanup(dir);
    }
  });

  it("fails with an actionable version-gate error below 36.5.11 (names the requirement + upgrade path)", async () => {
    const dir = allowlistDir();
    try {
      const runner = new MemoryRunner();
      runner.expect(["android", "info", "sdk"], { stdout: `${SDK}\n` });
      runner.expect([EMU, "-version"], {
        stdout: "Android emulator version 36.4.9.0 (build_id 1) (CL:N/A)\n",
      });
      const { spawn, calls } = fakeSpawn();
      const cli = new AndroidCli(runner, spawn);
      await expect(cli.emulatorStart("Pixel_9_Pro", { pollMs: 1 })).rejects.toThrow(/36\.5\.11/);
      expect(calls).toHaveLength(0); // nothing launched below the gate
      runner.assertSatisfied();
    } finally {
      cleanup(dir);
    }
  });

  it("fails actionably when `emulator -version` output is unparseable", async () => {
    const dir = allowlistDir();
    try {
      const runner = new MemoryRunner();
      runner.expect(["android", "info", "sdk"], { stdout: `${SDK}\n` });
      runner.expect([EMU, "-version"], { stdout: "garbage\n" });
      const { spawn, calls } = fakeSpawn();
      const cli = new AndroidCli(runner, spawn);
      await expect(cli.emulatorStart("Pixel_9_Pro", { pollMs: 1 })).rejects.toThrow(/version/);
      expect(calls).toHaveLength(0);
      runner.assertSatisfied();
    } finally {
      cleanup(dir);
    }
  });

  it("polls `emulator list --long` until the AVD row reports Online with a serial", async () => {
    const dir = allowlistDir();
    try {
      const runner = new MemoryRunner();
      runner.expect(["android", "info", "sdk"], { stdout: `${SDK}\n` });
      runner.expect([EMU, "-version"], { stdout: VERSION_36_5 });
      runner.expect(["android", "emulator", "list", "--long"], { stdout: LIST_OFFLINE }); // still booting
      runner.expect(["android", "emulator", "list", "--long"], { stdout: LIST_ONLINE }); // registered
      const { spawn } = fakeSpawn();
      const cli = new AndroidCli(runner, spawn);
      expect(await cli.emulatorStart("Pixel_9_Pro", { pollMs: 1 })).toBe("emulator-5554");
      runner.assertSatisfied();
    } finally {
      cleanup(dir);
    }
  });

  it("throws an actionable error when the emulator process exits before registering a serial", async () => {
    const dir = allowlistDir();
    try {
      const runner = new MemoryRunner();
      runner.expect(["android", "info", "sdk"], { stdout: `${SDK}\n` });
      runner.expect([EMU, "-version"], { stdout: VERSION_36_5 });
      const { spawn } = fakeSpawn({ exitCode: 1 });
      const cli = new AndroidCli(runner, spawn);
      await expect(cli.emulatorStart("Pixel_9_Pro", { pollMs: 1 })).rejects.toThrow(/exited/);
      runner.assertSatisfied(); // no polling happened — the early exit won the race
    } finally {
      cleanup(dir);
    }
  });

  it("times out with an actionable error when the serial never registers", async () => {
    const dir = allowlistDir();
    try {
      const runner = new MemoryRunner();
      runner.expect(["android", "info", "sdk"], { stdout: `${SDK}\n` });
      runner.expect([EMU, "-version"], { stdout: VERSION_36_5 });
      const { spawn } = fakeSpawn();
      const cli = new AndroidCli(runner, spawn);
      // The unbounded poll loop would exhaust MemoryRunner expectations; the
      // list read is stubbed to a permanent Offline for this test only.
      cli.emulatorList = async () => [{ name: "Pixel_9_Pro", running: false }];
      await expect(cli.emulatorStart("Pixel_9_Pro", { pollMs: 1, timeoutMs: 25 })).rejects.toThrow(
        /did not register a serial/,
      );
    } finally {
      cleanup(dir);
    }
  });
});

  it("emulatorStop() issues the stop command for a named AVD", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "emulator", "stop", "Pixel_9_Pro"], { exitCode: 0 });
    const cli = new AndroidCli(runner);
    await cli.emulatorStop("Pixel_9_Pro");
    runner.assertSatisfied();
  });

  it("emulatorCreate() issues the create command for a new AVD (duplicate policy lives in the handler)", async () => {
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

  it("maps hyphenated off-screen key to offScreen (dual-shape like center/resource-id)", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "layout", "--device=emulator-5554"], {
      stdout: JSON.stringify([
        {
          center: "[640,1384]",
          "off-screen": "true",
          interactions: ["focusable"],
          text: "Below the fold",
        },
      ]),
      exitCode: 0,
    });
    const cli = new AndroidCli(runner);
    const tree = await cli.layout({ serial: "emulator-5554" });
    expect(tree).toHaveLength(1);
    expect(tree[0]!.offScreen).toBe(true);
    expect(tree[0]!.center).toEqual({ x: 640, y: 1384 });
    runner.assertSatisfied();
  });

  it("derives center from the bounds midpoint when an element has string bounds but no center", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "layout", "--device=emulator-5554"], {
      // Bounds-only element (Bounds-only spec scenario): NO center key at all.
      stdout: JSON.stringify([{ bounds: "[100,200][300,400]", interactions: ["click"] }]),
      exitCode: 0,
    });
    const cli = new AndroidCli(runner);
    const tree = await cli.layout({ serial: "emulator-5554" });
    expect(tree).toHaveLength(1);
    expect(tree[0]!.center).toEqual({ x: 200, y: 300 }); // midpoint of [100,200][300,400]
    expect(tree[0]!.targetable).toBeUndefined(); // parseable data ⇒ stays tappable
    runner.assertSatisfied();
  });

  it("derives center from the bounds midpoint for OBJECT-shaped bounds without a center too", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "layout", "--device=emulator-5554"], {
      stdout: JSON.stringify([
        { bounds: { left: 10, top: 20, right: 110, bottom: 120 }, interactions: ["click"] },
      ]),
      exitCode: 0,
    });
    const cli = new AndroidCli(runner);
    const tree = await cli.layout({ serial: "emulator-5554" });
    expect(tree[0]!.center).toEqual({ x: 60, y: 70 }); // midpoint of the object bounds
    runner.assertSatisfied();
  });

  it("marks elements with neither parseable center nor bounds as non-targetable (never silent (0,0))", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "layout", "--device=emulator-5554"], {
      stdout: JSON.stringify([{ center: "not-a-center", text: "Ghost" }]),
      exitCode: 0,
    });
    const cli = new AndroidCli(runner);
    const tree = await cli.layout({ serial: "emulator-5554" });
    expect(tree).toHaveLength(1);
    expect(tree[0]!.center).toEqual({ x: 0, y: 0 }); // MAY output (0,0)…
    expect(tree[0]!.targetable).toBe(false); // …but MUST record non-targetable
    runner.assertSatisfied();
  });

  it("unparseable center still falls back to parseable bounds and keeps the element targetable", async () => {
    const runner = new MemoryRunner();
    runner.expect(["android", "layout", "--device=emulator-5554"], {
      stdout: JSON.stringify([
        { center: "garbage", bounds: "[0,0][200,80]", text: "Rescued" },
      ]),
      exitCode: 0,
    });
    const cli = new AndroidCli(runner);
    const tree = await cli.layout({ serial: "emulator-5554" });
    expect(tree[0]!.center).toEqual({ x: 100, y: 40 }); // bounds midpoint wins
    expect(tree[0]!.targetable).toBeUndefined(); // NOT flagged non-targetable
    runner.assertSatisfied();
  });
});
