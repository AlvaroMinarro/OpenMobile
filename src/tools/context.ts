import { AndroidCli } from "../device/androidCli";
import { AdbWrapper } from "../device/adb";
import { BunCommandRunner } from "../device/runner";
import { resolveDeviceSelection } from "../device/selection";
import type { Device } from "../device/types";
import type { ToolResult } from "./handlers";

/**
 * Injectable device-interface dependencies shared by every MCP tool handler.
 * A single context is created per MCP server process; the `baselineEstablished`
 * set is the server-owned, in-memory 'baseline set' marker for `get_ui_tree_diff`
 * (per design D1) and resets on process restart.
 */
export interface DeviceContext {
  cli: AndroidCli;
  adb: AdbWrapper;
  /** Process environment, so `ANDROID_DEVICE` participates in selection. */
  env: Record<string, string>;
  /** Serials whose UI-tree baseline has been established in this process. */
  baselineEstablished: Set<string>;
  /** Embargo for reading screenshot PNG files (defaults to Bun.file). */
  readFile?: (path: string) => Promise<Uint8Array>;
  /** Outer timeout (ms) for CLI-delegated emulator readiness / deploy. */
  timeoutMs: number;
}

/** Error surfaced to the calling agent as an actionable tool error. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export type ResolvedTarget =
  | { ok: true; serial: string; device: Device }
  | { ok: false; error: string };

/**
 * Shared per-tool device targeting: resolve a serial via the selection rule
 * (explicit arg > ANDROID_DEVICE > single-device auto-detect), then confirm the
 * target is usable (state `device`). unauthorized/offline/ambiguous targets
 * produce actionable errors that name the serial and state — never silent skips.
 */
export async function resolveTarget(
  ctx: DeviceContext,
  explicit?: string,
): Promise<ResolvedTarget> {
  // An explicitly named serial is trusted without re-enumerating: the calling
  // agent picked it from a prior list_devices, so we avoid an extra adb
  // round-trip. Selection/state gating only applies to the auto-detect path.
  if (explicit) {
    return { ok: true, serial: explicit, device: { serial: explicit, state: "device" } };
  }
  const devices = await ctx.adb.devices();
  const base = resolveDeviceSelection({ explicit, env: ctx.env["ANDROID_DEVICE"], devices });
  if (base.ok === false) {
    if (base.reason === "no-devices") {
      return { ok: false, error: "no usable Android device attached" };
    }
    return {
      ok: false,
      error: `multiple devices attached and none selected; pass a --device serial or set ANDROID_DEVICE. Available: ${base.serials.join(", ")}`,
    };
  }
  const target = devices.find((d) => d.serial === base.serial);
  if (!target) {
    return { ok: false, error: `selected device ${base.serial} is not attached` };
  }
  if (target.state !== "device") {
    return {
      ok: false,
      error: `device ${target.serial} is in state '${target.state}' (requires 'device'); accept the RSA prompt to authorize, or reconnect it`,
    };
  }
  return { ok: true, serial: base.serial, device: target };
}

/** Wrap an async body: convert thrown errors into text error results. */
export async function safe(body: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await body();
    // A handler body that returns a full ToolResult (e.g. errText for a
    // gating refusal, or okImage) is already the final result — pass it
    // through instead of JSON-stringifying it as a success payload.
    if (isToolResult(value)) return value;
    return { isError: false, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

function isToolResult(value: unknown): value is ToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "isError" in value &&
    Array.isArray((value as ToolResult).content)
  );
}

/** Production context factory bound to Bun.spawn + process.env. */
export function createContext(opts: Partial<Omit<DeviceContext, "cli" | "adb">> = {}): DeviceContext {
  const runner = new BunCommandRunner();
  return {
    cli: new AndroidCli(runner),
    adb: new AdbWrapper(runner),
    env: process.env as Record<string, string>,
    baselineEstablished: new Set<string>(),
    timeoutMs: opts.timeoutMs ?? 120_000,
    readFile: opts.readFile ?? (async (p: string) => new Uint8Array(await Bun.file(p).arrayBuffer())),
  };
}
