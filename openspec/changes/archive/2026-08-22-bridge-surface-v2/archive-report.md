# Archive Report: bridge-surface-v2

**Archived**: 2026-08-23 (dispatcher-confirmed archive=ready; folder prefix 2026-08-22 per change timeline)
**Archived to**: `openspec/changes/archive/2026-08-22-bridge-surface-v2/`
**Final verdict**: PASS WITH WARNINGS — cycle complete (planned → implemented under strict TDD → verified PASS → merged → archived)

## What Shipped

Phase 2 seam for the OpenChamber browser surface: issued-token authentication plus five additive HTTP/WS route groups under `/v1`, all behind the existing localhost-only listener. Implementation spans `src/bridge/auth.ts`, `src/bridge/server.ts`, `src/bridge/main.ts`, `src/device/adb.ts`, `src/stream/logcatHub.ts`, `src/stream/types.ts` (work-unit commits b2d4799, 642bb4d, 88f79a9).

| Capability delivered | Detail |
|----------------------|--------|
| Issued-token auth (`bridge-auth`, new capability) | Opt-in via seed secret (`OPENMOBILE_BRIDGE_SECRET`); single auth seam invoked once in `fetch` + once pre-upgrade; `POST /v1/auth/token` mints 32-byte base64url tokens (TTL default 3600s, clamp `[60,86400]`); timing-safe SHA-256 digest compare; hash-only registry with lazy expiry purge; WS carry as subprotocol `openmobile.bearer.<cred>` validated at upgrade (query-param carry treated as no credential); credential hygiene (no echo/log/URL); CORS narrowed to allow-listed origins while enabled, legacy `requestOrigin\|\|"*"` restored when off |
| Emulator lifecycle routes | `POST /v1/emulator/start\|stop\|create` delegating to proven handlers/zod schemas; 409 `avd_exists`, 404 `avd_not_found`+`details.available`, 504 `boot_timeout{name,serial,lastState}`, 422 `validation_error`; route-layer idempotent stop (`alreadyStopped:true`, zero extra CLI stop) |
| Device selection + UI-tree routes | `POST /v1/device/select` runtime override (daemon-memory lifetime) with 404 `device_not_found`+`details.attached`; `GET /v1/ui-tree` mirroring local `get_ui_tree` shape, empty hierarchy signalled in-band (200 `empty:true`) |
| Logcat live stream | `WS /v1/logcat/ws`: one filter frame subscription (tag ∩ priority floor), bounded backlog replay (clamp `[0,1000]`, default 100), one long-lived `adb logcat -T <n> -v time` spawn per subscriber (argv-array, hostile input rejected pre-spawn), drop-oldest bounded queues (depth 256), subscriber cap 8 (4429 `VIEWER_CAP`), SIGTERM→SIGKILL teardown + orphan sweep, device-loss close 4409 naming serial |
| Selection override semantics | Precedence chain explicit parameter > runtime override > `ANDROID_DEVICE` > auto-detect; stale override serial yields an actionable error naming it, never silent fallback; `GET /v1/state` conditionally reports `selection:{serial,source:"override"}` (zero new keys when inactive) |

Seed unset ⇒ byte-identical legacy surface (task 1.8 golden proof); absent optional `logcatFollow` dep ⇒ route 404s (streaming-not-deployed precedent).

## Final Verification Envelope

```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:0e1bbb63668000cf1d25e043188f4f3f076cbd648ee99e18185d30abfc74b3e5
verdict: pass
blockers: 0
critical_findings: 0
requirements: 18/18   # bridge-auth 6 · local-bridge 6 · device-discovery 1 · logcat-read 5
scenarios: 44/44      # 11 · 16 · 7 · 10
test_command: bun test        # exit 0 — 474 pass / 0 fail across 31 files
build_command: bun run typecheck  # exit 0 — tsc --noEmit strict, clean (digest identical to apply-phase record)
```

