/**
 * Logcat follow-spawn contracts (bridge-surface-v2 Phase 4, tasks 4.1–4.2,
 * design D5).
 *
 * Task 4.1 pins the `adb -s <serial> logcat -T <n> -v time <filterspecs…>`
 * argv contract behind `AdbWrapper.logcatFollow`: argv-ARRAY spawn (no shell,
 * threat-matrix shell boundary), `[A-Za-z0-9._-]+` tag grammar, V..S priority
 * enum, incremental stdout→line callback, and `stop()` terminating the child.
 *
 * The real-spawn tests substitute a fake `adb` executable on PATH (a POSIX sh
 * shim that records its argv and streams scripted lines), so the production
 * spawn path is exercised end-to-end without requiring adb or a device.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdbWrapper, buildLogcatFollowArgv, parseLogcatTimeLine } from "../src/device/adb";
import type { CommandRunner } from "../src/device/runner";

/** Runner stub: logcatFollow spawns directly, the runner is unused there. */
const stubRunner = (): CommandRunner => ({
  run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
});

describe("logcatFollow argv contract (task 4.1)", () => {
  it("builds the exact argv array: adb -s <serial> logcat -T <n> -v time <filterspecs…>", () => {
    expect(
      buildLogcatFollowArgv("emulator-5554", {
        tail: 33,
        filterspecs: ["ActivityManager:W", "*:S"],
      }),
    ).toEqual(["adb", "-s", "emulator-5554", "logcat", "-T", "33", "-v", "time", "ActivityManager:W", "*:S"]);
  });

  it("omits -T entirely when tail is 0 (design D5: backlog=0 skips replay)", () => {
    expect(buildLogcatFollowArgv("emulator-5554", { tail: 0 })).toEqual([
      "adb",
      "-s",
      "emulator-5554",
      "logcat",
      "-v",
      "time",
    ]);
  });

  it("omits -T and filterspecs when no options are given", () => {
    expect(buildLogcatFollowArgv("emulator-5554")).toEqual([
      "adb",
      "-s",
      "emulator-5554",
      "logcat",
      "-v",
      "time",
    ]);
  });

  it("accepts the full legal tag grammar [A-Za-z0-9._-]+ inside filterspecs", () => {
    expect(() =>
      buildLogcatFollowArgv("emu-1", { filterspecs: ["System.err_2-x:E"] }),
    ).not.toThrow();
  });

  it("REJECTS a hostile filterspec before any argv is produced", () => {
    expect(() => buildLogcatFollowArgv("emu-1", { filterspecs: ['"; rm -rf"'] })).toThrow(
      /invalid filterspec/,
    );
  });

  it("REJECTS filterspecs with a priority outside the V..S enum", () => {
    expect(() => buildLogcatFollowArgv("emu-1", { filterspecs: ["Tag:X"] })).toThrow(
      /invalid filterspec/,
    );
    expect(() => buildLogcatFollowArgv("emu-1", { filterspecs: ["Tag:"] })).toThrow(
      /invalid filterspec/,
    );
  });

  it("REJECTS a serial with shell metacharacters", () => {
    expect(() => buildLogcatFollowArgv("emu;5554", {})).toThrow(/invalid serial/);
    expect(() => buildLogcatFollowArgv("$(id)", {})).toThrow(/invalid serial/);
    expect(() => buildLogcatFollowArgv("", {})).toThrow(/invalid serial/);
  });

  it("accepts colon/dot forms of real serials (tcp host:port, usb dots)", () => {
    expect(() => buildLogcatFollowArgv("127.0.0.1:5555", {})).not.toThrow();
    expect(() => buildLogcatFollowArgv("1A2B3C4D5E6F", {})).not.toThrow();
  });

  it("REJECTS a non-integer or negative -T count", () => {
    expect(() => buildLogcatFollowArgv("emu-1", { tail: 1.5 })).toThrow(/invalid -T count/);
    expect(() => buildLogcatFollowArgv("emu-1", { tail: -3 })).toThrow(/invalid -T count/);
  });
});

// ─── Real spawn behavior (fake `adb` shim on PATH) ───────────────────────

/** Directory holding the fake `adb`; cleaned up by withFakeAdbOnPath. */
let activeShimDir: string | null = null;

function makeAdbShim(dir: string): void {
  // Records its argv ($@ = args after the script name), streams two complete
  // lines around a split partial line, then lingers until signalled.
  const script = [
    "#!/bin/sh",
    'printf \'%s\\n\' "$@" >> "$OM_ADB_SHIM_ARGV"',
    "printf '08-22 14:03:11.123 E/System.err( 1234): boom one\\n'",
    "printf 'par'",
    "sleep 0.3",
    "printf 'tial\\nfull line\\n'",
    "exec sleep 30",
    "",
  ].join("\n");
  writeFileSync(join(dir, "adb"), script, { mode: 0o755 });
}

