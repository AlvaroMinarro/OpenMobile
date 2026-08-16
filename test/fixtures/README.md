# CLI Output Fixtures

Real command output recorded from the Android SDK command-line tools on
**2026-08-15** and pinned to the CLI version **1.0.15985488** (Pixel_9_Pro AVD,
`emulator-5554`, home screen). Parser tests consume these JSON envelopes so the
CLI/adb wrappers are verified against REAL tool output shapes — not
hand-crafted doubles.

## Stream fixtures

`stream-meta.bin`, `stream-a-frames.bin`, and `stream-control.bin` are REAL
bytes captured on **2026-08-16** from `emulator-5554` (Pixel 9 Pro AVD, API 36,
model `sdk_gphone64_x86_64`) with the pinned `assets/scrcpy-server.jar` (v4.1,
sha256 `deacb99…`, see `assets/README.md`):

| File | What it holds |
|------|---------------|
| `stream-meta.bin` | 64B device meta + 4B codec id `h264` + 12B session meta (flags/430x960) + 12B frame-meta of the CONFIG AU |
| `stream-a-frames.bin` | Frame-meta (12B) + Annex-B AU pairs: CONFIG (SPS+PPS) then IDR — the exact input `splitAnnexB()` consumes |
| `stream-control.bin` | 32B `TYPE_INJECT_TOUCH_EVENT` tap at video-space (215, 480) |

Each has a sibling `<name>.json` provenance envelope (same `fix-cli-real-output`
style): `{ bytes, provenance: { tool: "scrcpy", version: "4.1", capturedAt,
context, details: { serial, device, jarSha256, spawnCmd, videoSize } } }`.

### Re-record procedure (stream fixtures)

1. Boot an emulator (interactive home screen) and wait for boot completion.
2. If the bundled jar changed, re-pin it first (`assets/README.md` steps) —
   the wire layout is version-specific.
3. `bun run record-stream-fixture` (uses `ANDROID_DEVICE` default
   `emulator-5554`; overwrites the three `.bin` + `.json` pairs).
4. Review the diff — a wire-shape change MUST land with matching parser
   changes in `src/stream/wire.ts` in the SAME commit.

## Envelopes

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