# Tasks: bridge-surface-v2

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 900–1400 (auth+REST routes ≈450–650; logcat stream ≈350–550; tests incl.; docs ≈60–100) |
| 400-line budget risk | High — even sliced units hover near the 400-line authored budget; Unit 1 is the likeliest overflow |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (auth+REST) → PR 2 (selection/state) → PR 3 (logcat WS) |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Work Units

| Unit | Goal | PR (base) | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Auth seam + issuance + REST adapters (lifecycle, ui-tree) — bridge-auth 6 reqs, local-bridge lifecycle/ui-tree/compat | PR 1 (base=main) | `bun test test/bridge-auth.test.ts test/bridge-routes.test.ts` | In-memory CLI/adb runners + fake DeviceContext (existing pattern); no real emulator needed | Revert PR 1 — additive routes, opt-in env; seed unset ⇒ legacy bytes restored |
| 2 | Selection override tier + `/v1/device/select` + `/v1/state` field — device-discovery MODIFIED, local-bridge select/state | PR 2 (base=Unit-1 branch) | `bun test test/device-selection.test.ts test/state-field.test.ts` | In-memory runners, two fake attached serials; restart simulated by re-wiring main.ts deps | Revert PR 2 — override is daemon-memory only, zero persistence/migrations |
| 3 | Logcat live stream: `logcatFollow` dep + LogcatHub + WS route — logcat-read ADDED, local-bridge WS route | PR 3 (base=Unit-2 branch) | `bun test test/logcat-hub.test.ts test/logcat-ws.test.ts` | Fake `logcatFollow` spawn doubles; no real adb required | Revert PR 3 — dep optional; absent ⇒ route 404s (streaming-not-deployed precedent) |

Spikes gate: Phase 0 MUST complete before tasks 1.5 (subprotocol echo) and 4.3 (`-T` accounting) are implemented — their outcomes pin D1/D5 wording.

## Phase 0: Design-Pinning Spikes

- [x] 0.1 SPIKE-1 (runtime): throwaway Bun script/test proving whether `server.upgrade(req,{headers})` echoes explicit `sec-websocket-protocol` on the 101 and whether Bun auto-negotiates; record verdict (echo-ok / duplication / absent) in design.md D1 fallback choice — gates task 1.5
- [x] 0.2 SPIKE-2 (fixtures): counting test over recorded `adb logcat -T <N> -v time` outputs measuring buffer-header lines vs parsed lines; pin replay-slack constant (+8) in design.md D5 — gates task 4.3

## Phase 1: Auth Seam — bridge-auth (Unit 1)

- [x] 1.1 RED: failing tests for AuthConfig parsing (`OPENMOBILE_BRIDGE_SECRET` seed, `OPENMOBILE_BRIDGE_TOKEN_TTL` default 3600, `_TTL_MAX` cap 86400) and seed-unset ⇒ disabled fast path [Auth unset keeps legacy behavior] → GREEN: create `src/bridge/auth.ts` (SHA-256 hashed seed, `timingSafeEqual`)
- [x] 1.2 RED: with seed set, credential-less request to any `/v1` route incl. legacy ones ⇒ 401 `{error:{code,message}}` [Auth enabled rejects anonymous access] → GREEN: D6 — replace both scattered checks (REST server.ts:623, upgrade server.ts:584) with single `authenticate(req)` invoked once in fetch + once before any `server.upgrade()`; accepts Bearer seed/token or legacy `X-OpenMobile-Secret`
- [x] 1.3 RED: `POST /v1/auth/token` — Bearer seed ⇒ 200 `{token(32B base64url), expiresAt ISO, ttlSeconds}` clamped to [60,cap]; wrong/missing ⇒ 401 `unauthorized`; seed unset ⇒ route never registered (legacy 404 bytes) [Issue token with valid seed; Issue rejected without seed] → GREEN: issuance logic + conditional registration
- [x] 1.4 RED: fresh token authenticates `GET /v1/state`; expired token ⇒ 401 `token_expired`; expired entries lazily purged [Fresh token accepted; Expired token rejected] → GREEN: hash-then-compare registry validation in `authenticate()`
- [x] 1.5 RED (post-SPIKE-1): WS upgrade — subprotocol entry `openmobile.bearer.<T>` ⇒ upgrade succeeds with echo per SPIKE-1 verdict; wrong/missing/expired ⇒ 401 JSON Response WITHOUT `server.upgrade()`; `?token=T` query treated as no credential; legacy secret header still honored at upgrade [Valid subprotocol upgrade; Wrong subprotocol rejected; Query-param credential refused] → GREEN: subprotocol scan in upgrade branch
- [x] 1.6 RED: invalid-bearer 401 body + captured bridge logs contain zero credential echo; comparison asserted timing-safe [Failed auth leaks nothing] → GREEN: redaction on request logging + error serialization
- [x] 1.7 RED: auth on + empty allow-list + `Origin: https://evil.example` ⇒ no ACAO reflection; allow-listed origin reflected; seed unset ⇒ legacy `requestOrigin||"*"` untouched [Cross-origin blocked while auth on] → GREEN: `OPENMOBILE_BRIDGE_ALLOWED_ORIGINS` csv parsing in server.ts
- [x] 1.8 Byte-identical proof test: seed-unset goldens for all pre-existing `/v1` routes match pre-change fixtures exactly [Auth unset keeps legacy behavior; Legacy surface untouched]