Tasks closed: **34/34** (re-verified in the archived copy: 0 unchecked). TDD compliance 6/6 checks passed; 29 implementation/spike tasks map to dedicated on-disk test files.

## SPIKE Outcomes

1. **SPIKE-1 (runtime, subprotocol echo)** — verdict **echo-ok**: Bun 1.4.0 `server.upgrade(req,{headers})` emits the explicit `sec-websocket-protocol` exactly once on the 101 and replaces auto-selection (duplication impossible); without an explicit header Bun auto-picks the FIRST client-offered protocol (never relied upon). Pinned in `test/ws-subprotocol-behavior.test.ts`; resolved D1 (explicit echo kept, documented fallback unused).
2. **SPIKE-2 (fixtures, `-T` accounting)** — recorded adb dumps over-deliver and place header lines OUTSIDE the count (`-t 20` ⇒ 22 parsed + 2 headers); pinned **HEADER_SLACK=3** as defensive margin with server-side counting of PARSED matching lines making replay exact regardless. Confidence was MEDIUM at spike time (`-T` not live-capturable without a device); carried below as residual-risk follow-up. Resolved D5.

## Merge Reconciliations (Delta Sync onto Populated Main Tree)

Main `openspec/specs/` held 11 populated domains from three prior archives. All four deltas were merged against current main content; everything synced by earlier changes was preserved.

| Domain | Action | Reconciliation details |
|--------|--------|------------------------|
| bridge-auth | Created | NEW domain. Mechanical shell copy of the delta (verbatim `diff -r` readback empty), then normalized to canonical main-spec form per repo convention ("# Bridge Auth Specification" + Purpose section; "ADDED Requirements" heading flattened; no "(Previously:…)" annotations — none exist anywhere in main tree). **WARNING-1 prose clarification applied here** during sync: see next section. 6 requirements / 11 scenarios. |
| local-bridge | Modified + append | MODIFIED: Device State Endpoint replaced wholesale by the delta version (+1 scenario: State reflects selection override). APPENDED: five ADDED requirements (Emulator Lifecycle Routes, Device Selection Route, UI Tree Route, Logcat WebSocket Route, Additive Route Compatibility) after Stream Configuration. Non-Goals reconciled: the blanket "No authentication beyond the localhost trust boundary" bullet — explicitly superseded by this change per the delta header — reworded to scope unauthenticated access to the default-off posture with credentials delegated to `bridge-auth`; added delta bullets (input/key MCP-only; no GET-style logcat tail/dump route; no rate limiting/non-loopback/async job queue); existing `/v2` and downstream-consumer bullets untouched. Out of Scope line "Auth tokens, rate limiting…" updated because token issuance SHIPPED (rate limiting/multi-client coordination remain open design decisions). Preserved untouched: Screenshot Endpoint, Input Endpoints, Localhost-Only Binding, Contract Stability, Streaming WebSocket Endpoints, Additive Stream State, Stream Configuration. Now 13 requirements / 27 scenarios. |
| device-discovery | Modified | Only Device Selection touched: replaced by the delta version adding the runtime override tier between explicit-parameter and environment tiers plus the stale-serial rule (3 → 7 scenarios). The "(Previously: three tiers only…)" delta annotation dropped per canonical convention. Preserved untouched: List Devices, Surface Connection States, Device Info, Device Properties via adb, Spawn Timeout on Discovery Subprocesses, Purpose, Non-Goals, Out of Scope. Now 6 requirements / 16 scenarios. |
| logcat-read | Modified + append | APPENDED: five ADDED live-stream requirements (Live Log Stream, Stream Filter Subscription, Bounded Backlog Replay, Backpressure Drop-Oldest, Stream Teardown) before Non-Goals. Non-Goals reconciled: "No real-time streaming subscription (poll-based reads)" deleted — directly contradicted by the ADDED Live Log Stream requirement; "No log persistence, rotation, or server-side buffering" narrowed to persistence/rotation (the stream uses bounded transient per-subscriber queues, not log storage); added delta bullets (dump-and-tail retirement is future change — those requirements REMAIN IN FORCE; no HTTP GET tail/dump route; no multi-device fan-out). Out of Scope preserved. Now 9 requirements / 16 scenarios. |

