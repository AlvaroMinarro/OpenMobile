import { detectDiffShape } from "./serialize";
import { SPAWN_TIMEOUTS, type CommandRunner } from "./runner";
import type { AVD, LayoutDiffResult, Point, UIElement } from "./types";

export interface DeviceTarget {
  serial: string;
}

/** Normalize a CLI-layout element into the UIElement shape, computing center if absent. */
function toUiElement(raw: Record<string, unknown>): UIElement {
  const boundsRaw = (raw["bounds"] ?? {}) as Partial<{ left: number; top: number; right: number; bottom: number }>;
  const bounds = {
    left: Number(boundsRaw["left"] ?? 0),
    top: Number(boundsRaw["top"] ?? 0),
    right: Number(boundsRaw["right"] ?? 0),
    bottom: Number(boundsRaw["bottom"] ?? 0),
  };
  const center: Point =
    typeof raw["center"] === "object" && raw["center"] !== null
      ? {
          x: Number((raw["center"] as Point).x),
          y: Number((raw["center"] as Point).y),
        }
      : {
          x: Math.round((bounds.left + bounds.right) / 2),
          y: Math.round((bounds.top + bounds.bottom) / 2),
        };
  return {
    bounds,
    center,
    interactions: Array.isArray(raw["interactions"]) ? (raw["interactions"] as string[]) : [],
    state: typeof raw["state"] === "string" ? raw["state"] : "default",
    offScreen: raw["offScreen"] === true,
    ...(typeof raw["text"] === "string" ? { text: raw["text"] as string } : {}),
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

  /** List AVDs; a leading `*` marks a running emulator (format live-verified at apply). */
  async emulatorList(): Promise<AVD[]> {
    const stdout = await this.exec(this.cmd("emulator", "list"), SPAWN_TIMEOUTS.emulatorManage);
    const avds: AVD[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      if (trimmed.startsWith("* ")) {
        avds.push({ name: trimmed.slice(2), running: true });
      } else {
        avds.push({ name: trimmed, running: false });
      }
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
