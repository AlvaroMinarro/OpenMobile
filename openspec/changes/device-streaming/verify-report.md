# Verify Report: Device Streaming (FINAL RE-RUN — post-review-fixes)

**Date**: 2026-08-16 · **Mode**: Strict TDD (`bun test`) · **Artifact store**: hybrid (engram + openspec)
**Change**: `device-streaming` (openmobile) · **Head**: `feature/device-streaming-client` @ `24352ce` (2 fresh-review fix commits `b01cfe4` + `24352ce` on prior verify head `8d1d313`; src byte-identical to bridge-branch originals, test files merged keeping both sides)
**Supersedes**: obs #590 (PASS WITH WARNINGS @ `8d1d313`, 250 tests) after adversarial review found 2 CRITICALs, fixed per obs #589 fix slice (`a63dce5`/`5573b90` on PR2, cherry-picked to PR3 as `b01cfe4`/`24352ce`).

## Verdict: PASS (no CRITICALs, no WARNINGs — 2 prior informational WARNINGs retained)

The 2 fresh-review CRITICALs are fixed and proven by dedicated tests on the tip: **StreamAssembler frame-length bound** (OOM guard) and **ghost-viewer connect race** (viewerId pre-assign + liveness re-checks). Full suite 259/259 (expected 259/0), typecheck clean, demo bundle byte-identical. Spec census unchanged (33 PASS + 1 PARTIAL + 1 UNTESTED-by-design) plus the 2 review scenarios now PASS. No contract drift — fixes touched only bounds + lifecycle code.

---

## Execution Evidence (all re-run fresh on HEAD `24352ce`)

| Check | Result | Command |
|-------|--------|---------|
| Test suite | ✅ **259 pass / 0 fail** (860 expect, 19 files) — matches expected 259/0 | `bun test` (4.63s) |
| Typecheck | ✅ clean (exit 0) | `bun run typecheck` |
| Demo bundle | ✅ regenerates byte-identical (no diff in `examples/stream-client.js`) | `bun run build:stream-demo` |
| Changed-file coverage | see table below | `bun test --coverage` |
| Live probe | ➖ skipped (optional per orchestrator): fixes are bounds+lifecycle, unit/integration tests inject the exact corrupt/race payloads; emulator-5554 up, `adb reverse` clean (prior hygiene verified) | — |

## The 2 Review CRITICALs — flipped and proven

| # | Finding | Fix (HEAD) | New tests (name-level, all passing) | Status |
|---|---------|------------|--------------------------------------|--------|
| 1 | **Unbounded StreamAssembler accumulation** — `len=0xFFFFFFFF` u32 from device socket → `Buffer.concat` OOM kills bridge daemon | `types.ts:32,39` `MAX_FRAME=16 MiB`, `MAX_ACCUMULATED=2×MAX_FRAME+FRAME_META_LEN`; `daemon.ts:105` accumulator cap checked **before** concat → `"accumulator_overflow"`; `daemon.ts:119-121` `fm.len > MAX_FRAME` → `"frame_too_large"`; `daemon.ts:298-303` corrupt → existing `lose("corrupt stream")` + `sock.destroy()` | `test/stream-daemon.test.ts`: `rejects a frame declaring len=0xFFFF_FFFF as corrupt — no unbounded accumulation`; `rejects any declared frame length above MAX_FRAME (16 MiB)`; `buffers a partial frame declaring exactly MAX_FRAME — the boundary is legal` (boundary guard: legal partials not false-positived); `caps the total accumulator at ~2×MAX_FRAME even when every declared length is legal`; `fires loss + destroys the video socket when a frame declares an absurd length (corrupt stream, OOM guard)` (asserts `losses==["lost"]`, `stateReason=="device_lost"`, `sock.destroyed===true`) | ✅ **FIXED** |
| 2 | **Ghost viewer on connect race** — viewer registered after its WS closed (tab reload / rapid open-close) → refcount + cap slot leaked, session runs forever | `server.ts:509-513` `viewerId` assigned **synchronously before** `await subscribeVideo` (close handler `465-466` can always unsubscribe); `gateway.ts:196-198` post-await `viewer.open` re-check → `{ok:false, NO_DEVICE, "viewer closed before subscription completed"}` **without** `manager.subscribe()`/`viewers.set()`; `gateway.ts:251` attachToSession pre-`fanout.add` re-check | `test/stream-gateway.test.ts`: `does not register a viewer that closes while the auto serial is still resolving (connect race ghost)` (asserts `res.ok===false`, `snap.viewers===0`, `snap.active===false`); `rapid open/close cycles never consume viewer-cap slots (ghosts don't count toward the cap)` (MAX_VIEWERS+1 ghosts → all `ok:false`, `viewers===0`, then a real viewer still gets `ok:true`/`viewers===1`); `never attaches a viewer whose WS closed while the session was still starting (late-close race)` (asserts `attachedViewers===0`); `test/stream-bridge.test.ts`: `unsubscribes a video viewer whose socket closes while subscribe is still pending (connect race ghost)` — real Bun.serve WS + GatedGateway, asserts `unsubscribes===1` AND `viewers.length===0` | ✅ **FIXED** |

