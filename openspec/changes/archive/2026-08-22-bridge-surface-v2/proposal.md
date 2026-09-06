# Proposal: bridge-surface-v2

Phase 2 seam: make emulator lifecycle, logcat, UI tree, and device selection
reachable over HTTP for a browser surface, plus browser-compatible WS auth —
all additive under `/v1`.

## Intent

OpenChamber Phase 2 is an interactive Device tab driving the emulator entirely
over HTTP/WS from a browser. Impossible today: lifecycle/logcat/ui-tree/selection
are local-MCP-only (`src/tools/handlers.ts`); the bridge serves state/screenshot/
input/streaming only. And its sole auth (`OPENMOBILE_BRIDGE_SECRET` → header)
cannot authenticate browsers — custom WS headers don't exist in browsers — so a
browser tab runs unauthenticated against a CORS-any-origin loopback bridge any
local page could drive. Token auth authenticates the browser origin; binding
stays `127.0.0.1` (not remote access).

## Scope

### In Scope
- `POST /v1/emulator/start|stop|create`: JSON bodies reusing zod schemas +
  handlers; actionable errors — duplicate-AVD (conflict), unknown-AVD listing
  available names, boot-timeout naming serial + last state.
- `GET /v1/logcat` as a WebSocket stream: filter subscription (tag/priority),
  bounded initial backlog, live pump; tail/dump stays local-MCP-only (PoC to be
  discarded long-term — maintainer decision).
- `POST /v1/device/select`: runtime serial override, daemon-memory lifetime;
  precedence vs `?device=` / `ANDROID_DEVICE` / auto-detect documented.
- `GET /v1/ui-tree`: same JSON shape local `get_ui_tree` produces.
- Issued-token auth: seed secret via env; `POST /v1/auth/token` issues
  short-lived bearer tokens (default TTL 3600s, bounded cap); REST
  `Authorization: Bearer`; browser WS carries the token as requested
  subprotocol `openmobile.bearer.<token>`, validated at upgrade.
  Off by default — unset ⇒ byte-identical current behavior.

### Out of Scope (non-goals)
- NO video/stream changes (H.264, scrcpy, control socket, viewer cap) beyond auth gate.
- NO MCP removal; NO multi-client fan-out redesign; NO `/v2` policy — additive `/v1` only.
- NO non-loopback binding, rate limiting, token revocation/rotation UI.
- NO `POST /v1/input/key`, NO `/v1/ui-tree` diff endpoint (stay MCP-only).

## Capabilities

### New Capabilities
- `bridge-auth`: opt-in token auth — config source, REST + WS-upgrade carry,
  constant-time compare, no-echo/no-log rules, CORS tightening while enabled;
  default-off loopback trust preserved.

### Modified Capabilities
- `local-bridge`: additive routes (emulator lifecycle, logcat, ui-tree, device
  select) with status/error mapping; auth gate hooks on REST + WS upgrades;
  selection override reflected in `/v1/state`.
- `device-discovery`: Device Selection gains a runtime HTTP override tier with
  explicit conflict rule against explicit/env/auto tiers.

Unchanged (no deltas): `emulator-lifecycle`, `ui-tree` — handlers
reused; their HTTP exposure is specified inside `local-bridge`. `logcat-read`
gains ADDED live-stream requirements (WS streaming-only per maintainer decision).

## Approach

Thin route adapters in `buildRestHandler` (`src/bridge/server.ts`) delegate to
existing `DeviceContext` handlers + zod schemas; device core untouched.
`ToolError` maps onto the established `{error:{code,message,details}}` body;
exact status codes pinned at spec phase (sketch: 409 duplicate/offline,
404/422 unknown-AVD, 422 validation, bounded actionable timeouts). Auth is
timing-safe, never echoed/logged; CORS reflection narrows while enabled.

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Handler reuse | Bridge delegates to tools handlers/schemas | One semantic source; scenarios already spec-proven |
| WS carry | Subprotocol, not query param | Query strings leak into logs/proxies; browsers can pick subprotocols |
| Token v1 | Issued short-lived tokens from env seed | Browser tab sessions outlive config reloads; revocation = rotate seed; maintainer decision |
| Override state | In-memory per daemon | No persistence story yet; restart resets |

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/bridge/server.ts` | Modified | Routes, ToolError→HTTP map, auth gates (REST+WS), CORS narrowing |
| `src/bridge/main.ts` | Modified | Token env wiring; selection-override state into deps |
| `src/tools/handlers.ts`, `schemas.ts` | Reused | Minor export refactor so bridge builds a `DeviceContext` |
| `README.md` | Modified | `/v1` contract: new routes + auth/browser caveats |
| `test/` | New | Route contract tests, in-memory runners (existing pattern) |

Security: token env-only, never committed/logged; docs state auth-on is what
blocks arbitrary local pages (DNS-rebinding/CSRF posture); OpenChamber should
enable it by default when embedding.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Token leakage (logs/history/referrers) | Med | Header/subprotocol only, never query param; redact logs |
| Long-running `start` pins requests | Med | Existing bounded timeouts; actionable timeout errors; async jobs deferred |
| Bun WS subprotocol negotiation quirks | Low | Verify upgrade-header echo in design/tests before pinning spec wording |
| Auth-off window leaves page-driven abuse open | Med | Document loudly; default-on guidance for embedders |

## Rollback Plan

Additive routes + opt-in env flag: revert commit or unset token env → pre-change
responses byte-for-byte. Override state is in-memory; no migrations; `/v1` intact.

## Dependencies

None new (Bun native serve/WS). Consumer: OpenChamber Phase 2 implements against
the updated README `/v1` contract after merge.

## Success Criteria

- [x] Five route groups respond under `/v1` with documented shapes/errors.
- [x] Duplicate-AVD → conflict; unknown-AVD → error lists available AVDs; nothing created.
- [x] Browser WS authenticates via subprotocol with zero custom headers.
- [x] Token unset ⇒ legacy tests pass unchanged.
- [x] `/v1/state` reflects selection override; precedence documented.
- [x] `bun test` + `bun run typecheck` green.

## Open Decisions (user)

1. WS carry: subprotocol (recommended) vs query param?
2. Static env token for v1 (recommended) vs issued short-lived tokens?
3. Keep `POST /v1/input/key` excluded despite no browser key route today?
4. Logcat streaming: attempt if cheap, or defer outright?
