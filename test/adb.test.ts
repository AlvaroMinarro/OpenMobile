import { describe, expect, it } from "bun:test";
import { AdbWrapper } from "../src/device/adb";
import { InputError } from "../src/device/input";
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
    runner.expect(["adb", "-s", "emulator-5554", "logcat", "-v", "time", "--pid", "1234"], {
      stdout: [
        "08-12 17:00:00.000  1234  1234 I Tag: info line",
        "08-12 17:00:01.000  1234  1234 E Tag: error line",
        "08-12 17:00:02.000  1234  1234 W Tag: warn line",
        "08-12 17:00:03.000  1234  1234 E Tag: second error",
      ].join("\n"),
      exitCode: 0,
    });
    const adb = new AdbWrapper(runner);
    const res = await adb.logcat("emulator-5554", { pid: 1234, priority: "E", tail: 100 });
    expect(res.lines.some((l) => l.includes("E Tag: error line"))).toBe(true);
    expect(res.lines.some((l) => l.includes("I Tag: info line"))).toBe(false);
    expect(res.lines.some((l) => l.includes("W Tag: warn line"))).toBe(false);
    expect(res.truncated).toBe(false);
    runner.assertSatisfied();
  });

  it("logcat() truncates to the tail bound and flags it", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", "emulator-5554", "logcat", "-v", "time"], {
      stdout: ["...  E Tag: one", "...  E Tag: two", "...  E Tag: three"].join("\n"),
      exitCode: 0,
    });
    const adb = new AdbWrapper(runner);
    const res = await adb.logcat("emulator-5554", { priority: "E", tail: 2 });
    expect(res.lines).toEqual(["...  E Tag: three", "...  E Tag: two"]);
    expect(res.truncated).toBe(true);
    runner.assertSatisfied();
  });

  it("screencap() shell-captures to a device path then pulls to a local path", async () => {
    const runner = new MemoryRunner();
    runner.expect(
      ["adb", "-s", "emulator-5554", "shell", "screencap", "-p", "/sdcard/om_shot.png"],
      { exitCode: 0 },
    );
    runner.expect(["adb", "-s", "emulator-5554", "pull", "/sdcard/om_shot.png", "/tmp/raw.png"], {
      exitCode: 0,
    });
    const adb = new AdbWrapper(runner);
    await adb.screencap("emulator-5554", "/tmp/raw.png");
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
