# OpenMobile — android-device-bridge

Expose an Android device to coding agents and tooling. A single Bun package that
provides:

- **Device core** (`src/device/`) — the `android` CLI wrapper (primary) and `adb`
  fallback, shared device selection, and serialization. Used by both the MCP
  server and the bridge daemon.
- **MCP server** (`src/mcp-server.ts`) — a stdio server exposing ~12 tools that
  route through the device core.
- **Localhost bridge** (`src/bridge/`) — an HTTP daemon serving the `/v1`
  contract (state, screenshot, input, emulator lifecycle, UI tree, device
  selection, logcat live streaming) with opt-in token auth for browser
  surfaces such as OpenChamber.
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
| `OPENMOBILE_BRIDGE_SECRET` | *(off)* | Seed secret. When set, every `/v1` request and WS upgrade must carry a credential and `POST /v1/auth/token` mints tokens. Loopback is the trust boundary, so it is off by default. |
| `OPENMOBILE_BRIDGE_TOKEN_TTL` | `3600` | Default lifetime (seconds) of minted tokens; requests clamp to ≥ 60. |
| `OPENMOBILE_BRIDGE_TOKEN_TTL_MAX` | `86400` | Server-enforced cap for requested token lifetimes. |
| `OPENMOBILE_BRIDGE_ALLOWED_ORIGINS` | *(none)* | While auth is on: csv of origins eligible for CORS reflection (default none ⇒ no ACAO header at all). Auth off keeps legacy reflect-any-origin. |

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

Selection precedence: explicit device argument `--device` / `?device=` >
runtime HTTP override (`POST /v1/device/select`, daemon-memory only) >
`ANDROID_DEVICE` env var > single-device auto-detection. With multiple
attached devices and no explicit selection, tools fail listing all available
serials. Only state `device` is a usable target; `unauthorized` and `offline`
are surfaced in errors, never silently skipped.

## Latency notes

- `adb shell input` is 100–500 ms per call; the input channel retries once on
  transient latency.
- `uiautomator dump` is 0.5–1 s; the `android` CLI `layout` returns flat JSON
  first, uiautomator XML as fallback.

## `/v1` bridge contract

The localhost bridge serves five route groups under `/v1` (loopback
`127.0.0.1`; bind host + port via env). Everything here is additive: with
`OPENMOBILE_BRIDGE_SECRET` unset the surface behaves exactly as it did before.

### Core device routes

- `GET /v1/state` → `200` always (empty lists when no device):
  `{ "selected": {...}|null, "frame": {...}|null, "devices": [...], "emulators": [...], "stream"?: {...}, "selection"?: {"serial","source":"override"} }`
  The additive `stream` object (present when streaming is wired):
  `{ supported, active, reason?, viewers, width?, height? }`. The additive
  `selection` sibling appears only while a selection override is active —
  without one those keys are absent entirely.
- `GET /v1/screenshot` → `200 image/png`, or an error body when no usable device.
- `POST /v1/input/tap`   body `{"x","y"}` → `200`
- `POST /v1/input/swipe` body `{"x1","y1","x2","y2","durationMs"?}` → `200`
- `POST /v1/input/text`  body `{"text"}` → `200`

### Emulator lifecycle

Bodies reuse the local tool schemas; success payloads pass through
byte-shape-equal to the MCP handlers.

- `POST /v1/emulator/start` body `{"name"}` → `200 {"started","serial"}`
- `POST /v1/emulator/stop`  body `{"name"}` → `200 {"stopped",...}`; stopping
  a known not-running AVD issues no CLI stop, and repeat calls answer
  `"alreadyStopped":true`.
- `POST /v1/emulator/create` body `{"name"}` → `200 {"created":"<name>"}`.

Errors: duplicate name ⇒ `409 avd_exists` (nothing created); unknown AVD ⇒
`404 avd_not_found` with `details.available`; boot timeout ⇒ `504 boot_timeout`
detailing `{name?, serial, lastState}`; malformed body ⇒ `422 validation_error`.

### Device selection & UI tree

- `POST /v1/device/select` body `{"serial"}` → `200 {"selected"}`; unknown
  serial ⇒ `404 device_not_found` with `details.attached`. The override lives
  in daemon memory only (a restart clears it) and surfaces in `/v1/state`.
- `GET /v1/ui-tree` → `200 {"serial","empty","tree"}` — same JSON shape as the
  local `get_ui_tree` tool; an empty hierarchy is signalled in-band
  (`empty:true`), never as an HTTP error.

Selection precedence (highest wins):

| Tier | Source |
|------|--------|
| 1 | Explicit `?device=<serial>` query parameter |
| 2 | Runtime override (`POST /v1/device/select`) |
| 3 | `ANDROID_DEVICE` env var |
| 4 | Single-device auto-detection |

With multiple devices attached and no explicit tier, requests fail listing all
serials; a stale override serial errors naming it — never a silent fallback.

### Logcat live stream

