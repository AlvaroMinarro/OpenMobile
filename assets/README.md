# scrcpy-server.jar (pinned v4.1)

The scrcpy Android server used by the device-streaming bridge (see
`openspec/changes/device-streaming/design.md`, D1). Version-locked so the
raw wire protocol the parsers implement (64B device meta, 12B frame meta,
Annex-B AUs, control socket byte layout) stays matched to the exact jar.

## Provenance

| Field | Value |
|-------|-------|
| Artifact | `scrcpy-server-v4.1` (release binary, renamed to `scrcpy-server.jar`) |
| Source | <https://github.com/Genymobile/scrcpy/releases/download/v4.1/scrcpy-server-v4.1> |
| sha256 | `deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae` |
| Size | 733,706 bytes |
| License | Apache-2.0 (scrcpy is Apache-2.0; README + license: <https://github.com/Genymobile/scrcpy>) |
| Reverse-engineered from | `classes.dex` (app_process dex, no native libs) |

Verified live 2026-08-16 on `emulator-5554` (Pixel 9 Pro AVD, API 36): the
spawn command in `src/stream/scrcpy.ts` starts the server and produces the
video/control sockets exactly as `design.md` §Live-validated facts record.

## Re-pin procedure

1. Download the new official artifact:
   `curl -sL -o /tmp/scrcpy-server-new https://github.com/Genymobile/scrcpy/releases/download/v<VER>/scrcpy-server-v<VER>`
2. Verify authenticity (release asset, checksum published by upstream).
3. Overwrite: `cp /tmp/scrcpy-server-new assets/scrcpy-server.jar`
4. Update this table (version, sha256 via `sha256sum assets/scrcpy-server.jar`, size).
5. Update the pin in `test/fixtures.test.ts` (`SCRCPY_JAR_SHA256`) — the
   sha256 pin test FAILS until both move together.
6. Re-record the stream fixtures (`bun run record-stream-fixture`) if the
   wire layout changed, and update `src/stream/wire.ts` parsers in the SAME
   commit.

## Notes

- The server self-deletes the jar from the device once streaming starts
  (`CleanUp`), so the adapter RE-PUSHES the jar before every stream start.
- Entry point: `com.genymobile.scrcpy.Server` via `app_process`.
- Pushing: `adb -s <serial> push assets/scrcpy-server.jar /data/local/tmp/scrcpy-server.jar`.