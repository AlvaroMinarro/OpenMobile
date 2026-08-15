import { describe, expect, it } from "bun:test";
import { AdbWrapper, deviceShotPath } from "../src/device/adb";
import { InputError } from "../src/device/input";
import { expectFixture, loadFixture } from "./helpers/fixtures";
import { MemoryRunner } from "./helpers/memoryRunner";

describe("AdbWrapper — devices/state, logcat, screencap, uiautomator, input channel", () => {
  it("devices() parses `adb devices -l` into serial + state + model", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "devices", "-l"], {
      stdout:
        "List of devices attached\nemulator-5554\tdevice product:sdk_gphone model:Pixel_9_Pro device:pixel_9_pro\na1b2c3d4\toffline\n",
      exitCode: 0,
    });
    const adb = new AdbWrapper(runner);
    const devices = await adb.devices();
    expect(devices).toEqual([
      { serial: "emulator-5554", state: "device", model: "Pixel_9_Pro" },
      { serial: "a1b2c3d4", state: "offline" },
    ]);
    runner.assertSatisfied();
  });

  it("serializes to a specific device with -s <serial> for shell input", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", "emulator-5554", "shell", "input", "tap", "540", "1200"], {
      exitCode: 0,
    });
    const adb = new AdbWrapper(runner);
    await adb.inputTap("emulator-5554", 540, 1200);
    runner.assertSatisfied();
  });

  it("inputText() escapes spaces as %s for adb shell", async () => {
    const runner = new MemoryRunner();
    runner.expect(
      ["adb", "-s", "emulator-5554", "shell", "input", "text", "hello%sworld"],
      { exitCode: 0 },
    );
    const adb = new AdbWrapper(runner);
    await adb.inputText("emulator-5554", "hello world");
    runner.assertSatisfied();
  });

  it("inputText() rejects characters adb cannot inject", async () => {
    const runner = new MemoryRunner();
    const adb = new AdbWrapper(runner);
    expect(() => adb.inputText("emulator-5554", "line\nbreak")).toThrow(InputError);
    expect(runner.calls.length).toBe(0);
  });

  it("inputSwipe() builds the four-coordinate swipe with optional duration", async () => {
    const runner = new MemoryRunner();
    runner.expect(
      ["adb", "-s", "emulator-5554", "shell", "input", "swipe", "540", "1800", "540", "600", "300"],
      { exitCode: 0 },
    );
    const adb = new AdbWrapper(runner);
    await adb.inputSwipe("emulator-5554", 540, 1800, 540, 600, 300);
    runner.assertSatisfied();
  });

  it("inputKeyevent() maps a named key like back to a keycode", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", "emulator-5554", "shell", "input", "keyevent", "4"], {
      exitCode: 0,
    });
    const adb = new AdbWrapper(runner);
    await adb.inputKeyevent("emulator-5554", "back");
    runner.assertSatisfied();
  });

  it("logcat() scopes to a pid, defaults to errors-only, and bounds + notes truncation", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", "emulator-5554", "logcat", "-d", "-t", "100", "-v", "time", "E:*", "--pid", "1234"], {
      stdout: [
        "08-12 17:00:00.000  1234  1234 I/Tag( 1234): info line",
        "08-12 17:00:01.000  1234  1234 E/Tag( 1234): error line",
        "08-12 17:00:02.000  1234  1234 W/Tag( 1234): warn line",
        "08-12 17:00:03.000  1234  1234 E/Tag( 1234): second error",
      ].join("\n"),
      exitCode: 0,
    });
    const adb = new AdbWrapper(runner);
    const res = await adb.logcat("emulator-5554", { pid: 1234, priority: "E", tail: 100 });
    expect(res.lines.some((l) => l.includes("E/Tag( 1234): error line"))).toBe(true);
    expect(res.lines.some((l) => l.includes("I/Tag( 1234): info line"))).toBe(false);
    expect(res.lines.some((l) => l.includes("W/Tag( 1234): warn line"))).toBe(false);
    expect(res.truncated).toBe(false);
    runner.assertSatisfied();
  });

  it("logcat() truncates to the tail bound and flags it", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", "emulator-5554", "logcat", "-d", "-t", "2", "-v", "time", "E:*"], {
      // Real line shape (P/Tag( pid):) so the in-process priority regex matches
      stdout: [
        "08-12 17:00:01.000  1234  1234 E/Tag( 1234): one",
        "08-12 17:00:02.000  1234  1234 E/Tag( 1234): two",
        "08-12 17:00:03.000  1234  1234 E/Tag( 1234): three",
      ].join("\n"),
      exitCode: 0,
    });
    const adb = new AdbWrapper(runner);
    const res = await adb.logcat("emulator-5554", { priority: "E", tail: 2 });
    expect(res.lines).toEqual([
      "08-12 17:00:03.000  1234  1234 E/Tag( 1234): three",
      "08-12 17:00:02.000  1234  1234 E/Tag( 1234): two",
    ]);
    expect(res.truncated).toBe(true);
    runner.assertSatisfied();
  });

  it("logcat() dumps a bounded tail (`-d -t N`) of the recorded real output", async () => {
    const runner = new MemoryRunner();
    // Play the RECORDED stdout (real line shapes) through the wrapper's argv
    // (default tail 100, native priority filter). The envelope's own argv was
    // recorded with `-t 20 *:D`; what matters is that the real line shape
    // flows through the bounded read.
    runner.expect(["adb", "-s", "emulator-5554", "logcat", "-d", "-t", "100", "-v", "time"], {
      stdout: loadFixture("adb-logcat-d-t").stdout,
      exitCode: 0,
    });
    const adb = new AdbWrapper(runner);
    const res = await adb.logcat("emulator-5554", { tail: 100 });

    // The recorded dump fits the requested bound: a bounded read succeeded
    // (no truncation flag) and returned real lines newest-first.
    expect(res.lines.length).toBeGreaterThan(0);
    expect(res.truncated).toBe(false);
    // Real line shape: "MM-DD HH:MM:SS.mmm P/Tag(  pid): msg"
    expect(res.lines[0]).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [VDIWEFS]\//);
    runner.assertSatisfied();
  });

  it("logcat() filters by priority on the real line shape (P/Tag, no trailing space)", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", "emulator-5554", "logcat", "-d", "-t", "100", "-v", "time", "W:*"], {
      stdout: loadFixture("adb-logcat-d-t").stdout,
      exitCode: 0,
    });
    const adb = new AdbWrapper(runner);
    const res = await adb.logcat("emulator-5554", { priority: "W", tail: 100 });

    expect(res.lines.length).toBeGreaterThan(0);
    for (const line of res.lines) {
      expect(line).toMatch(/\sW\//);
    }
    expect(res.lines.some((l) => l.includes("IPCThreadState"))).toBe(true);
    runner.assertSatisfied();
  });

  it("logcat() drops buffer headers under a priority filter (no priority token)", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", "emulator-5554", "logcat", "-d", "-t", "100", "-v", "time", "E:*"], {
      stdout: loadFixture("adb-logcat-d-t").stdout,
      exitCode: 0,
    });
    const adb = new AdbWrapper(runner);
    const res = await adb.logcat("emulator-5554", { priority: "E", tail: 100 });
    // The recorded dump holds D/I/W lines but no E lines: the priority filter
    // drops EVERYTHING without a priority token — including the buffer headers.
    expect(res.lines.length).toBe(0);
    expect(res.lines.some((l) => l.includes("beginning of"))).toBe(false);
    runner.assertSatisfied();
  });

  it("screencap() shell-captures to a UNIQUE device path, pulls, then removes the device file", async () => {
    const devicePath = "/sdcard/om_shot_abc123.png"; // explicit for deterministic argv
    const runner = new MemoryRunner();
    runner.expect(
      ["adb", "-s", "emulator-5554", "shell", "screencap", "-p", devicePath],
      { exitCode: 0 },
    );
    runner.expect(["adb", "-s", "emulator-5554", "pull", devicePath, "/tmp/raw.png"], {
      exitCode: 0,
    });
    runner.expect(["adb", "-s", "emulator-5554", "shell", "rm", "-f", devicePath], {
      exitCode: 0,
    });
    const adb = new AdbWrapper(runner);
    await adb.screencap("emulator-5554", "/tmp/raw.png", devicePath);
    runner.assertSatisfied();
  });

  it("deviceShotPath() returns unique device-side paths (no fixed /sdcard/om_shot.png)", async () => {
    const a = deviceShotPath();
    const b = deviceShotPath();
    expect(a).toMatch(/^\/sdcard\/om_shot_\w{6}\.png$/);
    expect(b).toMatch(/^\/sdcard\/om_shot_\w{6}\.png$/);
    expect(a).not.toBe(b);
  });

  it("screencap() removes the device file even when the pull fails", async () => {
    const devicePath = "/sdcard/om_shot_fail123.png";
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", "emulator-5554", "shell", "screencap", "-p", devicePath], {
      exitCode: 0,
    });
    runner.expect(["adb", "-s", "emulator-5554", "pull", devicePath, "/tmp/raw.png"], {
      exitCode: 1,
      stderr: "pull exploded",
    });
    runner.expect(["adb", "-s", "emulator-5554", "shell", "rm", "-f", devicePath], {
      exitCode: 0,
    });
    const adb = new AdbWrapper(runner);
    await expect(adb.screencap("emulator-5554", "/tmp/raw.png", devicePath)).rejects.toThrow(
      "pull exploded",
    );
    runner.assertSatisfied();
  });

  it("getprop() runs `adb shell getprop` for a single property and returns its trimmed value", async () => {
    const runner = new MemoryRunner();
    runner.expect(
      ["adb", "-s", "emulator-5554", "shell", "getprop", "ro.build.version.sdk"],
      { stdout: "36\n" },
    );
    const adb = new AdbWrapper(runner);
    expect(await adb.getprop("emulator-5554", "ro.build.version.sdk")).toBe("36");
    runner.assertSatisfied();
  });

  it("wm() returns parsed physical size and density from `wm size`/`wm density` output", async () => {
    const runner = new MemoryRunner();
    runner.expect(
      ["adb", "-s", "emulator-5554", "shell", "wm", "size"],
      { stdout: "Physical size: 1280x2856\n" },
    );
    runner.expect(
      ["adb", "-s", "emulator-5554", "shell", "wm", "density"],
      { stdout: "Physical density: 480\n" },
    );
    const adb = new AdbWrapper(runner);
    expect(await adb.wm("emulator-5554")).toEqual({ size: "1280x2856", density: "480" });
    runner.assertSatisfied();
  });

  it("wm() returns undefined fields when the device reports no physical values", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", "emulator-5554", "shell", "wm", "size"], { stdout: "" });
    runner.expect(["adb", "-s", "emulator-5554", "shell", "wm", "density"], { stdout: "" });
    const adb = new AdbWrapper(runner);
    expect(await adb.wm("emulator-5554")).toEqual({ size: undefined, density: undefined });
    runner.assertSatisfied();
  });

  it("uiautomatorDump() reads XML from the device's window dump path", async () => {
    const runner = new MemoryRunner();
    runner.expect(
      ["adb", "-s", "emulator-5554", "shell", "uiautomator", "dump", "/sdcard/window_dump.xml"],
      { stdout: "UI hierchary dumped to: /sdcard/window_dump.xml", exitCode: 0 },
    );
    runner.expect(["adb", "-s", "emulator-5554", "shell", "cat", "/sdcard/window_dump.xml"], {
      stdout: "<hierarchy><node text=\"hi\"/></hierarchy>",
      exitCode: 0,
    });
    const adb = new AdbWrapper(runner);
    const xml = await adb.uiautomatorDump("emulator-5554");
    expect(xml).toContain("<hierarchy>");
    runner.assertSatisfied();
  });
});
