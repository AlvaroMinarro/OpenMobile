import { describe, expect, it } from "bun:test";
import { exists } from "node:fs/promises";
import {
  BunCommandRunner,
  SPAWN_TIMEOUTS,
  SpawnTimeoutError,
} from "../src/device/runner";
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
