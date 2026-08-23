# Design: bridge-surface-v2

**Approach**: additive `/v1` route adapters inside `createBridgeApp`/`buildRestHandler` delegating to proven tools handlers + zod schemas; ONE opt-in auth seam (`src/bridge/auth.ts`) invoked once per request/upgrade; a `LogcatHub` (mirrors `stream/fanout.ts`) driving one long-lived `adb -s <serial> logcat -T <n> -v time` spawn per subscriber. Device core untouched; seed unset => byte-identical legacy behavior.

## Decisions

### D1 — WS credential carry: subprotocol validated at upgrade, explicit echo
**Choice**: scan `sec-websocket-protocol` header for an exact entry `openmobile.bearer.<cred>`; on failure return a 401 `{error:{code,message}}` Response WITHOUT calling `server.upgrade()` (same pattern as the existing secret gate, server.ts:584) — failed handshake, never an open socket. On success pass `headers:{"sec-websocket-protocol":"<matched entry>"}` into `server.upgrade()`. Legacy `X-OpenMobile-Secret` also accepted at upgrade for non-browser clients.
**Rationale**: SPIKE-1-pinned (bun 1.4.0, pinned in test/ws-subprotocol-behavior.test.ts): `server.upgrade(req,{headers})` emits the explicit `sec-websocket-protocol` EXACTLY once on the 101 and REPLACES runtime auto-selection (duplication impossible). With no explicit header Bun AUTO-selects the FIRST client-offered protocol — never relied upon, since it can agree an entry that was never validated. Auth strength lives in refusal before `upgrade()`, never in the echo.
**Rejected**: query-param carry (spec: treated as no credential; leaks via logs/history/proxies); relying solely on runtime auto-negotiation. **SPIKE-1 fallback resolution**: verdict is echo-ok (no duplication), so the fallback (omit echo) stays unused — the explicit echo remains because it makes the agreed protocol deterministic under multi-entry offers.

### D2 — Token config surface
Env: seed = existing `OPENMOBILE_BRIDGE_SECRET`; `OPENMOBILE_BRIDGE_TOKEN_TTL` default 3600s; `OPENMOBILE_BRIDGE_TOKEN_TTL_MAX` cap default 86400s.
`POST /v1/auth/token`: bearer must equal seed (legacy secret header accepted); optional body `{"ttlSeconds":<int>}` clamped to `[60,cap]`; responds `200 {"token","expiresAt"(ISO-8601),"ttlSeconds"}`.
Token = 32-byte random base64url (valid RFC6455 token grammar). Registry stores ONLY SHA-256(token)->expiresAt in daemon memory; validation hashes the presented cred then `timingSafeEqual` against seed-hash / registry; expired entries purged lazily. Codes: unknown/missing -> `unauthorized`, expired -> `token_expired`.
Seed unset => issuance route not registered => standard 404 NOT_FOUND (byte-identical legacy surface).
**Rejected**: static env token (superseded by amended proposal); storing raw tokens (memory-dump leak).

### D3 — Stop idempotence + lifecycle status mapping live in ROUTE adapters
Each emulator adapter runs its own cheap `deps.cli.emulatorList()` pre-check BEFORE delegating: stop of existing-not-running AVD -> `200 {"stopped":name,"alreadyStopped":true}` with NO CLI stop issued; create duplicate -> 409 `avd_exists`; start/stop unknown AVD -> 404 `avd_not_found` + `details.available`. Surviving handler ToolError mapping: message matching the pinned boot-timeout text `/did not reach 'device' state within .*\(serial (\S+), last observed state: (\S+)\)/` -> 504 `boot_timeout {name,serial,lastState}`; else 500 INTERNAL_ERROR.
**Why**: MCP handlers stay byte-stable (one semantic source); HTTP-specific semantics belong at the HTTP seam; regex fragility pinned by contract tests (messages already spec-proven).
**Rejected**: typed-error refactor of handlers.ts (touches MCP surface — out of scope); relying only on handler-internal checks (no idempotence, no status codes).