No REMOVED or RENAMED requirements in any delta; no destructive merges (the `rules.archive` warn-before-destructive condition is satisfied — every deletion above is a scoped non-goal/prose reconciliation required by shipped behavior and documented here).

## Carried Warnings & Suggestions (mandatory record)

**WARNING-1 — OPTIONS preflight prose gap (RESOLVED AT SYNC)**: CORS `OPTIONS` preflights are answered `204` unauthenticated while auth is on — browser necessity (preflights cannot carry custom headers, the same constraint that motivates subprotocol WS carry), with the narrowed ACAO rules applied and tested. The requirement prose "EVERY `/v1` route … MUST require valid credentials" was clarified during the canonical `bridge-auth` sync. **Landed in**: `openspec/specs/bridge-auth/spec.md`, Requirement "Opt-In Authentication Gate", sentence appended immediately after the gate mandate ("Sole sanctioned exception: CORS `OPTIONS` preflight requests are answered `204` without credentials …"). No scenario text was altered — the gap was prose-level only.

**WARNING-2 — `OPENMOBILE_BRIDGE_ALLOWED_ORIGINS` default-empty (PRODUCT FOLLOW-UP, OPEN)**: default-none allow-listing means OpenChamber embedding requires an explicit embedder decision; guidance is documented in README (task 5.1). This mirrors the still-unchecked design.md open item ("Confirm default is acceptable for OpenChamber embedding docs"), retained verbatim in the archived design per audit-trail immutability. Owner: product/maintainer; not blocking this change.

**SUGGESTION — second filter-frame policy is spec-silent (FUTURE CHANGE)**: post-subscribe second filter frames get error frame + close 1008 + child stop — design-pinned ("exactly ONE filter frame after open", §WS protocol details) and tested, but no logcat-read scenario covers it (silence verified against the actual spec file at verify time). Recommend adding an explicit logcat-read scenario if the domain changes again.

**Additional verify-recorded suggestion (disclosed)**: SPIKE-2 confidence was MEDIUM (`-T` not live-capturable without a device); server-side parsed-line counting makes replay exact regardless, but a live-device validation pass would close the residual risk.

## Gates at Archive Time

- **Task Completion Gate**: PASS — persisted `tasks.md` shows 34/34 checked (archived copy re-verified: 0 unchecked `- [ ]`).
- **Native Review Receipt Gate**: `reviewGate` structurally absent from structured status — archive proceeded under ordinary repository policy.
- **Verification gate**: final verdict PASS, 0 blockers, 0 CRITICAL findings; two non-blocking WARNINGs and suggestions disclosed above; no override needed.
- **Action Context Guard**: no workspace-planning mode; edits stayed inside the repo root.

## Mechanics & Traceability

- Spec sync: bridge-auth created via mechanical shell copy (`cp` to mktemp target, `diff -r` readback **exit 0 — no differences**) before normalization/WARNING-1 edits; other three domains merged in place against current main content.
- Folder move: plain `mv` (no git operations, per constraint) inside a shell transaction with recursive pre-move snapshot; mandatory `diff -r` readback of snapshot vs `openspec/changes/archive/2026-08-22-bridge-surface-v2/` returned **empty (exit 0)** — `verify-report.md` bytes preserved exactly.
- Active changes directory retains only unrelated work (`emulator-native-stream`); unrelated WIP (modified `test/stream-rtc-allowlist.test.ts`, untracked `src/device/grpc.ts`, `test/device-grpc.test.ts`, `.codegraph/`) untouched.
- Archived artifacts: proposal.md, design.md, tasks.md (34/34), verify-report.md (bytes preserved), specs/ (all 4 delta domains).
