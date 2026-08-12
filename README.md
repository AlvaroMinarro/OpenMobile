# OpenMobile — android-device-bridge

Expose an Android device to coding agents and tooling. A single Bun package that
provides:

- **Device core** (`src/device/`) — the `android` CLI wrapper (primary) and `adb`
  fallback, shared device selection, and serialization. Used by both the MCP
  server and the bridge daemon.
- **MCP server** (`src/mcp-server.ts`) — a stdio server exposing ~12 tools that
  route through the device core.
- **Localhost bridge** (`src/bridge/`) — an HTTP daemon serving the `/v1`
  contract (state, screenshot, input) for the future OpenChamber surface.
- **Plugin** (`src/plugin/`) — a headless OpenCode plugin that pushes compact
  screen snapshots into the session on idle / tool-execute.

> Scaffold phase. The Bun package scaffold is complete; the device core
> (`src/device/`) and its tests are the current slice being implemented. The
> MCP server, bridge daemon, and plugin are later slices of this change.

## Requirements

- Bun (runtime + test runner)
- Android SDK with the official `android` CLI (`v1.0.15985488` verified) and
  `adb` on `PATH`.
- `@modelcontextprotocol/sdk` pinned to `v1.29.x`

## Usage

```bash
bun install
bun test        # run the unit test suite (in-memory CLI/adb runners)
bun typecheck   # TypeScript type checking (no emit)
```

## Device selection

Selection precedence: explicit device argument `--device` > `ANDROID_DEVICE`
env var > single-device auto-detection. With multiple attached devices and no
explicit selection, tools fail listing all available serials. Only state
`device` is a usable target; `unauthorized` and `offline` are surfaced in
errors, never silently skipped.

## Latency notes

- `adb shell input` is 100–500 ms per call; the input channel retries once on
  transient latency.
- `uiautomator dump` is 0.5–1 s; the `android` CLI `layout` returns flat JSON
  first, uiautomator XML as fallback.

## `/v1` bridge contract (stub)

The localhost bridge will expose:
- `GET /v1/state` — selected device, devices, emulators, frame summary.
- `GET /v1/screenshot` — raw PNG.
- `POST /v1/input/{tap,swipe,text}` — inject input.

Error body: `{"error":{"code","message","details?"}}`. See
`openspec/changes/android-device-bridge/design.md` for the locked contract.
<!-- /v1 bridge contract is a stub until the bridge slice lands. -->

## License

MIT