/**
 * Wedged-child shim (task 4.8 escalation): traps SIGTERM like a wedged adb,
 * reports its own pid on stdout, then lingers — bounded to ~15s so even a
 * failed assertion can never leak a permanent orphan into the suite.
 */
function makeSigtermIgnoringAdbShim(dir: string): void {
  const script = [
    "#!/bin/sh",
    "trap '' TERM",
    'printf \'pid %s\\n\' "$$"',
    "i=0",
    'while [ "$i" -lt 30 ]; do',
    "  i=$((i+1))",
    "  sleep 0.5",
    "done",
    "",
  ].join("\n");
  writeFileSync(join(dir, "adb"), script, { mode: 0o755 });
}

async function withFakeAdbOnPath<T>(
  fn: () => Promise<T>,
  shim: (dir: string) => void = makeAdbShim,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "openmobile-adb-shim-"));
  shim(dir);
  activeShimDir = dir;
  const prevPath = process.env.PATH;
  const prevArgvVar = process.env.OM_ADB_SHIM_ARGV;
  process.env.PATH = `${dir}:${prevPath ?? ""}`;
  process.env.OM_ADB_SHIM_ARGV = join(dir, "spawned-argv.log");
  try {
    return await fn();
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevArgvVar === undefined) delete process.env.OM_ADB_SHIM_ARGV;
    else process.env.OM_ADB_SHIM_ARGV = prevArgvVar;
    rmSync(dir, { recursive: true, force: true });
    activeShimDir = null;
  }
}

/** Spawned argv as recorded by the shim (args after the script name). */
async function readSpawnedArgv(logPath: string): Promise<string[]> {
  const text = await Bun.file(logPath).text();
  return text.split("\n").filter((l) => l.length > 0);
}

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(15);
  }
}

describe("logcatFollow live spawn (task 4.1, fake adb on PATH)", () => {
  it("streams stdout INCREMENTALLY to the line callback, joining split chunks", async () => {
    await withFakeAdbOnPath(async () => {
      const lines: string[] = [];
      const adb = new AdbWrapper(stubRunner());
      const handle = adb.logcatFollow("emulator-5554", { tail: 33 }, (l) => lines.push(l));
      try {
        await waitFor(() => lines.length >= 3);
        // "par" + "tial\n" arrived as separate stdout chunks but form ONE line.
        expect(lines).toEqual([
          "08-22 14:03:11.123 E/System.err( 1234): boom one",
          "partial",
          "full line",
        ]);
      } finally {
        await handle.stop();
      }
    });
  });

  it("spawns the EXACT contracted argv (observed through the shim)", async () => {
    await withFakeAdbOnPath(async () => {
      const argvLog = process.env.OM_ADB_SHIM_ARGV as string;
      const adb = new AdbWrapper(stubRunner());
      const handle = adb.logcatFollow(
        "emulator-5554",
        { tail: 33, filterspecs: ["System.err:E", "*:S"] },
        () => {},
      );
      try {
        await waitFor(() => existsSync(argvLog));
        // $@ excludes the interpreter name; "adb" itself is prepended by the builder.
        expect(await readSpawnedArgv(argvLog)).toEqual([
          "-s",
          "emulator-5554",
          "logcat",
          "-T",
          "33",
          "-v",
          "time",
          "System.err:E",
          "*:S",
        ]);
      } finally {
        await handle.stop();
      }
    });
  });

  it("stop() terminates the lingering child and resolves promptly", async () => {
    await withFakeAdbOnPath(async () => {
      const lines: string[] = [];
      const handle = new AdbWrapper(stubRunner()).logcatFollow("emulator-5554", {}, (l) =>
        lines.push(l),
      );
      await waitFor(() => lines.length >= 1);
      const t0 = Date.now();
      await handle.stop();
      // The shim ends in `sleep 30` — resolving well under that proves SIGTERM.
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(lines.length).toBeGreaterThan(0);
    });
  });

  it("rejects hostile input BEFORE spawning any process (zero shim invocations)", async () => {
    await withFakeAdbOnPath(async () => {
      const argvLog = process.env.OM_ADB_SHIM_ARGV as string;
      const adb = new AdbWrapper(stubRunner());
      expect(() => adb.logcatFollow("emu-1", { filterspecs: ['"; rm -rf"'] }, () => {})).toThrow(
        /invalid filterspec/,
      );
      expect(() => adb.logcatFollow("emu;1", {}, () => {})).toThrow(/invalid serial/);
      await Bun.sleep(50); // allow any (wrongly) spawned shim to record itself
      expect(existsSync(argvLog)).toBeFalse();
    });
  });

  // ─── SIGKILL escalation (task 4.8 teardown, Phase-5 authorized hunk) ─────

  it("forceStop() escalates to SIGKILL when the child ignores the graceful SIGTERM", async () => {
    await withFakeAdbOnPath(
      async () => {
        const lines: string[] = [];
        const handle = new AdbWrapper(stubRunner()).logcatFollow("emulator-5554", {}, (l) =>
          lines.push(l),
        );
        try {
          await waitFor(() => lines.length >= 1);
          // The production handle carries the escalation surface the hub's
          // grace timer fires — without it, teardown is SIGTERM-only.
          expect(typeof handle.forceStop).toBe("function");
          const pid = Number(/^pid (\d+)$/.exec(lines[0] ?? "")?.[1]);
          expect(Number.isInteger(pid)).toBeTrue();
          const alive = (): boolean => {
            try {
              process.kill(pid, 0); // signal 0 probes existence only
              return true;
            } catch {
              return false;
            }
          };
          expect(alive()).toBeTrue();
          // Graceful path FIRST, exactly like hub teardown: SIGTERM only…
          const stopping = handle.stop();
          await Bun.sleep(150);
          // …and this shim traps TERM, so it must still be alive.
          expect(alive()).toBeTrue();
          // The escalation reaps what the grace could not.
          await handle.forceStop!();
          await stopping;
          expect(alive()).toBeFalse();
        } finally {
          // Bounded shim self-exits; forceStop just reaps sooner.
          await handle.forceStop?.().catch(() => {});
        }
      },
      makeSigtermIgnoringAdbShim,
    );
  });

  it("forceStop() on a child that already exited resolves promptly without throwing", async () => {
    await withFakeAdbOnPath(async () => {
      const lines: string[] = [];
      const handle = new AdbWrapper(stubRunner()).logcatFollow("emulator-5554", {}, (l) =>
        lines.push(l),
      );
      await waitFor(() => lines.length >= 1);
      await handle.stop(); // standard shim honors SIGTERM → child reaped
      const t0 = Date.now();
      await handle.forceStop!(); // dead-child escalation: safe no-op
      expect(Date.now() - t0).toBeLessThan(5000);
    });
  });
});

