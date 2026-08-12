import type { Device } from "./types";

export interface SelectionInput {
  /** Explicit `--device` argument. */
  explicit?: string;
  /** Value of the `ANDROID_DEVICE` environment variable. */
  env?: string;
  /** Currently attached devices, each with a connection state. */
  devices: Device[];
}

export type SelectionResult =
  | { ok: true; serial: string }
  | { ok: false; reason: "no-devices" }
  | { ok: false; reason: "ambiguous"; serials: string[] };

/**
 * Shared device-selection rule used by every tool: explicit `--device` argument
 * wins, then the `ANDROID_DEVICE` environment variable, then single-device
 * auto-detection. With multiple attached devices and no explicit selection the
 * result is an ambiguity error listing every serial — never an arbitrary pick.
 */
export function resolveDeviceSelection({ explicit, env, devices }: SelectionInput): SelectionResult {
  if (explicit) {
    return { ok: true, serial: explicit };
  }
  if (env) {
    return { ok: true, serial: env };
  }
  if (devices.length === 1) {
    const only = devices[0];
    if (only) return { ok: true, serial: only.serial };
  }
  if (devices.length === 0) {
    return { ok: false, reason: "no-devices" };
  }
  return { ok: false, reason: "ambiguous", serials: devices.map((d) => d.serial) };
}
