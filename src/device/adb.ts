import { escapeForAdb } from "./input";
import { SPAWN_TIMEOUTS, type CommandRunner } from "./runner";
import type { Device, DeviceState, LogcatResult } from "./types";

export interface LogcatOptions {
  pid?: number;
  priority?: "V" | "D" | "I" | "W" | "E" | "F" | "S";
  tail?: number;
}

const KEYCODES: Record<string, string> = {
  back: "4",
  home: "3",
  menu: "82",
  enter: "66",
  del: "67",
  tab: "61",
  volume_up: "24",
  volume_down: "25",
  power: "26",
};

/** Extract a logcat priority token (V/D/I/W/E/F/S) from a `-v time` line. */
function priorityOf(line: string): string | null {
  const m = /\s([VDIWEFSW])\s/.exec(line);
  return m ? (m[1] as string) : null;
}

/**
 * Fallback device-interface layer wrapping `adb`: device enumeration/state,
 * logcat, screencap, uiautomator dump, and the adb shell input channel.
 * The official `android` CLI (`AndroidCli`) is the primary layer; this is the
 * fallback used when only adb is available.
 */
export class AdbWrapper {
  private readonly runner: CommandRunner;

  constructor(runner: CommandRunner) {
    this.runner = runner;
  }

  private async exec(argv: string[], timeoutMs: number): Promise<string> {
    const { stdout, stderr, exitCode } = await this.runner.run(argv, { timeoutMs });
    if (exitCode !== 0) {
      throw new Error(`adb failed (${argv.join(" ")}): ${stderr || stdout}`);
    }
    return stdout;
  }

  private async shell(serial: string, timeoutMs: number, ...args: string[]): Promise<string> {
    return this.exec(["adb", "-s", serial, "shell", ...args], timeoutMs);
  }

  /** Parse `adb devices -l` into serial + state + model. */
  async devices(): Promise<Device[]> {
    const stdout = await this.exec(["adb", "devices", "-l"], SPAWN_TIMEOUTS.devices);
    const devices: Device[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed === "List of devices attached") continue;
      const [serial, stateRaw, ...rest] = trimmed.split(/\s+/);
      if (!serial || !stateRaw) continue;
      const state: DeviceState = ["device", "unauthorized", "offline"].includes(stateRaw)
        ? (stateRaw as DeviceState)
        : "offline";
      const device: Device = { serial, state };
      const modelMatch = /\bmodel:(\S+)/.exec(rest.join(" "));
      if (modelMatch) device.model = modelMatch[1] as string;
      devices.push(device);
    }
    return devices;
  }

  async inputTap(serial: string, x: number, y: number): Promise<void> {
    await this.shell(serial, SPAWN_TIMEOUTS.input, "input", "tap", String(x), String(y));
  }

  /** Escape and inject text via `adb shell input text` (spaces → %s). */
  async inputText(serial: string, text: string): Promise<void> {
    const escaped = escapeForAdb(text);
    await this.shell(serial, SPAWN_TIMEOUTS.input, "input", "text", escaped);
  }

  async inputSwipe(
    serial: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration?: number,
  ): Promise<void> {
    const args = ["input", "swipe", String(x1), String(y1), String(x2), String(y2)];
    if (duration !== undefined) args.push(String(duration));
    await this.shell(serial, SPAWN_TIMEOUTS.input, ...args);
  }

  /** Inject a named key, resolved to a keycode (passes raw keycodes through). */
  async inputKeyevent(serial: string, key: string): Promise<void> {
    const keycode = KEYCODES[key] ?? key;
    await this.shell(serial, SPAWN_TIMEOUTS.input, "input", "keyevent", keycode);
  }

  /** Read logcat scoped by pid, filtered by priority, bounded to `tail`. */
  async logcat(serial: string, opts: LogcatOptions = {}): Promise<LogcatResult> {
    const args = ["adb", "-s", serial, "logcat", "-v", "time"];
    if (opts.pid !== undefined) args.push("--pid", String(opts.pid));
    const stdout = await this.exec(args, SPAWN_TIMEOUTS.logcatDump);

    let lines = stdout.split("\n").filter((l) => l.trim() !== "");
    if (opts.priority) {
      const target = opts.priority;
      lines = lines.filter((l) => priorityOf(l) === target);
    }

    let truncated = false;
    const tail = opts.tail ?? 0;
    if (tail > 0 && lines.length > tail) {
      lines = lines.slice(lines.length - tail).reverse();
      truncated = true;
    }
    return { lines, truncated };
  }

  /** `adb install -r <apk>` — fallback when the android CLI install is unavailable. */
  async install(serial: string, apk: string): Promise<void> {
    await this.exec(["adb", "-s", serial, "install", "-r", apk], SPAWN_TIMEOUTS.install);
  }

  /** `adb shell am start -n <activity>` — fallback launch when the CLI run is unavailable. */
  async amStart(serial: string, activity: string): Promise<void> {
    await this.shell(serial, SPAWN_TIMEOUTS.install, "am", "start", "-n", activity);
  }

  /** Shell-capture a PNG to a device path, then pull it to `localPath`. */
  async screencap(serial: string, localPath: string): Promise<void> {
    const devicePath = "/sdcard/om_shot.png";
    await this.shell(serial, SPAWN_TIMEOUTS.capture, "screencap", "-p", devicePath);
    await this.exec(["adb", "-s", serial, "pull", devicePath, localPath], SPAWN_TIMEOUTS.capture);
  }

  /** Dump the window hierarchy XML via uiautomator and return its contents. */
  async uiautomatorDump(serial: string): Promise<string> {
    const devicePath = "/sdcard/window_dump.xml";
    await this.shell(serial, SPAWN_TIMEOUTS.layout, "uiautomator", "dump", devicePath);
    return this.shell(serial, SPAWN_TIMEOUTS.layout, "cat", devicePath);
  }
}
