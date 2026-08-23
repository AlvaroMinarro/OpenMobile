```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:0e1bbb63668000cf1d25e043188f4f3f076cbd648ee99e18185d30abfc74b3e5
verdict: pass
blockers: 0
critical_findings: 0
requirements: 18/18
scenarios: 44/44
test_command: bun test
test_exit_code: 0
test_output_hash: sha256:063481988bf5d9b54241f25a60c54504a4a796078d3dfd771f10ccf6dd00c612
build_command: bun run typecheck
build_exit_code: 0
build_output_hash: sha256:8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92
```

## Verification Report

**Change**: bridge-surface-v2
**Version**: N/A (delta specs carry no explicit version header)
**Mode**: Strict TDD

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total | 34 |
| Tasks complete | 34 |
| Tasks incomplete | 0 |

### Build & Tests Execution
**Build**: ✅ Passed
```text
$ bun run typecheck
$ tsc --noEmit
exit code: 0
output sha256: 8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92
(identical digest to the apply-phase final-gate record — tree unchanged since apply settled)
```

**Tests**: ✅ 474 passed / ❌ 0 failed / ⚠️ 0 skipped
```text
$ bun test
bun test v1.4.0 (34cbb9a40)

 474 pass
 0 fail
 1712 expect() calls
Ran 474 tests across 31 files. [8.39s]
exit code: 0
output sha256: 063481988bf5d9b54241f25a60c54504a4a796078d3dfd771f10ccf6dd00c612
```

**Coverage**: ➖ Not available (no coverage tooling configured in package.json; skipped by orchestrator instruction)

