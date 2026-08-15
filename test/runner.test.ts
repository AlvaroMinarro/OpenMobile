import { describe, expect, it } from "bun:test";
import { exists } from "node:fs/promises";
import {
  BunCommandRunner,
  SPAWN_TIMEOUTS,
  SpawnTimeoutError,
} from "../src/device/runner";
import { AdbWrapper } from "../src/device/adb";
import { AndroidCli } from "../src/device/androidCli";
import { MemoryRunner } from "./helpers/memoryRunner";

describe("BunCommandRunner — per-spawn timeouts (D1)", () => {
  it("kills a hung spawn and throws SpawnTimeoutError carrying argv + timeoutMs", async () => {
    const runner = new BunCommandRunner();
    const argv = ["sleep", "5"];
    const started = Date.now();
    const err = await runner.run(argv, { timeoutMs: 50 }).catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    expect(err).toBeInstanceOf(SpawnTimeoutError);
    const timeoutErr = err as SpawnTimeoutError;
    expect(timeoutErr.argv).toEqual(argv);
    expect(timeoutErr.timeoutMs).toBe(50);
    expect(timeoutErr.message).toContain("sleep 5");
    expect(timeoutErr.message).toContain("50");
    expect(elapsed).toBeLessThan(2000); // did NOT wait for the 5s sleep
  });

  it("actually kills the timed-out process (no post-timeout side effects)", async () => {
    const marker = `/tmp/om-runner-timeout-${crypto.randomUUID()}`;
    const runner = new BunCommandRunner();
    const err = await runner
      .run(["sh", "-c", `sleep 0.2; touch ${marker}`], { timeoutMs: 50 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpawnTimeoutError);

    await new Promise((r) => setTimeout(r, 400)); // well past the inner sleep
    expect(await exists(marker)).toBe(false);
  });

  it("resolves normally when the command finishes within the timeout", async () => {
    const runner = new BunCommandRunner();
    const res = await runner.run(["echo", "hi"], { timeoutMs: 5000 });
    expect(res.stdout.trim()).toBe("hi");
    expect(res.exitCode).toBe(0);
  });

  it("runs without a timeout when opts are omitted", async () => {
    const runner = new BunCommandRunner();
    const res = await runner.run(["echo", "hi"]);
    expect(res.stdout.trim()).toBe("hi");
    expect(res.exitCode).toBe(0);
  });
});

describe("SPAWN_TIMEOUTS — D1 timeout table", () => {
  it("carries the design values for every operation key", () => {
    expect(SPAWN_TIMEOUTS.layout).toBe(15_000); // layout / uiautomator
    expect(SPAWN_TIMEOUTS.capture).toBe(30_000); // capture / screencap+pull
    expect(SPAWN_TIMEOUTS.logcatDump).toBe(15_000); // logcat -d
    expect(SPAWN_TIMEOUTS.devices).toBe(10_000); // devices / getprop / info
    expect(SPAWN_TIMEOUTS.input).toBe(10_000); // input ops
    expect(SPAWN_TIMEOUTS.emulatorManage).toBe(30_000); // list / stop / create
    expect(SPAWN_TIMEOUTS.emulatorStart).toBe(120_000); // start blocks until ready
    expect(SPAWN_TIMEOUTS.install).toBe(120_000); // install / run deploy
  });
});

describe("MemoryRunner — timeout-double support", () => {
  it("ignores opts behaviorally (playback unchanged when opts are passed)", async () => {
    const runner = new MemoryRunner();
    runner.expect(["echo", "hi"], { stdout: "hi\n" });
    const res = await runner.run(["echo", "hi"], { timeoutMs: 1234 });
    expect(res.stdout).toBe("hi\n");
    runner.assertSatisfied();
  });

  it("expectHang simulates a never-resolving subprocess", async () => {
    const runner = new MemoryRunner();
    const argv = ["adb", "-s", "emulator-5554", "shell", "sleep", "99"];
    runner.expectHang(argv);
    const settled = await Promise.race([
      runner.run(argv).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((r) => setTimeout(() => r("pending"), 50)),
    ]);
    expect(settled).toBe("pending");
    runner.assertSatisfied();
  });

  it("assertSatisfied flags an unconsumed hang expectation", () => {
    const runner = new MemoryRunner();
    runner.expectHang(["adb", "devices", "-l"]);
    expect(() => runner.assertSatisfied()).toThrow(/hang/);
  });
});

describe("Timeout wiring — wrappers pass their per-op SPAWN_TIMEOUTS entry (D1)", () => {
  it("AndroidCli maps each method to its timeout key", async () => {
    const runner = new MemoryRunner();
    const cli = new AndroidCli(runner);
    const serial = "emulator-5554";

    runner.expect(["android", "layout", `--device=${serial}`], { stdout: "[]" });
    await cli.layout({ serial });
    expect(runner.optsLog[0]?.timeoutMs).toBe(SPAWN_TIMEOUTS.layout);

    runner.expect(["android", "layout", `--device=${serial}`, "--diff"], {
      stdout: JSON.stringify({ added: [], modified: [] }),
    });
    await cli.layoutDiff({ serial });
    expect(runner.optsLog[1]?.timeoutMs).toBe(SPAWN_TIMEOUTS.layout);

    runner.expect(["android", "screen", "capture", `--device=${serial}`, "-o", "/tmp/a.png"], {});
    await cli.capture({ serial, outPath: "/tmp/a.png" });
    expect(runner.optsLog[2]?.timeoutMs).toBe(SPAWN_TIMEOUTS.capture);

    runner.expect(
      ["android", "screen", "capture", `--device=${serial}`, "-o", "/tmp/a.png", "--annotate"],
      {},
    );
    await cli.captureAnnotated({ serial, outPath: "/tmp/a.png" });
    expect(runner.optsLog[3]?.timeoutMs).toBe(SPAWN_TIMEOUTS.capture);

    runner.expect(
      ["android", "screen", "resolve", "--screenshot", "/tmp/a.png", "--string", "OK"],
      { stdout: "100, 200" },
    );
    await cli.resolveScreenLabel({ screenshot: "/tmp/a.png", label: "OK" });
    expect(runner.optsLog[4]?.timeoutMs).toBe(SPAWN_TIMEOUTS.capture);

    runner.expect(["android", "emulator", "list"], { stdout: "Pixel_9_Pro\n" });
    await cli.emulatorList();
    expect(runner.optsLog[5]?.timeoutMs).toBe(SPAWN_TIMEOUTS.emulatorManage);

    runner.expect(["android", "emulator", "start", "Pixel_9_Pro"], {});
    await cli.emulatorStart("Pixel_9_Pro");
    expect(runner.optsLog[6]?.timeoutMs).toBe(SPAWN_TIMEOUTS.emulatorStart);

    runner.expect(["android", "emulator", "stop", "Pixel_9_Pro"], {});
    await cli.emulatorStop("Pixel_9_Pro");
    expect(runner.optsLog[7]?.timeoutMs).toBe(SPAWN_TIMEOUTS.emulatorManage);

    runner.expect(["android", "emulator", "create", "Pixel_9_Pro"], {});
    await cli.emulatorCreate("Pixel_9_Pro");
    expect(runner.optsLog[8]?.timeoutMs).toBe(SPAWN_TIMEOUTS.emulatorManage);

    runner.expect(["android", "install", `--device=${serial}`, "/tmp/a.apk"], {});
    await cli.install({ serial, apk: "/tmp/a.apk" });
    expect(runner.optsLog[9]?.timeoutMs).toBe(SPAWN_TIMEOUTS.install);

    runner.expect(["android", "run", `--device=${serial}`, "/tmp/a.apk"], {});
    await cli.run({ serial, apk: "/tmp/a.apk" });
    expect(runner.optsLog[10]?.timeoutMs).toBe(SPAWN_TIMEOUTS.install);

    runner.expect(["android", "info", "version"], { stdout: "1.0.0\n" });
    await cli.info("version");
    expect(runner.optsLog[11]?.timeoutMs).toBe(SPAWN_TIMEOUTS.devices);

    runner.assertSatisfied();
  });

  it("a per-call timeoutMs override wins over the SPAWN_TIMEOUTS default", async () => {
    const runner = new MemoryRunner();
    const cli = new AndroidCli(runner);
    runner.expect(["android", "emulator", "start", "Pixel_9_Pro"], {});
    await cli.emulatorStart("Pixel_9_Pro", 300_000);
    expect(runner.optsLog[0]?.timeoutMs).toBe(300_000);
    runner.assertSatisfied();
  });

  it("AdbWrapper maps each method to its timeout key", async () => {
    const runner = new MemoryRunner();
    const adb = new AdbWrapper(runner);
    const serial = "emulator-5554";

    runner.expect(["adb", "devices", "-l"], { stdout: "List of devices attached\n" });
    await adb.devices();
    expect(runner.optsLog[0]?.timeoutMs).toBe(SPAWN_TIMEOUTS.devices);

    runner.expect(["adb", "-s", serial, "shell", "input", "tap", "100", "200"], {});
    await adb.inputTap(serial, 100, 200);
    expect(runner.optsLog[1]?.timeoutMs).toBe(SPAWN_TIMEOUTS.input);

    runner.expect(["adb", "-s", serial, "shell", "input", "keyevent", "4"], {});
    await adb.inputKeyevent(serial, "back");
    expect(runner.optsLog[2]?.timeoutMs).toBe(SPAWN_TIMEOUTS.input);

    runner.expect(["adb", "-s", serial, "logcat", "-d", "-v", "time"], { stdout: "" });
    await adb.logcat(serial);
    expect(runner.optsLog[3]?.timeoutMs).toBe(SPAWN_TIMEOUTS.logcatDump);

    runner.expect(["adb", "-s", serial, "install", "-r", "/tmp/a.apk"], {});
    await adb.install(serial, "/tmp/a.apk");
    expect(runner.optsLog[4]?.timeoutMs).toBe(SPAWN_TIMEOUTS.install);

    runner.expect(["adb", "-s", serial, "shell", "am", "start", "-n", "com.x/.Main"], {});
    await adb.amStart(serial, "com.x/.Main");
    expect(runner.optsLog[5]?.timeoutMs).toBe(SPAWN_TIMEOUTS.install);

    runner.expect(["adb", "-s", serial, "shell", "screencap", "-p", "/sdcard/om_shot.png"], {});
    runner.expect(["adb", "-s", serial, "pull", "/sdcard/om_shot.png", "/tmp/raw.png"], {});
    await adb.screencap(serial, "/tmp/raw.png");
    expect(runner.optsLog[6]?.timeoutMs).toBe(SPAWN_TIMEOUTS.capture);
    expect(runner.optsLog[7]?.timeoutMs).toBe(SPAWN_TIMEOUTS.capture);

    runner.expect(["adb", "-s", serial, "shell", "uiautomator", "dump", "/sdcard/window_dump.xml"], {
      stdout: "",
    });
    runner.expect(["adb", "-s", serial, "shell", "cat", "/sdcard/window_dump.xml"], {
      stdout: "<hierarchy/>",
    });
    await adb.uiautomatorDump(serial);
    expect(runner.optsLog[8]?.timeoutMs).toBe(SPAWN_TIMEOUTS.layout);
    expect(runner.optsLog[9]?.timeoutMs).toBe(SPAWN_TIMEOUTS.layout);

    runner.assertSatisfied();
  });
});