### D4 — `/v1/state` selection source is conditional-additive
Resolution chain becomes explicit `?device=` > override > `ANDROID_DEVICE` > single-device auto. While an override is active, add sibling key `"selection":{"serial","source":"override"}` via the same conditional-spread precedent as `stream` (handleState, server.ts:288); no override => zero new keys => byte-identical. `selected` keeps carrying the resolved serial.
**Rejected**: always-present `device:{serial,source}` wrapper (breaks legacy consumers); renaming `selected`.

### D5 — Logcat live stream: one `-T` spawn per subscriber
New `src/stream/logcatHub.ts`. Subscribe: validate filter frame (zod) -> spawn `adb -s <serial> logcat -T <backlogClamped + HEADER_SLACK = 3> -v time <filterspecs...>`, backlogClamped = clamp(backlog ?? 100, 0, 1000); SPIKE-2-pinned over-fetch (test/logcat-backlog-accounting.test.ts) with the replay cut counting PARSED lines only. adb `-T <count>` prints the last N buffered lines THEN keeps following — replay+live in ONE process: no gap/dup window and device-buffer history satisfied (spec "30 most-recent"). backlog=0 => omit `-T`. Parse `-v time` lines using the existing `priorityOf` shape (adb.ts:40) extended to ts/priority/tag/pid/message; filterspec tags restricted to `[A-Za-z0-9._-]+`, priority from enum — argv-array spawn, no shell. Per-subscriber bounded queue with drop-oldest (Fanout drain pattern), subscriber cap 8 (MAX_VIEWERS alignment) => over-cap close 4429 VIEWER_CAP. Teardown: ws close => SIGTERM->SIGKILL child + registry remove; hub watchdog polls `adb.devices()` — serial gone => close 4409 naming serial (`DEVICE_LOST`, existing code map); natural child exit takes the same path. New OPTIONAL dep `adb.logcatFollow(serial,opts,onLine):{stop():Promise<void>}` on BridgeDeps — absent => route 404s (streaming-not-deployed precedent; legacy minimal test deps stay green).
**Rejected**: dump(`-d`)-then-follow two-process design (gap/dup risk); one shared spawn fanned out to subscribers (filter mismatch; fan-out redesign is a non-goal).

### D6 — Single auth seam
Replace the two scattered secret checks (REST server.ts:623, upgrade server.ts:584) with `authenticate(req): Response|null` called once in `fetch` before dispatch (REST incl. issuance) and once in the upgrade branch before any `server.upgrade()`. Accepts `Authorization: Bearer <seed|fresh-token>` or legacy `X-OpenMobile-Secret: seed`. Seed unset => returns null immediately (byte-identical fast path). CORS: enabled => reflect ONLY allow-listed origins from `OPENMOBILE_BRIDGE_ALLOWED_ORIGINS` (csv; default none => no ACAO header); disabled => legacy `requestOrigin||"*"` reflection untouched.
**Why**: one seam = one place enforcing hygiene (no echo/no log/timing-safe); spec requires EVERY route + every upgrade gated when enabled.
**Rejected**: per-route middleware wrappers (drift across 10+ routes); gating only new routes.

### D7 — Selection override state owned by main wiring
`BridgeDeps.selectionOverride?: {current(): string|null; set(serial:string): void}` implemented in main.ts as an in-memory holder (restart clears); consumed by `resolveSerial`/`handleState`/logcat targeting between explicit and env tiers. Route validates serial against attached devices (`404 device_not_found`, `details.attached`). Stale serial => actionable error naming it, never silent fallback (extends current env-tier behavior).
**Why**: deps stay narrow + fake-injectable; proposal mandates daemon-memory lifetime, no persistence.

## Module touch map