## Phase 2: Lifecycle + UI-Tree Adapters — local-bridge (Unit 1 cont.)

- [x] 2.1 RED: `POST /v1/emulator/start` happy path ⇒ 200 `{started, serial}` at `device` state; malformed body ⇒ 422 `validation_error` [Successful start returns serial] → GREEN: start adapter delegating to tools handler + zod schema via assembled DeviceContext
- [x] 2.2 RED: create duplicate name ⇒ 409 `avd_exists` with zero CLI create issued; start/stop unknown AVD ⇒ 404 `avd_not_found` + `details.available` [Duplicate AVD rejected; Unknown AVD listed] → GREEN: D3 cheap `emulatorList()` pre-checks inside adapters
- [x] 2.3 RED: handler ToolError matching pinned boot-timeout regex ⇒ 504 `boot_timeout{name,serial,lastState}`; any other ToolError ⇒ 500 `INTERNAL_ERROR` [Boot timeout surfaced] → GREEN: ONE mapping function (regex drift isolated)
- [x] 2.4 RED: stopping a known stopped AVD twice ⇒ both 200, second `alreadyStopped:true`, no CLI stop issued [Double stop is idempotent] → GREEN: route-layer idempotence check
- [x] 2.5 RED: `GET /v1/ui-tree` populated ⇒ 200 `{serial, empty:false, tree}` shape-equal to local `get_ui_tree`; empty hierarchy ⇒ 200 `empty:true, tree:[]`, never an HTTP error [Tree mirrors local tool; Empty UI signalled in-band] → GREEN: read-only adapter
- [x] 2.6 Unit 1 green gate: `bun test` + `bun run typecheck` green; work-unit commit for PR 1; verify authored diff ≤~400 lines else flag overflow in PR description

## Phase 3: Selection Override + State Field — device-discovery/local-bridge (Unit 2)

- [x] 3.1 RED: `selectionOverride` holder — `set`/`current()` in-memory; simulated daemon restart ⇒ null [Restart clears override (local-bridge); Restart clears override (device-discovery)] → GREEN: D7 holder in main.ts exposed via `BridgeDeps.selectionOverride`
- [x] 3.2 RED: precedence matrix — `?device=` beats override; override beats `ANDROID_DEVICE`; env beats auto; multi-device ambiguity error lists all serials; single-device auto intact; stale override serial ⇒ actionable error naming it, never silent fallback [Explicit flag wins; Ambiguous selection; Single device auto-detect; Override beats environment; Request parameter beats override; Stale selected serial errors] → GREEN: insert override tier between explicit and env in resolveSerial consumers (state, ui-tree, logcat targeting)
- [x] 3.3 RED: `POST /v1/device/select` attached serial ⇒ 200 `{selected}`; unknown serial ⇒ 404 `device_not_found` + `details.attached` [Select attached serial; Invalid serial rejected] → GREEN: route adapter validating against attached devices
- [x] 3.4 RED: `GET /v1/state` with active override adds sibling `"selection":{"serial","source":"override"}` and `selected` = resolved serial; no override ⇒ zero new keys byte-identical [State reflects selection override; State request; No device] → GREEN: conditional spread in handleState (stream-field precedent server.ts:288)
- [x] 3.5 Unit 2 green gate: `bun test` + `bun run typecheck`; work-unit commit stacked on Unit-1 branch