- **`WS /v1/logcat/ws`** — ONE long-lived `adb logcat -T <n> -v time <specs>`
  spawn per subscriber: replay and live come from the same process, so there
  is no gap/duplication window. After the upgrade the client sends exactly ONE
  filter frame:
  `{"tags":["ActivityManager"],"priority":"W","backlog":50}`
  (tags match `[A-Za-z0-9._-]+`, priority `V`–`S`, backlog clamped to
  `[0,1000]`, default `100`). The server then delivers up to `backlog` matching
  recent records, sends `{"type":"live"}`, and streams live-only:
  - line frame: `{"type":"line","ts","priority","tag","pid","message"}`
  - slow-consumer notice: `{"type":"dropped","count":n}` — bounded queue with
    drop-oldest; the socket never closes for being slow
  - malformed or duplicate filter frame: `{"type":"error","code":"validation_error","message"}`
    then close `1008`
  - close codes: `4429` subscriber cap (8 per bridge), `4409` device lost
    mid-stream (reason names the serial)

### Token issuance (auth flow)

Setting `OPENMOBILE_BRIDGE_SECRET` (the seed) gates EVERY route and WS
upgrade. Credentials: `Authorization: Bearer <seed|token>`, legacy
`X-OpenMobile-Secret: <seed>` header, or — because browsers cannot attach
headers to WebSocket upgrades — a requested subprotocol entry
`openmobile.bearer.<token>`. Query-param credentials are refused.

1. Mint: `POST /v1/auth/token`, authenticated AS THE SEED, optional body
   `{"ttlSeconds":<int>}` → `200 {"token","expiresAt"(ISO),"ttlSeconds"}`,
   TTL clamped to `[60, OPENMOBILE_BRIDGE_TOKEN_TTL_MAX]` (default from
   `OPENMOBILE_BRIDGE_TOKEN_TTL`). Wrong/missing credential ⇒
   `401 unauthorized`; seed unset ⇒ the route is not registered (legacy 404).
2. Call: present the token as Bearer credential or subprotocol entry until it
   expires ⇒ `401 token_expired`; mint again from the seed.
3. Rotate: restart with a new seed. Tokens are stored hashed, in daemon memory
   only — they die with the process, and a token can never mint more tokens.

While auth is on, CORS reflects ONLY origins listed in
`OPENMOBILE_BRIDGE_ALLOWED_ORIGINS` (csv; default none ⇒ no ACAO header at
all). Auth off keeps the legacy loopback posture (any origin reflected).

### Browser caveats

- Binding stays loopback `127.0.0.1`: token auth exists to keep OTHER local
  pages out (DNS-rebinding/CSRF posture), not to enable remote access.
- Embedders driving the bridge from a web page should enable auth by default
  (set a seed) and allow-list their page origin.
- Non-browser clients may keep using `X-OpenMobile-Secret`.

Error body (all non-2xx): `{"error":{"code","message","details?"}}`.
Status map: `400 BAD_REQUEST`, `401 UNAUTHORIZED/TOKEN_EXPIRED`,
`404 NOT_FOUND/AVD_NOT_FOUND/DEVICE_NOT_FOUND`,
`409 NO_DEVICE/DEVICE_OFFLINE/AMBIGUOUS_DEVICE/STREAM_OFF/AVD_EXISTS`,
`422 VALIDATION_ERROR`, `504 BOOT_TIMEOUT`, `500 INTERNAL_ERROR`. Contract is
versioned: breaking changes land under `/v2`.

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

### Browser client (`./stream-client`)

Framework-free browser helper implementing the contract above (design D7).
Chromium-based browsers decode H.264 in real time with WebCodecs; Firefox and
platforms without an H.264 decoder report `false` from `isStreamSupported()`
and the surface falls back to polling (`/v1/screenshot` driven).

```ts
import { createStreamClient, isStreamSupported } from "@openmobile/android-device-bridge/stream-client";

if (!isStreamSupported()) {
  // polling fallback (REST screenshot + /v1/input/*)
  return;
}
const client = createStreamClient({
  url: "ws://127.0.0.1:8765/v1/stream/video", // control URL derived (/video → /control)
  canvas, // caller-owned <canvas>
  onStatus: (s) => { /* connecting | handshake | streaming | {error,message} | {closed,code?} */ },
});
await client.open();
client.sendInput({ type: "inject", event: "tap", x: 215, y: 480 }); // video-space coords
```

- `open()` gates on the support probe and reports `{phase:"error"}` when
  unsupported, so the caller can switch to polling before opening sockets.
- `sendInput()` returns `false` when the control socket is not open (no
  active stream) — route input through `POST /v1/input/*` in that case.
- `onMessage` (optional, assignable) receives server contract messages:
  `{type:"state",…}` on the video socket, `{type:"ack"}` / `{type:"error",…}`
  on the control socket. `client.videoSize` exposes the handshake size once
  the stream is configured.
- Close codes surface through `onStatus` (`4403/4404/4429/4409`).
- **Auth caveat**: browsers cannot attach custom headers to WebSocket
  upgrades, so authenticate stream sockets with a requested subprotocol entry
  `openmobile.bearer.<token>` (minted via `POST /v1/auth/token`) instead of
  `X-OpenMobile-Secret`. Embedders should enable auth by default when serving
  the bridge to a browser page; with auth off, loopback remains the trust
  boundary and any local page can drive the daemon.

Demo page: `examples/stream.html` (open it in a browser while the bridge
streams; tap the canvas to inject taps). The client bundle it imports is
generated — regenerate with `bun run build:stream-demo`.

## License

MIT
