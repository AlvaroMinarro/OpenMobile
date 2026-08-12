# Design: android-device-bridge

## Technical Approach

Single MIT Bun package, 3 entrypoints (bin→stdio MCP server, plugin, bridge daemon).
All device work sits in a shared `src/device/` core: `android` CLI wrapper (primary) +
`adb` wrapper (fallback/input), one selection rule (`--device` > `ANDROID_DEVICE` > auto-detect).
The MCP server routes ~12 tools through the core; the bridge daemon reuses the core over
localhost HTTP exposing the locked `/v1` contract (the OpenChamber seam); the plugin is a
thin subscriber that pushes compact snapshots into the session. Everything is validated by
`bun test` against in-memory CLI/adb runners (strict TDD at scaffold).

## Architecture Decisions

### D1: ui-tree `--diff` statelessness

**Choice**: Server owns the "baseline set" marker (in-memory per process); CLI owns the diff computation.

**Alternatives considered**: Server-persisted baselines (rejected — spec non-goal); blind `--diff` passthrough (rejected — stale diff after restart).

**Rationale** (verified against live CLI v1.0.15985488, decompiled `LayoutCommand`):
`--diff`'s baseline is **device-side** `/sdcard/window_dump.xml` written by `uiautomator dump` —
not in server memory or CLI host state. Every `layout` call (diff or full) runs
`rm /sdcard/window_dump.xml` + fresh dump, so the baseline is always "the last layout the
toolchain produced". When the prior dump is missing, the CLI itself falls back to a **full tree**
(stderr: "Failed to retrieve prior UI dump; returning full layout"). Diff output shape is
`{"added":[...],"modified":[...]}` (flattened element map, no `removed`); full output is the
UIElement tree. Server behavior:

- Keep `baselineEstablished: Set<serial>` in memory (resets on restart — satisfies "re-establishes baseline").
- First `get_ui_tree_diff(serial)` in process → `android layout` (full) → return `{baseline:"set", tree}`; mark serial.
- Later calls → `android layout --diff`; detect shape: diff keys → return changed elements; full-tree shape (CLI fallback) → return `{baseline:"re-set", tree}`. Never report a stale/misleading diff.

No device was attached during design, so both paths are designed but need live re-verification at apply.

### D2: local-bridge `/v1` contract (locked — see Interfaces)

**Choice**: Exact schema below; error body `{error:{code,message,details?}}`; **no shared-secret header required on localhost**.

**Alternatives considered**: mandatory bearer token (rejected — localhost loopback is the trust boundary; a token any local process can read adds friction for zero protection); `/v1` JSON with camelCase (kept — matches MCP tool arg conventions).

**Rationale**: Binding `127.0.0.1` only IS the security boundary; OpenChamber (2nd change) implements against this exact contract with zero coupling to repo internals. An optional `X-OpenMobile-Secret` header is a documented extension point (enabled via `OPENMOBILE_BRIDGE_SECRET`), default off — not part of the v1 requirement. Breaking changes land under `/v2`; non-breaking additive fields allowed within `/v1`.

### D3: emulator-lifecycle readiness

**Choice**: CLI-delegated readiness; server gate = adb state `device`; **no server-side `sys.boot_completed=1` polling by default**.

**Alternatives considered**: server-poll `sys.boot_completed=1` (rejected as primary — duplicates CLI logic and adds device chatter).

**Rationale**: The CLI help states `emulator start` "will return when the emulator is fully started and ready to use" — the CLI blocks until full boot (boot_completed included in its own readiness). The server wraps the call with an outer timeout (default 120s, configurable), then verifies via `adb devices` that the serial is state `device`; on timeout it returns an actionable error with serial + last observed state (per spec). `sys.boot_completed=1` remains a fallback verification enabled by flag if apply-time live checks show CLI return precedes boot completion.

### D4: agent-feedback-loop snapshot source

**Choice**: Plugin reads compact snapshots from the **bridge `GET /v1/state`** (localhost HTTP); throttle window **2000ms debounce** + content-hash dedupe.

**Alternatives considered**: calling MCP tools via OpenCode SDK (rejected — plugin has no MCP client wiring and spec non-goal forbids MCP client logic beyond reading snapshots); bridge screenshot polling (rejected — too heavy for context pushes).

**Rationale**: `/v1/state` already carries the exact compact summary (devices, selection, emulators, frame/layout summary) and is the same contract the OpenChamber surface consumes — one snapshot source, one contract. The full diff tree is already in agent context from the tool call itself; the plugin only refreshes the summary. Debounce coalesces rapid tool bursts to ≤1 push (spec); hash-dedupe skips no-op pushes; skip when no selected device.

## Data Flow