### Spec Compliance Matrix
Counts re-counted from the actual delta spec files this session: bridge-auth 6 req / 11 scen · local-bridge 6 req / 16 scen · device-discovery 1 req / 7 scen · logcat-read 5 req / 10 scen = **18 requirements / 44 scenarios**.

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| bridge-auth / Opt-In Authentication Gate | Auth unset keeps legacy behavior | `bridge-routes.test.ts > seed-unset goldens (state/tap/swipe/text/screenshot/404/OPTIONS/auth-token-404)` + `bridge-auth.test.ts > seed unset ⇒ upgrades stay credential-less` | ✅ COMPLIANT |
| bridge-auth / Opt-In Authentication Gate | Auth enabled rejects anonymous access | `bridge-routes.test.ts > 401 JSON {error:{code,message}} for a credential-less GET /v1/state` + `> gates EVERY /v1 route incl. legacy POST ones` | ✅ COMPLIANT |
| bridge-auth / Token Issuance Endpoint | Issue token with valid seed | `bridge-routes.test.ts > Bearer seed ⇒ 200 {token(32B base64url), expiresAt ISO future, ttlSeconds 3600}` | ✅ COMPLIANT |
| bridge-auth / Token Issuance Endpoint | Issue rejected without seed | `bridge-routes.test.ts > wrong or missing credential ⇒ 401 unauthorized, no token issued` (+ token-cannot-mint case) | ✅ COMPLIANT |
| bridge-auth / Token Expiry Validation | Fresh token accepted | `bridge-routes.test.ts > a freshly issued token authenticates GET /v1/state end-to-end` | ✅ COMPLIANT |
| bridge-auth / Token Expiry Validation | Expired token rejected | `bridge-routes.test.ts > an expired token ⇒ 401 token_expired, purged lazily from the registry` | ✅ COMPLIANT |
| bridge-auth / WebSocket Subprotocol Authentication | Valid subprotocol upgrade | `bridge-auth.test.ts > valid openmobile.bearer.<T> entry upgrades and is ECHOED explicitly over a competing offer` + `logcat-ws.test.ts > auth gate applies` | ✅ COMPLIANT |
| bridge-auth / WebSocket Subprotocol Authentication | Wrong subprotocol rejected | `bridge-auth.test.ts > wrong subprotocol credential ⇒ 401 JSON Response WITHOUT server.upgrade()` (+ missing/expired variants) | ✅ COMPLIANT |
| bridge-auth / WebSocket Subprotocol Authentication | Query-param credential refused | `bridge-auth.test.ts > ?token=T query is treated as NO credential — refused exactly like none` | ✅ COMPLIANT |
| bridge-auth / Credential Hygiene | Failed auth leaks nothing | `bridge-routes.test.ts > invalid-bearer 401 body contains zero echo` + `> bridge logs stay free of credential material` + `> error serialization never gains credential carriers` | ✅ COMPLIANT |
| bridge-auth / CORS Narrowing While Authenticated | Cross-origin blocked while auth on | `bridge-routes.test.ts > auth on + empty allow-list ⇒ evil Origin gets NO access-control-allow-origin` | ✅ COMPLIANT |
| local-bridge / Emulator Lifecycle Routes | Successful start returns serial | `bridge-lifecycle.test.ts > happy path with an explicit name responds 200 {started, serial}` | ✅ COMPLIANT |
| local-bridge / Emulator Lifecycle Routes | Duplicate AVD rejected | `bridge-lifecycle.test.ts > duplicate create responds 409 avd_exists and issues ZERO CLI creates` | ✅ COMPLIANT |
| local-bridge / Emulator Lifecycle Routes | Unknown AVD listed | `bridge-lifecycle.test.ts > start of an unknown AVD responds 404 avd_not_found with details.available` | ✅ COMPLIANT |
| local-bridge / Emulator Lifecycle Routes | Boot timeout surfaced | `bridge-lifecycle.test.ts > maps the pinned boot-timeout message to 504 boot_timeout {name,serial,lastState}` + `> surfaces a real boot timeout through POST /v1/emulator/start as 504` | ✅ COMPLIANT |
| local-bridge / Emulator Lifecycle Routes | Double stop is idempotent | `bridge-lifecycle.test.ts > stopping a known stopped AVD twice answers 200 twice; second is alreadyStopped; zero CLI stops` | ✅ COMPLIANT |
| local-bridge / Device Selection Route | Select attached serial | `device-selection.test.ts > attached serial ⇒ 200 {selected} and becomes the RUNTIME selection (next op targets it)` | ✅ COMPLIANT |
| local-bridge / Device Selection Route | Invalid serial rejected | `device-selection.test.ts > unknown serial ⇒ 404 device_not_found with details.attached naming what IS attached` | ✅ COMPLIANT |
| local-bridge / Device Selection Route | Restart clears override | `device-selection.test.ts > simulated restart (fresh wiring) drops the selection — tiers rule again` + `> simulated daemon restart (re-wired deps) yields null` | ✅ COMPLIANT |
| local-bridge / UI Tree Route | Tree mirrors local tool | `bridge-lifecycle.test.ts > populated hierarchy responds 200 {serial, empty:false, tree} shape-equal to the local tool` | ✅ COMPLIANT |
| local-bridge / UI Tree Route | Empty UI signalled in-band | `bridge-lifecycle.test.ts > an EMPTY hierarchy is signalled IN-BAND as 200 empty:true tree:[] — never an HTTP error` | ✅ COMPLIANT |
| local-bridge / Logcat WebSocket Route | Subscribe and receive | `logcat-ws.test.ts > subscribe-and-receive: ≤10 recent matching lines, live marker, then unprompted live lines` | ✅ COMPLIANT |
| local-bridge / Logcat WebSocket Route | Auth gate applies | `logcat-ws.test.ts > auth gate applies: credential-less upgrade refused 401; valid subprotocol upgrades and streams` | ✅ COMPLIANT |
| local-bridge / Additive Route Compatibility | Legacy surface untouched | `bridge-routes.test.ts > seed-unset goldens (task 1.8)` suite — byte-for-byte contract assertions on all pre-existing routes | ✅ COMPLIANT |
| local-bridge / Device State Endpoint (MODIFIED) | State request | `bridge.test.ts > returns 200 always, with schema/bridge metadata, selected/frame (nullable) and device+emulator lists` | ✅ COMPLIANT |
| local-bridge / Device State Endpoint (MODIFIED) | No device | `state-field.test.ts > no device attached keeps the legacy 200 empty-list contract untouched` | ✅ COMPLIANT |
| local-bridge / Device State Endpoint (MODIFIED) | State reflects selection override | `state-field.test.ts > override resolving 'selected' adds sibling selection {serial, source:'override'} and selected reports it` | ✅ COMPLIANT |
| device-discovery / Device Selection (MODIFIED) | Explicit flag wins | `device-selection.test.ts > explicit ?device= beats the override` + `bridge.test.ts > honors the ?device explicit serial over env` | ✅ COMPLIANT |
| device-discovery / Device Selection (MODIFIED) | Ambiguous selection | `device-selection.test.ts > multi-device ambiguity error lists ALL serials (unchanged legacy rule)` | ✅ COMPLIANT |
| device-discovery / Device Selection (MODIFIED) | Single device auto-detect | `device-selection.test.ts > single-device auto-detect intact (no env, no override)` | ✅ COMPLIANT |
| device-discovery / Device Selection (MODIFIED) | Override beats environment | `device-selection.test.ts > override beats ANDROID_DEVICE env` | ✅ COMPLIANT |
| device-discovery / Device Selection (MODIFIED) | Request parameter beats override | `device-selection.test.ts > explicit ?device= beats the override` + `state-field.test.ts > explicit ?device= beats the override for THIS request` | ✅ COMPLIANT |
| device-discovery / Device Selection (MODIFIED) | Stale selected serial errors | `device-selection.test.ts > stale override on a routed op: 409 naming emulator-9999, zero taps issued` | ✅ COMPLIANT |
| device-discovery / Device Selection (MODIFIED) | Restart clears override | `device-selection.test.ts > simulated restart (fresh wiring) drops the selection — tiers rule again` | ✅ COMPLIANT |
| logcat-read / Live Log Stream | Live delivery without polling | `logcat-ws.test.ts > subscribe-and-receive … then unprompted live lines` + `logcat-hub.test.ts > backlog:30 … then live only` | ✅ COMPLIANT |
| logcat-read / Live Log Stream | Backlog precedes live | `logcat-hub.test.ts > backlog:30 with ≥30 buffered replays exactly 30 matching, then {type:live}, then live only` | ✅ COMPLIANT |
| logcat-read / Stream Filter Subscription | Filter composition | `logcat-hub.test.ts > tag union ∩ priority floor, IDENTICALLY for replay and live phases` | ✅ COMPLIANT |
| logcat-read / Stream Filter Subscription | Defaults apply | `logcat-hub.test.ts > {} defaults deliver ALL tags at priority ≥ E` | ✅ COMPLIANT |
| logcat-read / Stream Filter Subscription | Malformed filter rejected | `logcat-hub.test.ts > malformed {backlog:"many"} yields ONE error frame then close 1008, spawning nothing` | ✅ COMPLIANT |
| logcat-read / Bounded Backlog Replay | Cap enforced on oversized backlog | `logcat-hub.test.ts > clamps to [0,1000]: backlog:5000 caps the spawn at cap+slack and proceeds` | ✅ COMPLIANT |
| logcat-read / Bounded Backlog Replay | Zero backlog skips replay | `logcat-hub.test.ts > backlog:0 skips replay INSTANTLY: live marker first, no -T at all` | ✅ COMPLIANT |
| logcat-read / Backpressure Drop-Oldest | Slow consumer stays connected | `logcat-hub.test.ts > stalled reader under rapid emission: bounded drop-oldest queue, newest keep flowing, socket stays open, one dropped notice` | ✅ COMPLIANT |
| logcat-read / Stream Teardown | Close tears down cleanly | `logcat-hub.test.ts > sibling subscribers are unaffected by one teardown; fresh subscriptions stay fully functional` (+ SIGTERM→SIGKILL teardown cases) | ✅ COMPLIANT |
| logcat-read / Stream Teardown | Device loss mid-stream | `logcat-hub.test.ts > detach mid-stream closes 4409 with a reason NAMING the serial, stops the child, frees the slot` (+ natural child exit same path) | ✅ COMPLIANT |