describe("-v time line parser (task 4.2, extends priorityOf shape)", () => {
  it("parses a canonical record into {ts, priority, tag, pid, message}", () => {
    expect(parseLogcatTimeLine("08-22 14:03:11.123 E/System.err( 1234): boom")).toEqual({
      ts: "08-22 14:03:11.123",
      priority: "E",
      tag: "System.err",
      pid: 1234,
      message: "boom",
    });
  });

  it("handles tight pid parens and messages containing colons/parens", () => {
    const line =
      "01-02 03:04:05.678 I/ActivityManager(567): Start proc 1:com.app/u0:a99 for (extra): stuff";
    expect(parseLogcatTimeLine(line)).toEqual({
      ts: "01-02 03:04:05.678",
      priority: "I",
      tag: "ActivityManager",
      pid: 567,
      message: "Start proc 1:com.app/u0:a99 for (extra): stuff",
    });
  });

  it("preserves tags with dots/dashes/underscores and inner spaces in the message", () => {
    const parsed = parseLogcatTimeLine(
      "12-31 23:59:59.999 W/System.err_2-x(   42):   padded  message ",
    );
    expect(parsed?.tag).toBe("System.err_2-x");
    expect(parsed?.pid).toBe(42);
    // Single separator space consumed; the rest of the message is verbatim.
    expect(parsed?.message).toBe("  padded  message ");
  });

  it("parses every priority token V D I W E F S", () => {
    for (const p of ["V", "D", "I", "W", "E", "F", "S"] as const) {
      const parsed = parseLogcatTimeLine(`08-22 14:03:11.123 ${p}/Tag( 1): m`);
      expect(parsed?.priority).toBe(p);
    }
  });

  it("returns null for buffer headers, junk, continuations, and empty lines", () => {
    expect(parseLogcatTimeLine("--------- beginning of main")).toBeNull();
    expect(parseLogcatTimeLine("--------- beginning of system")).toBeNull();
    expect(parseLogcatTimeLine("logcat: read interrupted")).toBeNull();
    expect(parseLogcatTimeLine("\t at com.example.Foo.bar(Foo.java:1)")).toBeNull();
    expect(parseLogcatTimeLine("not-a-timestamp E/Tag( 1): m")).toBeNull();
    expect(parseLogcatTimeLine("")).toBeNull();
  });
});