## Phase 4: Logcat Live Stream — logcat-read/local-bridge (Unit 3)

- [x] 4.1 RED: `logcatFollow` argv contract — exact argv-array `adb -s <serial> logcat -T <n> -v time <filterspecs…>`; hostile tag (`"; rm -rf"`) rejected by `[A-Za-z0-9._-]+` validation; priority enum enforced; incremental stdout→line callback; `stop()` terminates child [Threat-matrix shell boundary] → GREEN: optional `BridgeDeps.adb.logcatFollow` in src/device/adb.ts; absent ⇒ route 404s
- [x] 4.2 RED: `-v time` parser — line ⇒ `{ts, priority, tag, pid, message}` extending existing `priorityOf` shape (adb.ts:40); unparseable lines skipped [Live Log Stream per-line metadata] → GREEN: parser beside `priorityOf`
- [x] 4.3 RED (post-SPIKE-2): replay — subscribe `backlog:30` with ≥30 buffered ⇒ exactly 30 most-recent matching first, then `{"type":"live"}`, then live only; clamp [0,1000] default 100; `backlog:5000` ⇒ capped 1000, stream proceeds; `backlog:0` ⇒ skips replay instantly [Backlog precedes live; Cap enforced on oversized backlog; Zero backlog skips replay] → GREEN: hub spawn options incl. SPIKE-2 slack constant
- [x] 4.4 RED: filters — `{tags:[ActivityManager,System.err],priority:"W"}` ⇒ only System.err(E) delivered (tag union ∩ priority floor); `{}` ⇒ all tags ≥E; identical filtering for replay and live [Filter composition; Defaults apply] → GREEN: hub filter engine applied to both phases
- [x] 4.5 RED: exactly ONE filter frame per connection; malformed `{"backlog":"many"}` ⇒ `{"type":"error","code":"validation_error"}` frame then close 1008 [Malformed filter rejected] → GREEN: zod frame validation in WS message branch
- [x] 4.6 RED: slow consumer — stalled reader under rapid emission ⇒ bounded queue drop-oldest, newest keep flowing, socket stays open, opportunistic `{"type":"dropped","count":n}` [Slow consumer stays connected] → GREEN: port Fanout drain pattern + `QUEUE_DEPTH` in src/stream/types.ts
- [x] 4.7 RED: ninth concurrent subscriber ⇒ close 4429 `VIEWER_CAP` [supports Live Log Stream capacity bounds] → GREEN: `SUBSCRIBER_CAP=8` registry enforcement
- [x] 4.8 RED: client close ⇒ child SIGTERM→SIGKILL, registry entry removed, sibling subscribers unaffected, fresh subscription fully functional; watchdog sweep reaps dead sockets with SIGKILL grace timer [Close tears down cleanly] → GREEN: per-subscriber teardown + orphan sweep
- [x] 4.9 RED: mid-stream detach ⇒ close 4409 reason `DEVICE_LOST` naming serial; natural child exit follows same path [Device loss mid-stream] → GREEN: hub watchdog polling `adb.devices()`
- [x] 4.10 RED: E2E WS contract on `WS /v1/logcat/ws` (fake logcatFollow) — send `{"priority":"E","backlog":10}` ⇒ ≤10 recent matching lines then unprompted live lines; upgrade refused without valid credential when auth on [Subscribe and receive; Live delivery without polling; Auth gate applies] → GREEN: `WsConn.kind:"logcat"` branch in buildRestHandler
- [x] 4.11 Unit 3 green gate: `bun test` + `bun run typecheck`; work-unit commit stacked on Unit-2 branch

## Phase 5: Docs + Whole-Change Verification

- [x] 5.1 README `/v1` contract: five route groups + issuance flow (seed → mint token → Bearer/subprotocol), TTL knobs, `OPENMOBILE_BRIDGE_ALLOWED_ORIGINS`, selection precedence table, browser caveats (loopback posture; embedders enable auth by default)
- [x] 5.2 Final gate: full `bun test` + `bun run typecheck` across the change; tick proposal Success Criteria (seed-unset byte-identity, five route groups, browser WS with zero custom headers)

## Decisions / Blockers

- SPIKE-1/SPIKE-2 outcomes must be recorded in design.md before tasks 1.5 / 4.3 start — they pin D1/D5 implementation wording.
- Chain strategy (stacked-to-main confirmed?) and Unit-1 overflow policy (split further vs size:exception) — user decision before apply.