**Compliance summary**: 44/44 scenarios compliant

### Correctness (Static Evidence)
| Requirement | Status | Notes |
|------------|--------|-------|
| bridge-auth / Opt-In Authentication Gate | ✅ Implemented | Single seam `authenticateRequest` (auth.ts:238) called once in fetch (server.ts:1142) + once pre-upgrade (server.ts:1072); seed unset short-circuits null (byte-identical fast path) |
| bridge-auth / Token Issuance Endpoint | ✅ Implemented | `handleIssueToken` (server.ts:523) → `issueToken` (auth.ts:151); TTL clamp [60,cap]; route registered ONLY when `auth.enabled` else legacy 404 bytes (server.ts:1184-1188) |
| bridge-auth / Token Expiry Validation | ✅ Implemented | Registry stores SHA-256(token)→expiry only; lazy purge during validation (auth.ts:111-124); `token_expired` vs `unauthorized` verdicts distinct |
| bridge-auth / WebSocket Subprotocol Authentication | ✅ Implemented | Exact-entry scan (auth.ts:190); failure returns 401 Response BEFORE any `server.upgrade()`; success echoes matched entry once via upgrade headers (server.ts:1072-1090, SPIKE-1 echo-ok) |
| bridge-auth / Credential Hygiene | ✅ Implemented | Fixed-message 401s (auth.ts:220); timing-safe hex compare over equal-length digests; raw secrets only hashed into config/registry |
| bridge-auth / CORS Narrowing While Authenticated | ✅ Implemented | csv allow-list honored ONLY while authEnabled (server.ts:874-893); unset restores `requestOrigin\|\|"*"` |
| local-bridge / Emulator Lifecycle Routes | ✅ Implemented | D3 adapters: cheap `emulatorList()` pre-checks (409 avd_exists / 404 avd_not_found+details.available); ONE `toolFailureToHttp` mapper (BOOT_TIMEOUT_RE⇒504 boot_timeout else 500); route-layer idempotent stop via `confirmedStops` closure set |
| local-bridge / Device Selection Route | ✅ Implemented | `handleDeviceSelect` validates against `adb.devices()` (404 device_not_found + details.attached) then sets the D7 holder; daemon-memory only |
| local-bridge / UI Tree Route | ✅ Implemented | Read-only adapter passthrough of `{serial, empty, tree}`; empty hierarchy stays 200 in-band |
| local-bridge / Logcat WebSocket Route | ✅ Implemented | `WS /v1/logcat/ws` behind the same upgrade seam; absent `adb.logcatFollow` capability ⇒ 404 (streaming-not-deployed precedent) |
| local-bridge / Additive Route Compatibility | ✅ Implemented | All new routes additive under `/v1` on the same loopback listener; task 1.8 byte-identity goldens green |
| local-bridge / Device State Endpoint (MODIFIED) | ✅ Implemented | Conditional-additive `selection:{serial,source:"override"}` sibling LAST key (server.ts:391-396); absent ⇒ zero new keys |
| device-discovery / Device Selection (MODIFIED) | ✅ Implemented | `resolveSerial` chain explicit > override > env > auto (server.ts:254-293); stale override throws actionable error naming the serial; multi-device ambiguity lists all serials |
| logcat-read / Live Log Stream | ✅ Implemented | One `-T <n> -v time` spawn per subscriber (argv-array, hostile input rejected pre-spawn); incremental line reader; parsed-only replay cut with HEADER_SLACK=3 (SPIKE-2) |
| logcat-read / Stream Filter Subscription | ✅ Implemented | strictObject zod frame schema; tag `[A-Za-z0-9._-]+` ∩ priority enum floor (default E); identical predicate for replay and live |
| logcat-read / Bounded Backlog Replay | ✅ Implemented | clamp(backlog ?? 100, 0, 1000); backlog 0 omits `-T`; force-flip to live when the `-T` window drains |
| logcat-read / Backpressure Drop-Oldest | ✅ Implemented | LOGCAT_QUEUE_DEPTH=256 bounded FIFO, drop-oldest, opportunistic `{"type":"dropped","count":n}`, socket stays open |
| logcat-read / Stream Teardown | ✅ Implemented | SIGTERM→grace(1000ms)→SIGKILL escalation + orphan sweep; devices() watchdog closes 4409 DEVICE_LOST naming serial; natural child exit converges same path |

