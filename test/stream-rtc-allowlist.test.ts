import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAllowlist, ALLOWLIST_PATTERNS } from "../src/stream/rtc/allowlist";

/**
 * Golden contract for the generated emulator gRPC allowlist (design D6).
 *
 * The golden file `test/fixtures/om_allowlist.json` is the EXACT file that
 * was LIVE-VERIFIED on 2026-08-16 against emulator 36.5.11 (pid 2604388,
 * Pixel_9_Pro AVD): launched with `-grpc-allowlist <that file>`, control via
 * EmulatorController worked (probe D) and RtcService/reflection were permitted
 * (probes A/B). The generate path must reproduce it byte-for-byte.
 */
describe("allowlist generation — -grpc-allowlist golden (design D6)", () => {
  it("buildAllowlist() matches the LIVE-verified golden file byte-for-byte", () => {
    const golden = readFileSync(join(import.meta.dir, "fixtures", "om_allowlist.json"), "utf8");
    expect(JSON.stringify(buildAllowlist(), null, 2)).toBe(golden);
  });

  it("keeps the android-studio issuer entry (token maps to it — removing it breaks the embedded emulator)", () => {
    // The allowlist is scoped by issuer; the LOCAL token maps to the
    // android-studio issuer (probe A: PERMISSION_DENIED without it).
    const entries = buildAllowlist().allowlist;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.iss).toBe("android-studio");
    expect(entries[0]!.allowed).toEqual(ALLOWLIST_PATTERNS);
  });

  it("permits EmulatorController (control), RtcService v1+v2 (video) and reflection (our launch surface)", () => {
    const allowed = buildAllowlist().allowlist[0]!.allowed.join("\n");
    // Control surface — default SDK allowlist already permits it.
    expect(allowed).toContain("/android.emulation.control.EmulatorController/.*");
    // Video surface — REQUIRED additions vs the SDK default allowlist.
    expect(allowed).toContain("/android.emulation.control.Rtc/.*");
    expect(allowed).toContain("/android.emulation.control.v2.Rtc/.*");
    // Reflection — probe A: blocked by default; needed for proto-less clients.
    expect(allowed).toContain("/grpc.reflection.v1alpha.ServerReflection/.*");
    expect(allowed).toContain("/grpc.reflection.v1.ServerReflection/.*");
  });

  it("never opens the unprotected list (every method still requires the token)", () => {
    expect(buildAllowlist().unprotected).toEqual([]);
  });
});