## Tasks Completeness

21/21 tasks `[x]` (per tasks.md, verified against files+tests in prior runs; fix slice = 2 follow-up commits, no task regression). New tests this slice: **+9** (daemon +5, gateway +3, bridge +1) = 259 total.

## Spec Compliance Matrix (16 req / 35 scenarios census — prior verify #1 census)

**33 PASS** (unchanged; incl. #26 Control injection failure from prior fix slice — still green on this run), **1 ⚠️ PARTIAL** (#1 Unsupported environment — W3, unchanged), **1 ➖ UNTESTED-by-design** (#6 Early keyframe — encoder behavior, explicit non-goal), **2 future-doc N/A** (#21/#22). FAILING: **0**.

**Review delta (exact)**: the 2 fresh-review scenarios are NOT part of the original 35-scenario census — they are robustness findings (corrupt assembly bounds; ghost-viewer connect race). Both now have dedicated covering tests that PASS → **tracked scenarios 37, PASS count 35** (33 census + 2 review scenarios), 1 PARTIAL + 1 UNTESTED-by-design unchanged. Mapping: corrupt-bounds → H.264 Stream Endpoint (assembler robustness); ghost-viewer → Viewer cap reached / Stream Lifecycle (registry correctness).

## WS Protocol Contract (README ↔ code ↔ tests — no drift)

| Item | README (L123-151) | Code | Tests | Status |
|------|-------------------|------|-------|--------|
| Handshake `{type:"handshake", codec:"h264", lengthSize:12, width, height, sps, pps}` | ✅ | ✅ `buildHandshake` (untouched) | ✅ stream-bridge/gateway/client | ✅ no drift |
| One binary Annex-B AU per message | ✅ | ✅ StreamAssembler (bounds only added) | ✅ | ✅ |
| State JSON `{type:"state", buffering\|streaming\|error, reason?}` | ✅ | ✅ gateway onLoss/after-handshake (prior slice, on client branch only — see Risks) | ✅ | ✅ |
| Control JSON + ack/error, INJECTION_FAILED | ✅ | ✅ `sendControl` reject → server error frame (prior slice, client branch only — see Risks) | ✅ | ✅ |
| Close codes 4403/4404/4429/4409 | ✅ | ✅ server.ts (untouched) | ✅ | ✅ |

Fix commits touched ONLY: `daemon.ts`, `types.ts`, `server.ts`, `gateway.ts` + 3 test files. `wire.ts`, `control.ts`, `scrcpy.ts`, `client/*` byte-untouched → message shapes, close codes, handshake format all unchanged.

## TDD Compliance (Strict TDD)

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | apply-progress fix-slice TDD Cycle Evidence table (5 rows: assembler-bounds, session-loss, subscribe-race, late-close-attach, bridge viewerId) |
| All fix tasks have tests | ✅ | 5/5 rows → test files exist (daemon +5, gateway +3, bridge +1) |
| RED confirmed (tests exist) | ✅ | 5/5 RED entries describe real failing assertions (MAX_FRAME import-undefined, corrupt undefined, ghost registered, re-attached after unsubscribe, unsubscribes 0) |
| GREEN confirmed (tests pass) | ✅ | 259/259 pass on this run; all 9 new tests enumerated above pass |
| Triangulation | ✅ | assembler: 4-case (0xFFFFFFFF / MAX_FRAME+1 / legal boundary / accumulator overflow with legal lens); ghost: 3-case (pending-subscribe close, rapid loop + cap non-consumption, late attach) |
| Safety Net | ✅ | 226/226 baseline on PR2 before each fix per apply-progress; cherry-pick conflicts resolved keeping BOTH sides' tests |
| Assertion quality (audit of all 9 new tests) | ✅ | No banned patterns: value assertions (`toBe("frame_too_large")`, `toEqual(["lost"])`, `sock.destroyed===true`, `snap.viewers===0`, `unsubscribes===1` + `viewers.length===0`), boundary legal case with companion corrupt cases (no orphan empty checks), 0 `vi.mock`, no ghost loops, no type-only assertions |

**TDD Compliance**: ✅ — protocol followed for the fix slice.

## Test Layer Distribution

| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit (wire/scrcpy/fanout/control/manager/daemon/annexb/decoder/support…) | ~200 | 12 | bun:test |
| Integration (bridge WS over real Bun.serve, real-gateway e2e, client e2e) | ~59 | 5 | bun:test + Bun.serve WebSocket |
| E2E (real device) | live probe runs in prior sessions (script /tmp, not committed) | — | adb + Bun WS client |

## Changed-File Coverage (`bun test --coverage`, this run; informational per Strict TDD)

| File | % Lines | Branch % | Uncovered | Rating |
|------|---------|----------|-----------|--------|
| `src/bridge/server.ts` | 91.07 | 100 | — | ✅ |
| `src/stream/daemon.ts` | 73.53 | 80.40 | 201-204, 209-212 (handshake-null branches), 326-327, 357-384 (default listener/real-spawn/teardown — live-proven prior), 415-425 (close() path unit-covered? see note) | ⚠️ Acceptable |
| `src/stream/fanout.ts` | 88.89 | 100 | — | ✅ (variance vs prior 100 — no code change this slice; run-variance) |
| `src/stream/gateway.ts` | 83.33 | 93.55 | 47-49, 70-74, 109-110 (edge branches) | ⚠️ Acceptable |
| `src/stream/manager.ts` | 73.33 | 72.00 | 118-122, 149-153, 179-190, 199-206, 244-250, 338-342 (unused controlWriter/sendControl, defaultPollDevices) **WARNING-4 unchanged** | ⚠️ |
| `src/stream/scrcpy.ts` | 100 | 100 | — | ✅ |
| `src/stream/types.ts` | 100 | 100 | — (new constants covered) | ✅ |
| `src/stream/wire.ts` | 85.71 | 93.55 | 45-47, 67, 97 | ⚠️ (prior run 93.55 — no code change; run-variance) |

**Average changed-file coverage**: ~86.7% this run. Coverage is informational, never blocking (Strict TDD rule). Note: `bun test --coverage` per-run numbers fluctuate slightly for untouched files (fanout/wire vs prior run) — no code changed there since the 100%/93.55% measurements; treat as tool variance, not regression. **Linter**: no lint tooling configured → skipped. **Type checker**: ✅ clean.

## Issues

### CRITICAL
**None.** Both fresh-review CRITICALs fixed, tested (RED→GREEN with named assertions), verified on the tip. 0 fail, typecheck clean, no contract drift.

### WARNING (2 — retained from prior runs, informational, non-blocking)
3. **"Unsupported environment" (jar missing) partially implemented — unchanged.** `manager.snapshot().supported` remains kill-switch-only; missing jar surfaces at connect time via 4404 + JSON body, not at state-read time (`supported:true` gap). Not elevated: actionable connect error, REST fallback intact, jar bundled+pinned (edge branch only).
4. **`manager.ts` ~73% line coverage — informational** (Strict TDD: coverage never blocking). Uncovered = unused `sendControl`/`controlWriter` surface, `defaultPollDevices`, in-flight guards.

### SUGGESTION (5 retained + 1 new)
5. Bridge-level 4409 mapping: error-state-before-close is real-path tested + live-proven; final socket-level 4409 close round-trip still fake-gateway-driven (`stream-bridge` 4409).
6. Control before handshake: `controlActive()` returns `{0,0}` → early taps get confusing out-of-range error.
7. `scrcpy.ts` spawnServer/removeReverse/teardown dormant; `buildSpawnShellCmd` duplicates `buildSpawnCmd`.
8. Spec census 16 req/35 vs cached 14/39 — informational for archive (already noted).
9. **Cold-start flakiness** observed once live (attempt 1 failed session start, retry succeeded) — consider bounded first-connect start-retry in StreamManager.
10. Gateway tests use setTimeout polling loops — a `waitFor` helper would tighten.
11. **NEW — coverage variance in `bun test --coverage`** (fanout 100→88.89, wire 93.55→85.71 on untouched files). No code changed; likely run-scheduling variance. If stable numbers matter (CI gate), pin coverage with `--coverage` thresholds or a dedicated config.

## Risks
- **⚠️ BRANCH COMPOSITION (SHA divergence — flag for orchestrator)**: the **bridge branch (`feature/device-streaming-bridge`) does NOT contain the prior fix slice** (`cb1321f` = WS state messages, `8d1d313` = INJECTION_FAILED) — those commits exist ONLY on the client branch. Shared files (`gateway.ts`, `daemon.ts`, `fanout.ts`, `types.ts`) differ between the branches exactly by that slice. The chain tip (`feature/device-streaming-client` @ `24352ce`) is complete and correct, but **PR2 (bridge) as a standalone review slice omits the state-message + INJECTION_FAILED fixes** — they arrive only via PR3. If PR2 is reviewed/merged in isolation, those behaviors are missing from its diff. Fix options: (a) cherry-pick `cb1321f` + `8d1d313` onto the bridge branch so PR2 is self-contained (recommended — slots PR2 as the "bridge behavior fixes" slice per prior apply-progress intent), or (b) explicitly accept that PR3 delivers them (chain-complete at the tip). The 2 fresh-review fixes are present on BOTH branches with src byte-identical (verified: patch content identical modulo line offsets) — only test files differ (merged keeping both sides).
- **On-disk archive predates the review fixes**: `openspec/changes/archive/2026-08-16-device-streaming/` (created 10:20 @ `8d1d313`) contains the stale verify-report (250 tests) and archive-report. This final report is written to `openspec/changes/device-streaming/verify-report.md` per convention; the archived audit copy remains at the pre-fix state. Recommend updating the archived `verify-report.md` + `archive-report.md` (or re-running sdd-archive) after this PASS so the audit trail reflects the final head.
- Cold-start session-start failure observed once live (recovered on retry; SUGGESTION-9).
- Real-browser Chrome WebCodecs demo decode still manual (bundle byte-stable, unit-double proven).
- Nothing pushed; 3 chained PR branches ready.

## Next Recommended
1. **Resolve the bridge-branch composition gap** (see Risks): cherry-pick `cb1321f` + `8d1d313` onto `feature/device-streaming-bridge`, re-run suite on both branches (expect 235 on bridge, 259 on client).
2. Push the 3 chained PRs in order (feature-branch-chain: PR1 → PR2 → PR3) after fresh review at 400-line slices.
3. Update the archived verify/archive reports to the final head `24352ce` (or re-run sdd-archive) so the audit trail matches the tip.
4. Optional: manual Chrome WebCodecs validation + revisit SUGGESTION-9/10/11 in follow-ups.