```
 Agent ──(stdio MCP)──▶ tools ──▶ src/device/ ──▶ android CLI / adb ──▶ Device
   ▲                        ▲          │
   │                        └──────────┘ (get_ui_tree_diff, input, deploy...)
   │
 Plugin: session.idle / tool.execute.after
   └─▶ GET /v1/state (bridge) ──▶ src/device/ ──▶ Device
        └─▶ compact snapshot ──▶ session.prompt({noReply:true}) ──▶ Agent context
 Bridge: GET /v1/state · GET /v1/screenshot · POST /v1/input/*  (OpenChamber seam)
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `package.json`, `bun.lock`, `tsconfig.json` | Create | Bun pkg, 3 entrypoints, pinned `@modelcontextprotocol/sdk` v1.29.x |
| `src/device/androidCli.ts` | Create | CLI wrapper: layout/diff, capture/annotate/resolve, emulator, install; version+feature detect |
| `src/device/adb.ts` | Create | adb fallback: devices/state, logcat, screencap, uiautomator, input injection |
| `src/device/selection.ts` | Create | `--device` > env > auto-detect; ambiguous error listing serials |
| `src/device/serialize.ts` | Create | UIElement→JSON, diff-shape detection, XML→tree fallback parser |
| `src/tools/` | Create | ~12 tool impls (device-discovery, emulator-lifecycle, deploy-app, ui-tree, screen-capture, logcat-read, input-channel) |
| `src/mcp-server.ts` | Create | stdio MCP server wiring tools through core |
| `src/bridge/server.ts`, `src/bridge/main.ts` | Create | localhost HTTP daemon: `/v1/*` routes, state cache, error mapping |
| `src/plugin/index.ts` | Create | OpenCode plugin: idle + tool.execute.after + compaction hook, debounce/dedupe |
| `test/` | Create | in-memory CLI/adb runners, versioned fixtures, contract tests |
| `opencode.json`, `.opencode/plugins/` | Create | Sample consumption config |
| `README.md`, `LICENSE` | Create | MIT, usage, latency notes, `/v1` contract reference |

## Interfaces / Contracts

### `GET /v1/state` → 200 (always 200; empty lists when no device)

```json
{
  "schema": "v1",
  "selected": { "serial": "emulator-5554", "state": "device", "model": "Pixel 9 Pro", "sdk": 36 },
  "devices": [ { "serial": "emulator-5554", "state": "device", "model": "Pixel 9 Pro" } ],
  "emulators": [ { "name": "Pixel_9_Pro", "running": true } ],
  "frame": { "width": 1080, "height": 2400, "elementCount": 42, "changedCount": 5, "layoutAt": "2026-08-12T17:00:00.000Z" },
  "bridge": { "version": "0.1.0", "pid": 4242 }
}
```

`selected` and `frame` are `null` when no usable device. `state` ∈ `device|unauthorized|offline`.

### `GET /v1/screenshot` → 200 `image/png` | error body when no device

### `POST /v1/input/*`

| Route | Body | Success |
|-------|------|---------|
| `/v1/input/tap` | `{"x":120,"y":340}` | `200 {"ok":true}` |
| `/v1/input/swipe` | `{"x1":1,"y1":2,"x2":3,"y2":4,"durationMs":500}` | `200 {"ok":true}` |
| `/v1/input/text` | `{"text":"hello"}` | `200 {"ok":true}` |

### Error body (all non-2xx)

```json
{ "error": { "code": "NO_DEVICE", "message": "No usable device selected.", "details": { "serials": ["emulator-5554"], "states": { "emulator-5554": "offline" } } } }
```

### Status codes

| Code | Meaning |
|------|---------|
| 400 `BAD_REQUEST` | Malformed body / missing field / out-of-range coords |
| 404 `NOT_FOUND` | Unknown route (only `/v1/*` served) |
| 409 `NO_DEVICE`/`DEVICE_UNAVAILABLE` | No usable device or not state `device` |
| 422 `INPUT_ERROR` | Text contains uninjectable chars (named) |
| 500 `INTERNAL` | Unexpected server error |

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | selection precedence, XML→JSON parse, logcat filter, diff-shape detection, error mapping | in-memory runners + fixtures |
| Integration | tool→device layer round trips; bridge contract status codes/bodies | in-memory CLI/adb runners |
| E2E | MCP stdio handshake; bridge HTTP routes; plugin debounce/dedupe | bun test + fake device state |

## Migration / Rollout

No migration required (greenfield, no consumers). Contract versioned `/v1`; a breaking change is a `/v2` path bump, `/v1` stays intact.

## Open Questions

- [ ] Live re-verify at apply: `layout --diff` output shapes (diff vs full-tree fallback) and `emulator start` return vs `sys.boot_completed=1` correlation on a booted AVD.
- [ ] Confirm OpenCode v1.18.16 `session.prompt({noReply:true})` + compaction hook signatures against installed version.
