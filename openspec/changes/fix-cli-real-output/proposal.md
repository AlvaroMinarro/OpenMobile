# Proposal: Fix Device Core Against Real CLI Output

## Intent

The android-device-bridge was built and tested against in-memory CLI/adb doubles. A live run against the real `android` CLI v1.0.15985488 (review obs #573) proved 3 CRITICAL parser mismatches: all UI coordinates collapse to (0,0), `readLogcat` hangs forever, and running emulators report `running:false`. This change hardens the device core against REAL CLI output and adds recorded-fixture regression tests so this bug class cannot return. It unblocks the OpenChamber V2 surface, which must build on a healthy base.

## Scope

### In Scope
- **C1** `toUiElement` (src/device/androidCli.ts:10-36): parse real `android layout` output — center as string `"[640,1384]"`, hyphenated keys (`resource-id`, `off-screen`).
- **C2** `readLogcat` (src/device/adb.ts:104-122): use `adb logcat -d -t N` (dump+tail, bounded memory) instead of unbounded streaming.
- **C3** `emulatorList` (src/device/androidCli.ts:119-132): fix running-marker parsing against real CLI output.
- **W2** Timeouts on ALL spawns in BunCommandRunner (no indefinite `proc.exited` awaits).
- **W1** `getDeviceInfo`: source SDK via `adb shell getprop ro.build.version.sdk`, not `android info`.
- **W3** Temp PNG cleanup (unique names + delete after read).
- **W5** `emulatorStart`: confirm the STARTED emulator is ready, not the first `state=device` device.
- Real CLI output fixtures recorded from live captures; parser tests run against them.

### Out of Scope
- OpenChamber V2 surface (next change, depends on this one).
- scrcpy streaming, new MCP tools, plugin sessionID sourcing (W6).
- W4 toBase64 perf, deploy-app adb fallback (verify-report follow-ups).

## Capabilities

### New Capabilities
- `cli-output-fixtures`: recorded real CLI/adb output fixtures; parsers MUST have fixture-backed regression tests.

### Modified Capabilities
- `ui-tree`: element parsing MUST accept real CLI layout shapes (string center, hyphenated keys).
- `logcat-read`: reads MUST be non-streaming (`-d -t N`), bounded, timeout-guarded.
- `emulator-lifecycle`: running detection MUST match real CLI markers; start MUST verify the started emulator.
- `device-discovery`: device info MUST come from device properties via adb, not environment info.

## Approach

Fixture-first: record real CLI/adb outputs (live captures already exist) into `test/fixtures/`, write failing parser tests (RED), then fix parsers to green (strict TDD per config). Add a timeout wrapper in BunCommandRunner applied to every spawn; keep defaults per-call overridable. Fixes stay inside `src/device/` — MCP tools, bridge `/v1` contract, and plugin are untouched.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/device/androidCli.ts` | Modified | C1 toUiElement, C3 emulatorList, W5 emulatorStart |
| `src/device/adb.ts` | Modified | C2 readLogcat, W1 getprop, W3 temp PNG cleanup |
| `src/device/runner.ts` (BunCommandRunner) | Modified | W2 spawn timeouts |
| `test/fixtures/` | New | Recorded real CLI/adb outputs |
| `test/` | Modified | Fixture-backed parser regression tests |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| CLI output varies across versions/locales | Med | Parse defensively (accept both shapes); pin fixtures to v1.0.15985488 with version note |
| Timeouts break slow legit operations (emulator boot) | Med | Generous per-op defaults (boot 120s per D3), configurable |
| Fixtures drift from future CLI versions | Med | Document re-record procedure; version-detect already in wrapper |

## Rollback Plan

All changes are confined to `src/device/` + tests; revert the fix commits to restore prior behavior. `/v1` contract and MCP tool surface unchanged, so no consumer migration needed.

## Dependencies

- Live `android` CLI v1.0.15985488 + adb + one emulator for fixture re-recording (captures already exist).

## Success Criteria

- [ ] `bun test` green incl. fixture tests reproducing C1–C3 (fail on old code, pass on new)
- [ ] Live run: `/v1/state` shows Pixel_9_Pro `running:true`; UI tree has real coordinates; `read_logcat` returns within timeout
- [ ] `bun run typecheck` clean
- [ ] Every BunCommandRunner spawn has a timeout