| File | Action | What |
|---|---|---|
| src/bridge/auth.ts | Create | AuthConfig, hashed token registry, `authenticate()`, issuance logic |
| src/bridge/server.ts | Modify | 5 route groups + issuance, D3 adapters, D4 state field, D6 seam, CORS narrowing, WS logcat branch, `WsConn.kind:"logcat"` |
| src/bridge/main.ts | Modify | env knob parsing, override store (D7), DeviceContext assembly for handler reuse, hub wiring |
| src/device/adb.ts | Modify | add `logcatFollow` long-running spawn reader (Bun.spawn incremental stdout -> line callback) |
| src/stream/logcatHub.ts | Create | subscriber registry, replay/live pump, drop-oldest queues, teardown + watchdog hook |
| src/stream/types.ts | Modify | LOGCAT_* constants (BACKLOG_CAP=1000, QUEUE_DEPTH, SUBSCRIBER_CAP=8) |
| src/tools/handlers.ts / schemas.ts | Reuse | exports exist; consumed via assembled DeviceContext — no semantic change |
| README.md | Modify | `/v1` contract: new routes, auth flow, browser caveats |
| test/* | New | auth suite, route contracts, hub unit tests (fake logcatFollow/runner), compat goldens |

## Auth flow sketch

```
env SEED --> AuthConfig{seedHash}
Browser                     REST client
  | POST /v1/auth/token       | Authorization: Bearer <seed|token>
  | Bearer <seed>             |--> authenticate(): hash -> timingSafeEqual(seedHash)
  |<-- 200 {token,expiresAt}  |    or registry lookup (expired? token_expired)
WS upgrade: sec-websocket-protocol: openmobile.bearer.<cred>
  --> validate at upgrade --> ok: server.upgrade(+echo) | fail: 401 JSON, no socket
```

## WS protocol details (logcat)

Client->Server (exactly ONE filter frame after open):
`{"tags":["ActivityManager"],"priority":"W","backlog":50}` — malformed => `{"type":"error","code":"validation_error","message":"..."}` then close 1008.
Server->Client line frame:
`{"type":"line","ts":"08-22 14:03:11.123","priority":"E","tag":"System.err","pid":1234,"message":"..."}`
Backlog/live boundary marker once replay ends: `{"type":"live"}`
Opportunistic drops: `{"type":"dropped","count":<n>}` · device loss: close 4409 reason naming serial.

## Threat matrix

| Boundary | Applicability | Design response / RED tests |
|---|---|---|
| New HTTP routing (`/v1/*` groups) | Applicable | zod schema validation before handlers; ToolError->status map (D3). RED: one contract test per route incl. error shapes |
| Shell/subprocess (`adb logcat -T` spawn) | Applicable | argv-array spawn (no shell); serial regex-checked, tags `[A-Za-z0-9._-]+`, priority enum. RED: injection-tag attempt yields sanitized argv, process exits cleanly |
| Git repository / commit / push / PR commands | N/A — change performs no VCS automation | — |
| Executable-file classification | N/A — spawns only fixed `adb` binary resolved by existing runner | — |

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Bun subprotocol echo quirks (SPIKE-1) | Explicit-header approach independent of auto-negotiation; documented fallback; spike gates spec wording only |
| `-T <count>` counts adb header lines (replay short by a few) | SPIKE-2-pinned HEADER_SLACK=3 + server-side count of parsed matching lines; real fixture showed headers OUTSIDE the count and even over-delivery (`-t 20` ⇒ 22 parsed + 2 headers) — confidence MEDIUM, `-T` not live-capturable (no device at spike time) |
| Boot-timeout regex mapping drifts if handler message changes | Contract tests pin messages; mapping isolated in ONE adapter function |
| Orphaned logcat processes on abrupt socket death | Watchdog sweep reaps subscribers whose socket is closed/dead; SIGKILL grace timer |
| In-memory token registry lost on restart | Accepted: clients re-mint from seed; seed persists via env |
| Message-regex + extra emulatorList latency | One cheap CLI round-trip per lifecycle op; pre-checks also produce better errors |

## Open items

- [x] SPIKE-1 RESOLVED: echo-ok — explicit `sec-websocket-protocol` emits exactly once and overrides auto-selection; Bun otherwise auto-picks the FIRST offered protocol (test/ws-subprotocol-behavior.test.ts; see D1).
- [x] SPIKE-2 RESOLVED: headers sit OUTSIDE the `-t` budget and dumps may over-deliver (`-t 20` ⇒ 22 parsed + 2 headers); pinned HEADER_SLACK=3 as defensive margin (test/logcat-backlog-accounting.test.ts; see D5).
- [ ] Confirm `OPENMOBILE_BRIDGE_ALLOWED_ORIGINS` default (none) is acceptable for OpenChamber embedding docs.

No migration required — opt-in env flag; unset => byte-for-byte legacy; rollback = unset env or revert commit.
