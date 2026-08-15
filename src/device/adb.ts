import { escapeForAdb } from "./input";
import { SPAWN_TIMEOUTS, type CommandRunner } from "./runner";
import { randomUUID } from "node:crypto";
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

/**
 * Unique device-side screencap path (design D7): `/sdcard/om_shot_<rand6>.png`
 * — never the fixed `om_shot.png`, so concurrent captures cannot collide.
 */
export function deviceShotPath(): string {
  const rand6 = randomUUID().replace(/-/g, "").slice(0, 6);
  return `/sdcard/om_shot_${rand6}.png`;
}

/** Extract a logcat priority token (V/D/I/W/E/F/S) from a `-v time` line. */
function priorityOf(line: string): string | null {
  // Real recorded lines: "MM-DD HH:MM:SS.mmm P/Tag(  pid): msg" — priority is
  // followed by '/' (e.g. " I/AiAiEcho("), NOT a space as the legacy regex
  // assumed.
  const m = /\s([VDIWEFS])\//.exec(line);
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

  /** Read logcat scoped by pid, priority-filtered, bounded to `tail`.
   *
   * Bounded read: `-d` dumps and exits (never streams), `-t N` bounds the
   * device-side buffer. When `tail` is set, the in-process bound slices to a
   * MAXIMUM of `tail` lines (newest-first) and flags `truncated`.
   */
  async logcat(serial: string, opts: LogcatOptions = {}): Promise<LogcatResult> {
    const args = ["adb", "-s", serial, "logcat", "-d"];
    const tail = opts.tail ?? 0;
    if (tail > 0) args.push("-t", String(tail));
    args.push("-v", "time");
    if (opts.priority !== undefined) args.push(`${opts.priority}:*`);
    if (opts.pid !== undefined) args.push("--pid", String(opts.pid));
    const stdout = await this.exec(args, SPAWN_TIMEOUTS.logcatDump);

    const all = stdout.split("\n").filter((l) => l.trim() !== "");
    const lines = opts.priority ? all.filter((l) => priorityOf(l) === opts.priority) : all;
    // Buffer headers ("--------- beginning of main") carry no priority token,
    // so the priority filter above already drops them.

    let truncated = false;
    if (tail > 0 && lines.length > tail) {
      truncated = true;
    }
    return {
      lines: lines.slice(-tail || undefined).reverse(),
      truncated,
    };
  }

  /** `adb install -r <apk>` — fallback when the android CLI install is unavailable. */
  async install(serial: string, apk: string): Promise<void> {
    await this.exec(["adb", "-s", serial, "install", "-r", apk], SPAWN_TIMEOUTS.install);
  }

  /** `adb shell am start -n <activity>` — fallback launch when the CLI run is unavailable. */
  async amStart(serial: string, activity: string): Promise<void> {
    await this.shell(serial, SPAWN_TIMEOUTS.install, "am", "start", "-n", activity);
  }

  /** Read a single device system property via `adb shell getprop` (device truth; D6). */
  async getprop(serial: string, prop: string): Promise<string> {
    return (await this.shell(serial, SPAWN_TIMEOUTS.devices, "getprop", prop)).trim();
  }

  /** Best-effort screen metrics via `wm size` / `wm density`; both may be missing on quirky devices. */
  async wm(serial: string): Promise<{ size?: string; density?: string }> {
    const parsePhysical = (out: string): string | undefined => {
      const m = /Physical (?:size|density):\s*(.+)/.exec(out);
      return m ? (m[1] as string).trim() : undefined;
    };
    const [sizeOut, densityOut] = await Promise.all([
      this.shell(serial, SPAWN_TIMEOUTS.devices, "wm", "size").catch(() => ""),
      this.shell(serial, SPAWN_TIMEOUTS.devices, "wm", "density").catch(() => ""),
    ]);
    return {
      size: parsePhysical(sizeOut),
      density: parsePhysical(densityOut),
    };
  }

  /**
   * Shell-capture a PNG to a UNIQUE device path, pull it to `localPath`, then
   * remove the device-side file in `finally` (temp hygiene on failure too).
   * An explicit device path is accepted for deterministic tests/embargos.
   */
  async screencap(serial: string, localPath: string, devicePath = deviceShotPath()): Promise<void> {
    try {
      await this.shell(serial, SPAWN_TIMEOUTS.capture, "screencap", "-p", devicePath);
      await this.exec(["adb", "-s", serial, "pull", devicePath, localPath], SPAWN_TIMEOUTS.capture);
    } finally {
      await this.shell(serial, SPAWN_TIMEOUTS.capture, "rm", "-f", devicePath).catch(() => {});
    }
  }

  /** Dump the window hierarchy XML via uiautomator and return its contents. */
  async uiautomatorDump(serial: string): Promise<string> {
    const devicePath = "/sdcard/window_dump.xml";
    await this.shell(serial, SPAWN_TIMEOUTS.layout, "uiautomator", "dump", devicePath);
    return this.shell(serial, SPAWN_TIMEOUTS.layout, "cat", devicePath);
  }
}
