import { detectDiffShape, parseBounds } from "./serialize";
import { SPAWN_TIMEOUTS, type CommandRunner } from "./runner";
import type { AVD, LayoutDiffResult, Point, UIElement } from "./types";

export interface DeviceTarget {
  serial: string;
}

/** Parse the recorded string center format `"[x,y]"` (or `"[x, y]"`). */
function parseCenterString(raw: string): Point | null {
  const m = /\[(-?\d+)\s*,\s*(-?\d+)\]/.exec(raw);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** Parse an object-form center `{x, y}` or `{left, top, right, bottom}`. */
function objectCenter(raw: Record<string, unknown>): Point | null {
  if (raw["x"] !== undefined && raw["y"] !== undefined) {
    const x = Number(raw["x"]);
    const y = Number(raw["y"]);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  if (raw["left"] !== undefined && raw["top"] !== undefined && raw["right"] !== undefined && raw["bottom"] !== undefined) {
    const left = Number(raw["left"]);
    const top = Number(raw["top"]);
    const right = Number(raw["right"]);
    const bottom = Number(raw["bottom"]);
    if (Number.isFinite(left) && Number.isFinite(top) && Number.isFinite(right) && Number.isFinite(bottom)) {
      return {
        x: Math.round((left + right) / 2),
        y: Math.round((top + bottom) / 2),
      };
    }
  }
  return null;
}

/**
 * Normalize a CLI-layout element into the UIElement shape. Tolerant of the
 * REAL `android layout` output (recorded fixtures): string center/bounds,
 * hyphenated `resource-id`/`content-desc` keys, sparse JSON. Elements with
 * data that cannot be parsed become `targetable:false` — NEVER silently
 * tappable at (0,0).
 */
function toUiElement(raw: Record<string, unknown>): UIElement {
  const boundsRaw = raw["bounds"];
  let bounds: { left: number; top: number; right: number; bottom: number };
  if (typeof boundsRaw === "string") {
    // Recorded shape: "[left,top][right,bottom]"
    bounds = parseBounds(boundsRaw);
  } else if (typeof boundsRaw === "object" && boundsRaw !== null) {
    const rec = boundsRaw as Record<string, unknown>;
    bounds = {
      left: Number(rec["left"] ?? 0),
      top: Number(rec["top"] ?? 0),
      right: Number(rec["right"] ?? 0),
      bottom: Number(rec["bottom"] ?? 0),
    };
  } else {
    bounds = { left: 0, top: 0, right: 0, bottom: 0 };
  }

  const centerVal = raw["center"];
  let center: Point | null =
    typeof centerVal === "string"
      ? parseCenterString(centerVal)
      : typeof centerVal === "object" && centerVal !== null
        ? objectCenter(centerVal as Record<string, unknown>)
        : null;

  // Fallback: midpoint of parseable bounds when no center key exists.
  if (
    center === null &&
    (bounds.left !== 0 || bounds.top !== 0 || bounds.right !== 0 || bounds.bottom !== 0)
  ) {
    center = {
      x: Math.round((bounds.left + bounds.right) / 2),
      y: Math.round((bounds.top + bounds.bottom) / 2),
    };
  }

  return {
    bounds,
    center: center ?? { x: 0, y: 0 },
    interactions: Array.isArray(raw["interactions"]) ? (raw["interactions"] as string[]) : [],
    state: typeof raw["state"] === "string" ? raw["state"] : "default",
    offScreen: raw["offScreen"] === true || raw["off-screen"] === true || raw["off-screen"] === "true",
    ...(typeof raw["text"] === "string" ? { text: raw["text"] as string } : {}),
    ...(typeof raw["resource-id"] === "string" ? { resourceId: raw["resource-id"] as string } : {}),
    ...(typeof raw["content-desc"] === "string" ? { contentDesc: raw["content-desc"] as string } : {}),
    ...(center !== null ? {} : { targetable: false }),
  };
}

/**
 * Primary device-interface layer: a wrapper around the official `android` CLI.
 * Every method builds an argv (the command builder) and parses the typed result.
 * adb is the fallback layer; see `adb.ts`.
 */
export class AndroidCli {
  private readonly runner: CommandRunner;

  constructor(runner: CommandRunner) {
    this.runner = runner;
  }

  private cmd(...parts: string[]): string[] {
    return ["android", ...parts];
  }

  private async exec(argv: string[], timeoutMs: number): Promise<string> {
    const { stdout, stderr, exitCode } = await this.runner.run(argv, { timeoutMs });
    if (exitCode !== 0) {
      throw new Error(`android CLI failed (${argv.join(" ")}): ${stderr || stdout}`);
    }
    return stdout;
  }

  /** Full UI tree from `android layout`. Returns an empty tree explicitly. */
  async layout(target: DeviceTarget): Promise<UIElement[]> {
    const stdout = await this.exec(this.cmd("layout", `--device=${target.serial}`), SPAWN_TIMEOUTS.layout);
    if (stdout.trim() === "") return [];
    const parsed = JSON.parse(stdout) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((e) => toUiElement(e as Record<string, unknown>));
    }
    if (detectDiffShape(parsed) === "full") {
      return [toUiElement(parsed as Record<string, unknown>)];
    }
    return [];
  }

  /** Change diff via `android layout --diff`; falls back to a full tree when the CLI cannot supply a baseline. */
  async layoutDiff(target: DeviceTarget): Promise<LayoutDiffResult> {
    const stdout = await this.exec(this.cmd("layout", `--device=${target.serial}`, "--diff"), SPAWN_TIMEOUTS.layout);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const shape = detectDiffShape(parsed);
    if (shape === "diff") {
      const added = Array.isArray(parsed["added"])
        ? (parsed["added"] as Record<string, unknown>[]).map(toUiElement)
        : [];
      const modified = Array.isArray(parsed["modified"])
        ? (parsed["modified"] as Record<string, unknown>[]).map(toUiElement)
        : [];
      return { shape: "diff", added, modified };
    }
    if (shape === "full") {
      return { shape: "full", tree: [toUiElement(parsed)] };
    }
    throw new Error("android layout --diff returned an unrecognized payload shape");
  }

  async capture(target: DeviceTarget & { outPath: string }): Promise<void> {
    await this.exec(
      this.cmd("screen", "capture", `--device=${target.serial}`, "-o", target.outPath),
      SPAWN_TIMEOUTS.capture,
    );
  }

  async captureAnnotated(target: DeviceTarget & { outPath: string }): Promise<void> {
    await this.exec(
      this.cmd("screen", "capture", `--device=${target.serial}`, "-o", target.outPath, "--annotate"),
      SPAWN_TIMEOUTS.capture,
    );
  }

  /** Resolve a `#N` label on an annotated screenshot to its center coordinates. */
  async resolveScreenLabel(target: { screenshot: string; label: string }): Promise<Point | null> {
    const stdout = await this.exec(
      this.cmd("screen", "resolve", "--screenshot", target.screenshot, "--string", target.label),
      SPAWN_TIMEOUTS.capture,
    );
    const m = /(\-?\d+)\s*,\s*(\-?\d+)/.exec(stdout);
    if (!m) return null;
    return { x: Number(m[1]), y: Number(m[2]) };
  }

  /**
   * List AVDs from `android emulator list --long`. The recorded real output
   * (v1.0.15985488) is a column table:
   *
   *   AVD ID                AVD Name               API Level      Status    Serial
   *   Pixel_9_Pro           Pixel 9 Pro            android-36     Online    emulator-5554
   *
   * Running detection comes from the Status column (Online|Offline) — the
   * plain list has NO running marker at all (design D5; old `* ` parse
   * removed). AVD ID (first token) is the name for start/stop; the serial
   * column is present only while Online.
   */
  async emulatorList(): Promise<AVD[]> {
    const stdout = await this.exec(this.cmd("emulator", "list", "--long"), SPAWN_TIMEOUTS.emulatorManage);
    const avds: AVD[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("AVD ID")) continue; // header
      const tokens = trimmed.split(/\s+/);
      const name = tokens[0];
      if (name === undefined) continue;
      const status = tokens.find((t) => t === "Online" || t === "Offline");
      const serial = tokens.find((t) => /^emulator-\d+$/.test(t));
      const avd: AVD = { name, running: status === "Online" };
      if (serial !== undefined) avd.serial = serial;
      avds.push(avd);
    }
    return avds;
  }

  async emulatorStart(name: string, timeoutMs?: number): Promise<void> {
    await this.exec(
      this.cmd("emulator", "start", name),
      timeoutMs ?? SPAWN_TIMEOUTS.emulatorStart,
    );
  }

  async emulatorStop(name: string): Promise<void> {
    await this.exec(this.cmd("emulator", "stop", name), SPAWN_TIMEOUTS.emulatorManage);
  }

  async emulatorCreate(name: string): Promise<void> {
    await this.exec(this.cmd("emulator", "create", name), SPAWN_TIMEOUTS.emulatorManage);
  }

  async install(target: DeviceTarget & { apk: string }): Promise<void> {
    await this.exec(this.cmd("install", `--device=${target.serial}`, target.apk), SPAWN_TIMEOUTS.install);
  }

  async run(target: DeviceTarget & { apk: string; activity?: string }): Promise<void> {
    const args = ["run", `--device=${target.serial}`, target.apk];
    if (target.activity) args.push(target.activity);
    await this.exec(this.cmd(...args), SPAWN_TIMEOUTS.install);
  }

  async info(field: string): Promise<string> {
    return (await this.exec(this.cmd("info", field), SPAWN_TIMEOUTS.devices)).trim();
  }

  async version(): Promise<string> {
    try {
      return await this.info("version");
    } catch {
      return "unknown";
    }
  }
}
