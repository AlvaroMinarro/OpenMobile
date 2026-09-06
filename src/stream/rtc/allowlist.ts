/**
 * Emulator gRPC allowlist generation (design D6).
 *
 * `emulator_start` launches the emulator with `-grpc-allowlist <generated>`.
 * The default SDK allowlist (`emulator/lib/emulator_access.json`) blocks
 * RtcService + reflection — probe A proved PERMISSION_DENIED against both —
 * so a file permitting our surface MUST be generated before launch.
 *
 * Contract (pinned by the golden test):
 *  - keep the `android-studio` issuer entry EXACTLY (the per-instance token
 *    maps to that issuer; removing it rejects even EmulatorController),
 *  - ADD RtcService v1+v2 (video path, PR2) + reflection to the same entry,
 *  - `unprotected` stays empty: every method still requires the token.
 *
 * The golden file `test/fixtures/om_allowlist.json` is the LIVE-VERIFIED
 * 2026-08-16 artifact (probes A/B/D, emulator 36.5.11).
 */

/** Methods the generated allowlist permits under the android-studio issuer. */
export const ALLOWLIST_PATTERNS = [
  // Control surface (SDK default already allows; kept verbatim).
  "/android.emulation.control.EmulatorController/.*",
  "/android.emulation.control.UiController/.*",
  "/android.emulation.control.SnapshotService/.*",
  "/android.emulation.control.incubating.*",
  // Video surface (design D6 additions — default allowlist blocks these).
  "/android.emulation.control.Rtc/.*",
  "/android.emulation.control.v2.Rtc/.*",
  // Reflection (probe A: blocked by default; needed for proto-less clients).
  "/grpc.reflection.v1alpha.ServerReflection/.*",
  "/grpc.reflection.v1.ServerReflection/.*",
] as const;

/** The generated allowlist document shape (matches the emulator's JSON). */
export interface EmulatorAllowlist {
  unprotected: string[];
  allowlist: Array<{ iss: string; allowed: string[] }>;
}

/** Build the allowlist document; stable key order = byte-stable golden. */
export function buildAllowlist(): EmulatorAllowlist {
  return {
    unprotected: [],
    allowlist: [{ iss: "android-studio", allowed: [...ALLOWLIST_PATTERNS] }],
  };
}

import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Stable file name the launcher passes to `-grpc-allowlist`. */
export const ALLOWLIST_FILE_NAME = "om_allowlist.json";

/**
 * Write the allowlist to `dir` (default: the OS tmp dir) and return the
 * absolute path the emulator launch flag must reference.
 */
export function writeAllowlist(dir: string = tmpdir()): string {
  const path = process.env["OPENMOBILE_ALLOWLIST_DIR"] !== undefined
    ? join(process.env["OPENMOBILE_ALLOWLIST_DIR"]!, ALLOWLIST_FILE_NAME)
    : mkdtempSync(join(dir, "om-allowlist-")) + `/${ALLOWLIST_FILE_NAME}`;
  writeFileSync(path, JSON.stringify(buildAllowlist(), null, 2));
  return path;
}