### Coherence (Design)
| Decision | Followed? | Notes |
|----------|-----------|-------|
| D1 subprotocol validated at upgrade, explicit echo | ✅ Yes | SPIKE-1 verdict echo-ok recorded; echo emitted exactly once; refusal before `upgrade()` |
| D2 token config surface | ✅ Yes | Env knobs default 3600/cap 86400; issuance route conditional; hash-only storage |
| D3 lifecycle semantics in ROUTE adapters | ✅ Yes | Pre-checks + ONE mapping function; handlers byte-stable |
| D4 `/v1/state` conditional-additive selection | ✅ Yes | Same conditional-spread precedent as `stream`; byte-identical when inactive |
| D5 one `-T` spawn per subscriber | ✅ Yes | SPIKE-2 HEADER_SLACK=3 pinned; argv-array spawn; cap 4429 VIEWER_CAP; optional dep absent ⇒ 404 |
| D6 single auth seam | ✅ Yes | Both scattered checks replaced; one call in fetch + one pre-upgrade; CORS narrowing co-located |
| D7 selection override owned by main wiring | ✅ Yes | Fresh holder per `createBridgeDeps`; restart clears; consumed between explicit and env tiers |

### TDD Compliance
| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | Found in apply-progress (`sdd/bridge-surface-v2/apply-progress`, merged batches 1–7): per-batch RED/GREEN/TRIANGULATE tables incl. final authorized hunk |
| All tasks have tests | ✅ | 29/29 implementation+spike tasks map to dedicated test files on disk; 4 gate tasks run the full suite; 1 docs task (5.1) N/A |
| RED confirmed (tests exist) | ✅ | 29/29 test files verified present: bridge-auth, bridge-routes, bridge-lifecycle, device-selection, state-field, logcat-{hub,ws,follow,backlog-accounting}, ws-subprotocol-behavior, fixtures/goldens |
| GREEN confirmed (tests pass) | ✅ | 474 pass / 0 fail executed fresh this session (digest above) |
| Triangulation adequate | ✅ | Multi-scenario behaviors carry multiple distinct test cases (e.g., teardown ×4, filter matrix ×4, backlog ×6, subprotocol ×7) |
| Safety Net for modified files | ✅ | apply-progress records regression runs before each modification batch (e.g., hub/ws suites 55/0 after the authorized hunk; logcat-follow safety net 18/0) |

