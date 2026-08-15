# CLI Output Fixtures

Real command output recorded from the Android SDK command-line tools on
**2026-08-15** and pinned to the CLI version **1.0.15985488** (Pixel_9_Pro AVD,
`emulator-5554`, home screen). Parser tests consume these JSON envelopes so the
CLI/adb wrappers are verified against REAL tool output shapes — not
hand-crafted doubles.

Each envelope is `{ argv, stdout, stderr, exitCode, provenance: { tool,
version, capturedAt, context } }`, where `argv` is the exact command that
produced the output.

## Envelopes

| File | Command | Shape notes |
|------|---------|-------------|
| `android-layout.json` | `android layout --device=<serial>` | Flat JSON array; `center`/`bounds` as STRINGS (`"[x,y]"` / `"[l,t][r,b]"`); hyphenated `resource-id`/`content-desc`; sparse keys (no `offScreen`/`state` on most elements; `state` may be an array); numeric `key` field |
| `android-layout-diff.json` | `android layout --device=<serial> --diff` | `{"added":[],"modified":[]}` |
| `android-emulator-list-long.json` | `android emulator list --long` | Column table: `AVD ID` / `AVD Name` / `API Level` / `Status` (`Online`\|`Offline`) / `Serial` (only when Online); bare AVD IDs, NO `*` running marker |
| `adb-logcat-d-t.json` | `adb -s <serial> logcat -d -t 20 -v time *:D` | Bounded, exiting dump; `--------- beginning of main/system` headers; lines `MM-DD HH:MM:SS.mmm P/Tag(  pid): msg` |
| `adb-devices-l.json` | `adb devices -l` | `List of devices attached` + `serial state product:… model:… device:…` |
| `adb-getprop.json` | `adb -s <serial> shell getprop ro.build.version.sdk` | `36` (plain value) |

## Version pin

- Every envelope carries `provenance.version`; `test/helpers/fixtures.ts`
  (`FIXTURE_VERSION`) asserts it, and `loadFixture()` rejects envelopes with
  incomplete provenance.
- The recorder hardcodes the same pin in `scripts/record-fixtures.ts`
  (`TOOL_VERSION`).
- If the installed CLI changes, ALL of the above must move together: new
  fixtures, bumped pin, and parser updates for any shape changes.

## Re-record procedure

1. Start a booted emulator (`emulator-5554` or override `ANDROID_DEVICE`).
2. Check the installed CLI: `android info version`.
3. If it changed, update `TOOL_VERSION` in `scripts/record-fixtures.ts` and
   `FIXTURE_VERSION` in `test/helpers/fixtures.ts`.
4. Run `bun run record-fixtures` (requires the `android` CLI and `adb` on
   PATH; the script uses the production `BunCommandRunner`).
5. Review the diff — a shape change MUST land with matching parser changes and
   a version pin bump in the SAME commit.