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

## Requirements

- Bun (runtime + test runner)
- Android SDK with the official `android` CLI (`v1.0.159854788` verified) and
  `adb` on `PATH`.
- `@modelcontextprotocol/sdk` pinned to `v1.29.x`

## Usage

```bash
bun install
bun test        # run the unit test suite (in-memory CLI/adb runners)
bun typecheck   # TypeScript type checking (no emit)
```

### MCP server (stdio)

```bash
bun run mcp-server        # stdio MCP server exposing the ~12 device tools
```

### Bridge daemon (localhost)

```bash
bun src/bridge/main.ts    # /v1 HTTP daemon on http://127.0.0.1:8765 (loopback)
```

Config via env:

| Env var | Default | Purpose |
|---------|---------|---------|
| `OPENMOBILE_BRIDGE_PORT` | `8765` | Loopback port for the `/v1` bridge. `0` = ephemeral. |
| `OPENMOBILE_BRIDGE_SECRET` | *(off)* | When set, every request must carry `X-OpenMobile-Secret`. Loopback is the trust boundary, so it is off by default. |

### OpenCode feedback-loop plugin

The plugin keeps the agent's context fresh with compact device snapshots. It is
**thin**: it reads device state purely from the local bridge `GET /v1/state`
(no MCP client wiring) and pushes a compact summary into the session.

- Triggers: `session.idle` and `tool.execute.after`.
- Push: `client.session.prompt({ noReply: true, prompt: <snapshot> })` — injected
  into context **without** triggering a reply.
- Throttle: **2000ms debounce** + **SHA-256 content-hash dedupe** — a burst of
  tool calls coalesces to at most one push, and unchanged state is never re-pushed.
- Skip: no push when no usable device is selected.
- Compaction: `experimental.session.compacting` carries the current snapshot
  across compaction via `output.context.push`.
- Bridge-down: fetch failures are logged and skipped — the plugin never crashes
  the session.

Wire it via package export, or load the **local** sample straight from source
(before publishing) by pointing OpenCode at `.opencode/plugins/`:

```jsonc
// .opencode/opencode.json — loads the plugin without publishing
{
  "plugin": [{ "id": "openmobile", "path": "./.opencode/plugins/openmobile.ts" }]
}
```

`.opencode/plugins/openmobile.ts` re-exports the plugin from this repo's
TypeScript source, so you can run it as-is. Once the package is published, you
can switch to the package export instead:

```jsonc
{
  "plugin": [{ "id": "openmobile", "path": "node_modules/@openmobile/android-device-bridge/plugin" }]
}
```

It consumes the same `OPENMOBILE_BRIDGE_PORT` / `OPENMOBILE_BRIDGE_SECRET` env
knobs as the bridge.

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

## `/v1` bridge contract

The localhost bridge exposes (loopback `127.0.0.1`; bind host + port via env):

- `GET /v1/state` → `200` always (empty lists when no device):
  `{ "selected": {...}|null, "frame": {...}|null, "devices": [...], "emulators": [...], "stream"?: {...} }`
  The additive `stream` object (present when streaming is wired):
  `{ supported, active, reason?, viewers, width?, height? }`.
- `GET /v1/screenshot` → `200 image/png`, or an error body when no usable device.
- `POST /v1/input/tap`   body `{"x","y"}` → `200`
- `POST /v1/input/swipe` body `{"x1","y1","x2","y2","durationMs"?}` → `200`
- `POST /v1/input/text`  body `{"text"}` → `200`

Error body (all non-2xx): `{"error":{"code","message","details?"}}`.
Status codes: `400 BAD_REQUEST`, `401 UNAUTHORIZED`, `404 NOT_FOUND`,
`409 NO_DEVICE/DEVICE_OFFLINE/AMBIGUOUS_DEVICE/STREAM_OFF`, `422 VALIDATION_ERROR`,
`500 INTERNAL_ERROR`. Contract is versioned: breaking changes land under `/v2`.

### Streaming WebSockets (device streaming)

Live H.264 streaming over loopback WebSockets, enabled by default; set
`OPENMOBILE_STREAM=off` to disable (WS routes reject, `/v1/state` reports
`stream.supported:false`). The stream starts on the FIRST video viewer and
tears down when the last one disconnects or the device is lost (watchdog).

- **`WS /v1/stream/video`** — server → client:
  1. JSON handshake first: `{type:"handshake", codec:"h264", lengthSize:12,
     width, height, sps, pps}` (SPS/PPS base64 after the Annex-B start code),
  2. then ONE binary Annex-B access unit per message (SPS/PPS/IDR/slice),
  3. JSON state messages: `{type:"state", state:"buffering"|"streaming"|"error",
     reason?}`.
  Per-viewer drop-oldest under backpressure (queue depth 4); max 8 viewers.
- **`WS /v1/stream/control`** — client → server JSON:
  `{type:"inject", event:"tap", x, y}` |
  `{type:"inject", event:"swipe", x1, y1, x2, y2, durationMs?}` |
  `{type:"inject", event:"text", text}` |
  `{type:"inject", event:"key", keycode}`.
  Server → client: `{type:"ack"}` | `{type:"error", code, message}`.
  Coordinates are in VIDEO space (e.g. 430×960 with `max_size=960`), not
  device pixels. Rejected with `409 STREAM_OFF` when no stream is active
  (fall back to `POST /v1/input/*`).
- **Close codes**: `4403` unsupported (kill-switch off), `4404` no usable
  device, `4429` viewer cap, `4409` device lost mid-stream. The secret gate
  and CORS apply to WS upgrades exactly like REST.
- Input routing rule: while `stream.active:true`, input goes through the
  control socket; otherwise `adb shell input` (REST) — same coordinate
  semantics and range validation in both modes.

## License

MIT