**TDD Compliance**: 6/6 checks passed

---

### Test Layer Distribution
| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | 32 | 1 | bun test (fake spawner/socket doubles) |
| Integration | 165 | 11 | bun test (in-memory CLI/adb runners, fake DeviceContext, PATH-shimmed real spawn, live Bun.serve upgrade probes) |
| E2E | 0 | 0 | not installed (no browser harness) |
| **Total** | **197** | **12** | |

Layer note: critical business logic (route error contracts, WS handshake) is exercised at integration level with real Bun request/response objects — appropriate given no browser tooling exists in capabilities. No SUGGESTION raised.

---

### Changed File Coverage
Coverage analysis skipped — no coverage tool detected (no coverage script or reporter configured).

---

### Assertion Quality
✅ All assertions verify real behavior — scanned all change test files: zero tautologies (`expect(true).toBe(true)` family), zero ghost loops, zero orphan empty-collection assertions, zero module-mock-heavy files (suite uses injected fakes/in-memory runners instead of `vi.mock`; zero `vi.mock` occurrences). Assertions pin statuses, wire bytes, error codes, argv arrays, process liveness (`process.kill(pid,0)`), and close codes/reasons — behavioral, not implementation-detail coupled.

**Assertion quality**: 0 CRITICAL, 0 WARNING

---

### Quality Metrics
**Linter**: ➖ Not available (no lint script configured)
**Type Checker**: ✅ No errors (`tsc --noEmit` exit 0, output digest identical to apply-phase record)

### Issues Found
**CRITICAL**: None
**WARNING**:
1. OPTIONS preflights are answered 204 WITHOUT credentials while auth is on (server.ts:1061-1063 runs before the seam). The bridge-auth requirement prose says "EVERY `/v1` route … MUST require valid credentials", but no spec scenario covers OPTIONS+auth, and browser CORS preflights cannot carry custom headers (the very constraint that motivated subprotocol carry). The narrowed ACAO rules ARE applied to preflights (tested). This is a spec-prose interpretation gap, not a failing scenario — recommend clarifying the prose during archive sync.
2. design.md open item remains unchecked: "Confirm `OPENMOBILE_BRIDGE_ALLOWED_ORIGINS` default (none) is acceptable for OpenChamber embedding docs" — user/product call, documented as embedder guidance in README; non-blocking for this change.
**SUGGESTION**:
1. Second-filter-frame policy in the logcat WS (error frame + close 1008 + child stop) is an extrapolation where the logcat-read delta is SILENT — silence verified against the actual spec file (no scenario addresses a post-subscribe second frame); the policy is design-pinned ("exactly ONE filter frame after open", §WS protocol details) and tested. Consider adding an explicit scenario if logcat-read changes again.
2. SPIKE-2 confidence was MEDIUM (`-T` not live-capturable without a device); server-side parsed-line counting makes replay exact regardless, but a live-device validation pass would close the residual risk.

### Verdict
PASS WITH WARNINGS
All 34 tasks complete; 18/18 requirements and 44/44 scenarios compliant with fresh runtime evidence (474 pass / 0 fail, typecheck clean); two non-blocking warnings (OPTIONS-preflight prose gap, open ALLOWED_ORIGINS product confirmation) and one documented spec-silence extrapolation recorded for the orchestrator.
