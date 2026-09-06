import type { DeviceContext, ResolvedTarget } from "./context";
import { resolveTarget, safe, ToolError } from "./context";
import { xmlToTree, uiElementToJson } from "../device/serialize";
import type { Device } from "../device/types";
import { tempPngPath } from "../device/temp";
import { rm } from "node:fs/promises";

/** Re-export the unique temp-PNG namer for tests and bridge consumers (D7). */
export { tempPngPath };

/** A single content block in a tool result (text or image). */
export type ToolBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  isError: boolean;
  content: ToolBlock[];
}

const okText = (payload: unknown): ToolResult => ({
  isError: false,
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
});

const errText = (message: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

const okImage = (data: string, mimeType = "image/png"): ToolResult => ({
  isError: false,
  content: [{ type: "image", data, mimeType }],
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Correlate the emulator we just started when the CLI prints no `started as`
 * marker: the post-start device list must contain exactly one NEW `emulator-*`
 * serial that was not present before the start (design D5 fallback). Returns
 * null when no serial can be attributed — the caller refuses success rather
 * than guessing the first state=device device.
 */
function diffNewEmulatorSerial(before: Device[], after: Device[]): string | null {
  const beforeEmulators = new Set(before.filter((d) => /^emulator-\d+$/.test(d.serial)).map((d) => d.serial));
  const candidates = after.filter(
    (d) => /^emulator-\d+$/.test(d.serial) && !beforeEmulators.has(d.serial),
  );
  return candidates.length === 1 ? (candidates[0]!.serial as string) : null;
}

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolError(message)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Guard a target resolution: return a tool-error result when no usable device. */
async function requireTarget(ctx: DeviceContext, explicit?: string): Promise<ResolvedTarget> {
  return resolveTarget(ctx, explicit);
}

/** Retry a device op once on transient adb/CLI failure. */
async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return fn();
  }
}

/**
 * Signature-conflict classifier (Install APK spec): real adb/CLI output for a
 * signing-key mismatch carries INSTALL_FAILED_UPDATE_INCOMPATIBLE or an
 * explicit "signatures do not match" note.
 */
export function isSignatureMismatch(message: string): boolean {
  return /INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures? (do|does) not match/i.test(message);
}

/**
 * Tap range gate (Tap spec SHOULD): returns an actionable error stating the
 * valid range when the coordinates fall outside a KNOWN screen size; null
 * when the size is unknown/unparsable (the gate never blocks blind taps).
 */
export function tapRangeError(x: number, y: number, screenSize: string | undefined): string | null {
  if (!screenSize) return null;
  const m = /^(\d+)x(\d+)$/.exec(screenSize.trim());
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (x >= 0 && x < w && y >= 0 && y < h) return null;
  return `tap (${x}, ${y}) is outside the valid range x:[0,${w}) y:[0,${h}) for screen ${screenSize.trim()}`;
}

async function toBase64(bytes: Uint8Array): Promise<string> {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return Buffer.from(bin, "binary").toString("base64");
}

// ---------------------------------------------------------------------------
// device-discovery
// ---------------------------------------------------------------------------

export const listDevices = (ctx: DeviceContext, _args?: unknown) =>
  safe(async () => {
    const [devices, avds, cliVersion] = await Promise.all([
      ctx.adb.devices(),
      ctx.cli.emulatorList(),
      ctx.cli.version(),
    ]);
    // Unauthorized devices are listed with an actionable RSA-authorization
    // hint instead of leaving the agent to guess why state != 'device'.
    const withHints = devices.map((d) =>
      d.state === "unauthorized"
        ? { ...d, hint: "accept the RSA debugging prompt on the device screen, then reconnect" }
        : d,
    );
    return { devices: withHints, avds, cliVersion };
  });

export const getDeviceInfo = (ctx: DeviceContext, args: { device?: string }) =>
  safe(async () => {
    const target = await requireTarget(ctx, args.device);
    if (!target.ok) return errText(target.error);
    // Device truth via adb getprop (design D6); `android info` reports
    // environment fields, not device state.
    const model = await ctx.adb.getprop(target.serial, "ro.product.model");
    const sdk = await ctx.adb.getprop(target.serial, "ro.build.version.sdk");
    const screen = await ctx.adb.wm(target.serial);
    return {
      serial: target.device.serial,
      state: target.device.state,
      ...(model !== "" ? { model } : target.device.model ? { model: target.device.model } : {}),
      ...(sdk !== "" ? { sdk } : {}),
      ...(screen.size !== undefined ? { screenSize: screen.size } : {}),
      ...(screen.density !== undefined ? { density: screen.density } : {}),
    };
  });

// ---------------------------------------------------------------------------
// emulator-lifecycle
// ---------------------------------------------------------------------------

export const emulatorList = (ctx: DeviceContext, _args?: unknown) =>
  safe(async () => ({ avds: await ctx.cli.emulatorList() }));

export const emulatorStart = (ctx: DeviceContext, args: { name?: string; timeoutMs?: number }) =>
  safe(async () => {
    const timeout = args.timeoutMs ?? ctx.timeoutMs;
    const available = await ctx.cli.emulatorList();
    let name = args.name;
    if (!name) {
      if (available.length !== 1) {
        throw new ToolError(
          `emulator_start requires a name; found ${available.length} AVDs: ${available.map((a) => a.name).join(", ") || "(none)"}`,
        );
      }
      name = available[0]!.name;
    }
    // Unknown-AVD spec scenario: fail BEFORE launching, listing what exists.
    if (!available.some((a) => a.name === name)) {
      throw new ToolError(
        `unknown AVD '${name}'; available AVDs: ${available.map((a) => a.name).join(", ") || "(none)"}`,
      );
    }
    // CLI-delegated readiness: the start command blocks until boot, wrapped in
    // an outer timeout, and prints the serial of the STARTED emulator. We poll
    // THAT serial to state 'device' — never the first state=device device
    // (design D5: an already-attached device must not be mistaken for the one
    // we started). When the CLI prints no marker we diff the pre/post device
    // lists for a NEW emulator-* serial.
    const preStart = await ctx.adb.devices();
    const started = await withTimeout(
      ctx.cli.emulatorStart(name),
      timeout,
      `emulator start for ${name} timed out`,
    );
    const serial = started ?? diffNewEmulatorSerial(preStart, await ctx.adb.devices());
    if (!serial) {
      throw new ToolError(
        `emulator ${name} started, but its serial could not be determined (no 'started as' marker and no new emulator-* device appeared)`,
      );
    }
    const deadline = Date.now() + timeout;
    let last = "no-device";
    while (Date.now() < deadline) {
      const devices = await ctx.adb.devices();
      const ready = devices.find((d) => d.serial === serial && d.state === "device");
      if (ready) return { started: name, serial };
      const observed = devices.find((d) => d.serial === serial);
      last = observed ? observed.state : "no-device";
      await sleep(200);
    }
    throw new ToolError(
      `emulator ${name} did not reach 'device' state within ${timeout}ms (serial ${serial}, last observed state: ${last})`,
    );
  });

export const emulatorStop = (ctx: DeviceContext, args: { name: string }) =>
  safe(async () => {
    await ctx.cli.emulatorStop(args.name);
    const leftover = (await ctx.cli.emulatorList()).find((a) => a.name === args.name && a.running);
    if (leftover) throw new ToolError(`emulator ${args.name} is still listed as running`);
    return { stopped: args.name };
  });

export const emulatorCreate = (ctx: DeviceContext, args: { name: string }) =>
  safe(async () => {
    // Duplicate-name spec scenario: reject BEFORE issuing the create command
    // so an existing AVD is never clobbered and nothing is created.
    const avds = await ctx.cli.emulatorList();
    if (avds.some((a) => a.name === args.name)) {
      throw new ToolError(`AVD '${args.name}' already exists; choose a different name (nothing was created)`);
    }
    await ctx.cli.emulatorCreate(args.name);
    return { created: args.name };
  });

// ---------------------------------------------------------------------------
// deploy-app
// ---------------------------------------------------------------------------

export const deployApp = (
  ctx: DeviceContext,
  args: { apk: string; activity?: string; device?: string },
) =>
  safe(async () => {
    const target = await requireTarget(ctx, args.device);
    if (!target.ok) return errText(target.error);
    // Primary: android CLI install; fallback: adb install (design: CLI installs
    // are best-effort, adb ALWAYS works). Wrapped so a CLI failure never fails
    // the whole deploy when adb can do the job.
    const signatureError = (raw: string) =>
      new ToolError(
        `install of ${args.apk} failed: signature conflict with the installed app — uninstall it or sign with the same key (${raw})`,
      );
    const install = async () => {
      try {
        await ctx.cli.install({ serial: target.serial, apk: args.apk });
      } catch (e) {
        // A signature conflict is terminal: never mask it behind the adb
        // fallback (Install APK spec — actionable error naming the conflict).
        if (isSignatureMismatch(e instanceof Error ? e.message : String(e))) {
          throw signatureError(e instanceof Error ? e.message : String(e));
        }
        await ctx.adb.install(target.serial, args.apk).catch((adbErr: unknown) => {
          if (isSignatureMismatch(adbErr instanceof Error ? adbErr.message : String(adbErr))) {
            throw signatureError(adbErr instanceof Error ? adbErr.message : String(adbErr));
          }
          throw adbErr;
        });
      }
    };
    await withTimeout(install(), ctx.timeoutMs, `install of ${args.apk} timed out`);
    const activity = args.activity;
    if (activity) {
      // Primary: android CLI run; fallback: adb `am start -n <activity>`.
      const launch = async () => {
        try {
          await ctx.cli.run({ serial: target.serial, apk: args.apk, activity });
        } catch {
          await ctx.adb.amStart(target.serial, activity);
        }
      };
      await withTimeout(launch(), ctx.timeoutMs, `launch of ${activity} timed out`);
    }
    return { installed: args.apk, serial: target.serial, launched: activity ?? false };
  });

// ---------------------------------------------------------------------------
// ui-tree
// ---------------------------------------------------------------------------

const serializeTree = (tree: ReturnType<typeof xmlToTree>): unknown[] => tree.map(uiElementToJson);

export const getUiTree = (ctx: DeviceContext, args: { device?: string }) =>
  safe(async () => {
    const target = await requireTarget(ctx, args.device);
    if (!target.ok) return errText(target.error);
    const fromXml = async () => xmlToTree(await ctx.adb.uiautomatorDump(target.serial));
    let elements;
    try {
      elements = await ctx.cli.layout({ serial: target.serial });
    } catch {
      // CLI unavailable entirely (not just an empty screen): the uiautomator
      // XML fallback IS the tree (Full UI Tree spec, CLI-unavailable scenario).
      elements = await fromXml();
    }
    if (elements.length === 0) {
      // CLI layout empty (e.g. WebView): fall back to the parsed
      // uiautomator XML before signalling empty explicitly.
      elements = await fromXml();
    }
    return { serial: target.serial, empty: elements.length === 0, tree: serializeTree(elements) };
  });

export const getUiTreeDiff = (ctx: DeviceContext, args: { device?: string }) =>
  safe(async () => {
    const target = await requireTarget(ctx, args.device);
    if (!target.ok) return errText(target.error);
    const serial = target.serial;
    // Server-owned baseline marker (design D1): never report a stale diff we
    // cannot reconstruct. A fresh process re-establishes the baseline.
    if (!ctx.baselineEstablished.has(serial)) {
      const tree = await ctx.cli.layout({ serial });
      ctx.baselineEstablished.add(serial);
      return { serial, baseline: "set", tree: serializeTree(tree) };
    }
    const diff = await ctx.cli.layoutDiff({ serial });
    if (diff.shape === "diff") {
      return {
        serial,
        baseline: "diff",
        diff: {
          added: diff.added.map(uiElementToJson),
          modified: diff.modified.map(uiElementToJson),
        },
      };
    }
    // CLI fell back to a full tree (no prior baseline on device): re-set.
    return { serial, baseline: "re-set", tree: serializeTree(diff.tree) };
  });

// ---------------------------------------------------------------------------
// screen-capture
// ---------------------------------------------------------------------------

export const takeScreenshot = (ctx: DeviceContext, args: { device?: string }) =>
  safe(async () => {
    const target = await requireTarget(ctx, args.device);
    if (!target.ok) return errText(target.error);
    const path = ctx.tempPngPath!("shot", target.serial);
    try {
      try {
        await ctx.cli.capture({ serial: target.serial, outPath: path });
      } catch {
        // Raw Screenshot spec: the android CLI capture falls back to
        // `screencap` when the CLI path fails or is unavailable.
        await ctx.adb.screencap(target.serial, path);
      }
      const bytes = await ctx.readFile!(path);
      return okImage(await toBase64(bytes));
    } finally {
      // Temp PNG hygiene (D7): always delete the temp file after the bytes are
      // read — including on failure.
      await rm(path, { force: true }).catch(() => {});
    }
  });

export const getAnnotatedScreen = (ctx: DeviceContext, args: { device?: string }) =>
  safe(async () => {
    const target = await requireTarget(ctx, args.device);
    if (!target.ok) return errText(target.error);
    const path = ctx.tempPngPath!("annotated", target.serial);
    try {
      await ctx.cli.captureAnnotated({ serial: target.serial, outPath: path });
      const bytes = await ctx.readFile!(path);
      return okImage(await toBase64(bytes));
    } finally {
      await rm(path, { force: true }).catch(() => {});
    }
  });

export const resolveScreenLabels = (
  ctx: DeviceContext,
  args: { screenshot: string; labels: string[] },
) =>
  safe(async () => {
    const points: Array<{ label: string; x: number; y: number }> = [];
    const unknown: string[] = [];
    for (const label of args.labels) {
      const pt = await ctx.cli.resolveScreenLabel({ screenshot: args.screenshot, label });
      if (pt) points.push({ label, x: pt.x, y: pt.y });
      else unknown.push(label);
    }
    if (unknown.length > 0) {
      const resolved = points.map((p) => p.label).join(", ") || "(none)";
      throw new ToolError(
        `unknown/out-of-range label(s) ${unknown.join(", ")} on ${args.screenshot}; valid labels resolved: ${resolved}`,
      );
    }
    return { screenshot: args.screenshot, points };
  });

// ---------------------------------------------------------------------------
// logcat-read
// ---------------------------------------------------------------------------

export const readLogcat = (
  ctx: DeviceContext,
  args: { device?: string; pid?: number; priority?: "V" | "D" | "I" | "W" | "E" | "F" | "S"; tail?: number },
) =>
  safe(async () => {
    const target = await requireTarget(ctx, args.device);
    if (!target.ok) return errText(target.error);
    const res = await ctx.adb.logcat(target.serial, {
      pid: args.pid,
      priority: args.priority ?? "E",
      tail: args.tail ?? 100,
    });
    return { serial: target.serial, truncated: res.truncated, lines: res.lines };
  });

// ---------------------------------------------------------------------------
// input-channel
// ---------------------------------------------------------------------------

export const tap = (ctx: DeviceContext, args: { x: number; y: number; device?: string }) =>
  safe(async () => {
    const target = await requireTarget(ctx, args.device);
    if (!target.ok) return errText(target.error);
    // Tap spec: reject out-of-range coordinates when the screen size is known
    // (best-effort `wm size` probe; unknown size never blocks the tap).
    const oob = tapRangeError(args.x, args.y, await ctx.adb.wmSize(target.serial));
    if (oob) throw new ToolError(oob);
    await retryOnce(() => ctx.adb.inputTap(target.serial, args.x, args.y));
    return { injected: "tap", x: args.x, y: args.y, serial: target.serial };
  });

export const swipe = (
  ctx: DeviceContext,
  args: { x1: number; y1: number; x2: number; y2: number; durationMs?: number; device?: string },
) =>
  safe(async () => {
    const target = await requireTarget(ctx, args.device);
    if (!target.ok) return errText(target.error);
    await retryOnce(() =>
      ctx.adb.inputSwipe(target.serial, args.x1, args.y1, args.x2, args.y2, args.durationMs),
    );
    return { injected: "swipe", serial: target.serial };
  });

export const inputText = (ctx: DeviceContext, args: { text: string; device?: string }) =>
  safe(async () => {
    const target = await requireTarget(ctx, args.device);
    if (!target.ok) return errText(target.error);
    await retryOnce(() => ctx.adb.inputText(target.serial, args.text));
    return { injected: "text", serial: target.serial };
  });

const KEYCODES: Record<string, string> = { app_switch: "187" };

export const pressKey = (ctx: DeviceContext, args: { key: string; device?: string }) =>
  safe(async () => {
    const target = await requireTarget(ctx, args.device);
    if (!target.ok) return errText(target.error);
    const keycode = KEYCODES[args.key] ?? args.key;
    await retryOnce(() => ctx.adb.inputKeyevent(target.serial, keycode));
    return { injected: "key", key: args.key, serial: target.serial };
  });
