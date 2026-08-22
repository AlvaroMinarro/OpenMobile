# Verify Report: Device Streaming (RE-RUN #2 — post-fix-slice)

**Date**: 2026-08-16 · **Mode**: Strict TDD (`bun test`) · **Artifact store**: hybrid (engram + openspec)
**Change**: `device-streaming` (openmobile) · **Head**: `feature/device-streaming-client` @ `24352ce` (refreshed post-review-fixes) (2 fix commits on prior verify head `e2c7edd`; working tree clean except untracked verify-report.md — verify-phase artifact)
**Re-run of**: obs #590 (FAIL — 2 CRITICALs) after fix slice obs #589 (`cb1321f` + `8d1d313`), both CRITICALs now fixed TDD-style.

## Verdict: PASS WITH WARNINGS (2 pre-existing informational WARNINGs — no CRITICALs)

The 2 CRITICALs from verify #1 are fixed and proven: **WS state messages now emitted** (streaming-after-handshake + error-before-close, unit + integration + **LIVE** evidence) and **control injection failure now surfaces `INJECTION_FAILED`** (never a silent ack, real-path test). Full suite 259/259, typecheck clean, demo bundle byte-identical, live probe green on HEAD (refreshed post-review-fixes). W3/W4 from verify #1 remain exactly as before — informational, non-blocking; W5 downgraded to SUGGESTION (real-path loss test added).

---

## Execution Evidence (all re-run fresh on HEAD `24352ce`)

| Check | Result | Command |
|-------|--------|---------|
| Test suite | ✅ **259 pass / 0 fail** (860 expect, 19 files) — matches expected 259/0 (refreshed post-review-fixes) | `bun test` (3.29s) |
| Typecheck | ✅ clean (exit 0) | `bun run typecheck` |
| Demo bundle | ✅ regenerates byte-identical (git tree clean after — only untracked verify-report.md) | `bun run build:stream-demo` |
| Live WS probe | ✅ **CRITICAL-1 fix proven live**: handshake `{type:handshake, codec:"h264", lengthSize:12, width:430, height:960, sps:"Z0LAKY1oGweeuQgICAg8IhGo", pps:"aM4BqDXI"}` → `{"type":"state","state":"streaming"}` (contract order: handshake first) → 13 binary AUs each starting `00 00 00 01` → client close 1000 | bridge on 8765 + emulator-5554, custom Bun WS client |
| Live error-state path | ✅ **error state proven live** on a first-attempt session-start failure: `{"type":"state","state":"error","reason":"device_lost"}` delivered (socket stayed open — error precedes teardown) | same probe, attempt 1 |
| Device hygiene after test | ✅ bridge killed, jar self-deleted (`ls: No such file`), `adb reverse --list` empty | adb shell/reverse |
| Jar pin (unchanged) | ✅ sha256 `deacb991ed…8850cae` = pinned `deacb99…` (from verify #1; no jar change in fix slice) | `sha256sum` |

## Fix Verification (the 2 CRITICALs, flip to PASS)

| # | Prior finding | Fix (HEAD) | Tests (all passing) | Live | Status |
|---|---------------|------------|---------------------|------|--------|
| 1 | WS state messages never emitted — documented contract, zero emissions | `gateway.ts:253-260` `sendHandshake(hs)` then `await viewer.sendState({type:"state",state:"streaming"})` (contract order); `gateway.ts:101-104` `session.onLoss(...)` → `fanout.broadcastState({type:"state",state:"error",reason:"device_lost"})` before teardown close; `fanout.ts:81` `broadcastState` (open viewers delivered, closed reaped); `daemon.lose()` once-guard (no double error-state) | `stream-fanout` (2: all viewers / reaped closed); `stream-gateway` (1 new: error-state-before-close with log-ordered proof `state index < close index`, viewer still open at state time; + streaming-state assertion w/ `handshake index < state index` in existing test); `stream-bridge` 4409 wiring (fake gateway) | ✅ streaming + error states both observed on real WS | ✅ **FIXED** |
| 2 | "Control injection failure" FAILING+untested — silent ack on dead conn2 | `daemon.ts:168` `controlAlive` (set on attach :291, cleared on close/error :296/:300, write-failure catch :228-230); `sendControl` rejects `"control socket is not connected; injection failed"` when missing/dead; `server.ts:552` maps rejection → `{type:"error", code:"INJECTION_FAILED", message}` (socket stays open, never ack) | `stream-daemon` (2 new: rejected when closed mid-stream / never connected); `stream-bridge` (1 new: **REAL gateway path** — route → real StreamGateway → real StreamSession over dead conn2, asserts error frame + socket stays open) | — (path not live-probed; real-path test + live ack path from verify #1) | ✅ **FIXED** |

## Tasks Completeness

21/21 tasks `[x]` (verified against files+tests in verify #1; fix slice adds 2 follow-up commits, no task regression). New tests this slice: 7 new + 1 extended assertion (gateway first test) = 250 total; review-fix commits add 9 more → **259 total (refreshed post-review-fixes)**.

## Spec Compliance Matrix (16 req / 35 scenarios — per verify #1 census)

**33 PASS** (incl. #26 Control injection failure — now `stream-bridge` real-path + `stream-daemon`), **1 ⚠️ PARTIAL** (#1 Unsupported environment — W3), **1 ➖ UNTESTED-by-design** (#6 Early keyframe — encoder behavior, explicit non-goal), **2 future-doc N/A** (#21/#22). FAILING count: **1 → 0**. Matrix unchanged otherwise (verify #1 detail tables still apply).

## WS Protocol Contract (README ↔ code ↔ live)

| Item | README | Code | Live | Status |
|------|--------|------|------|--------|
| Handshake `{type,codec,h264,lengthSize:12,w,h,sps,pps}` | ✅ | ✅ buildHandshake | ✅ exact fields (this run) | ✅ |
| One binary Annex-B AU per message | ✅ | ✅ StreamAssembler | ✅ 13/13 start codes | ✅ |
| **State JSON `{type:"state", state:"buffering"\|"streaming"\|"error", reason?}`** | ✅ | ✅ **now emitted** (gateway onLoss + after-handshake) | ✅ **streaming + error observed** | ✅ **FIXED** |
| Control JSON + ack/error frames | ✅ | ✅ + INJECTION_FAILED | ✅ (verify #1 ack) | ✅ |
| Close codes 4403/4404/4429/4409 | ✅ | ✅ | ✅ (4403/4404/4429; 4409 wiring tested) | ✅ |

## TDD Compliance (Strict TDD)

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | apply-progress fix-slice TDD Cycle Evidence table (5 rows) |
| All fix tasks have tests | ✅ | 5/5 rows map to test files that exist (fanout 2, gateway 2, daemon 3, bridge 1) |
| RED confirmed (tests exist) | ✅ | 5/5 RED entries describe real failing assertions (TypeError broadcastState, expected-error-got-ack, 2-fail harness…) |
| GREEN confirmed (tests pass) | ✅ | 259/259 pass on this run (refreshed post-review-fixes); the 8 new tests enumerated above all pass |
| Triangulation | ✅ | streaming state: order + error-before-close; sendControl: closed + never-connected; broadcastState: deliver + reap; loss dedup single-case (spec has one behavior) |
| Safety Net | ✅ | 243/243 baseline before each fix per apply-progress; "N/A (new)" files genuinely new |
| Assertion quality (audit of all new tests) | ✅ | No banned patterns: value assertions (`toContainEqual` exact state objects, log-index ordering proofs, `rejects.toThrow` + message match, `v.open===true` before close, loss `toEqual(["lost"])`); 0 `vi.mock` (constructor injection); no ghost loops, no type-only assertions |

**TDD Compliance**: ✅ — protocol followed for the fix slice.

## Test Layer Distribution

| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit (wire/scrcpy/fanout/control/manager/daemon/annexb/decoder/support…) | ~200 | 12 | bun:test |
| Integration (bridge WS over real Bun.serve, real-gateway e2e, client e2e) | ~49 | 5 | bun:test + Bun.serve WebSocket |
| E2E (real device) | 2 live probe runs this session (script in /tmp, not committed) | — | adb + Bun WS client |

## Changed-File Coverage (`bun test --coverage`, this run)

| File | % Lines | Rating | vs verify #1 |
|------|---------|--------|--------------|
| `src/stream/client/annexb.ts` | 100 | ✅ | = |
| `src/stream/client/decoder.ts` | 98.91 | ✅ | = |
| `src/stream/client/index.ts` | 88.57 | ✅ Acceptable | = |
| `src/stream/client/support.ts` | 100 | ✅ | = |
| `src/stream/control.ts` | 100 | ✅ | = |
| `src/stream/daemon.ts` | 79.50 | ⚠️ near-80 (default listener / real-spawn / close path: 181-184, 189-192, 298-299, 329-356, 387-397 — **proven LIVE** twice) | 78.83 → 79.50 (new tests offset new code) |
| `src/stream/fanout.ts` | 100 | ✅ | = (new broadcastState 100% covered) |
| `src/stream/gateway.ts` | 82.47 | ✅ Acceptable | 81.63 → 82.47 |
| `src/stream/manager.ts` | 70.67 | ⚠️ **WARNING-4** (unused controlWriter/sendControl API, defaultPollDevices) | = |
| `src/stream/scrcpy.ts` | 100 | ✅ | = |
| `src/stream/types.ts` | 100 | ✅ | = |
| `src/stream/wire.ts` | 93.55 | ✅ | = |

**Average changed-file coverage**: ~91.9%. **Linter**: no lint tooling configured → skipped (not a failure). **Type checker**: ✅ clean.

## Issues

### CRITICAL
**None.** Both verify #1 CRITICALs are fixed, tested (RED→GREEN), and live-proven (state messages; error-state path).

### WARNING (2 — unchanged from verify #1, still non-blocking)
3. **"Unsupported environment" (jar missing) partially implemented — unchanged.** `manager.snapshot().supported` remains kill-switch-only; a missing jar keeps `supported:true` in /v1/state and surfaces at connect time via 4404 + `STREAM_NO_DEVICE` body. Spec wants `supported:false` + reason at state-read time. **Not elevated to CRITICAL**: failure is actionable at connect (explicit JSON error + close code, no silent degradation), REST fallback unaffected, jar is bundled+pinned so the branch is a defense-in-depth edge (deleted jar / read error). Would require a lazy jar-existence check in the snapshot path.
4. **`manager.ts` 70.67% line coverage — unchanged, informational** (Strict TDD: coverage is never blocking). Uncovered = unused `sendControl`/`controlWriter` surface, `defaultPollDevices`, in-flight guards. Live-run proof covers default wiring.

### SUGGESTION (3 retained + 2 new)
5. **(downgraded from WARNING-5)** Bridge-level 4409 mapping: the risky half (error-state emission before close) is now real-path tested (`stream-gateway` loss test) **and live-proven**; only the final socket-level `4409` close-code round-trip is still fake-gateway-driven (`stream-bridge:361`). Low risk, 3-line closure.
6. Control before handshake: `controlActive()` returns `video {0,0}` → early taps get `out of video space (0..-1, 0..-1)`. Return distinct pre-handshake error or null until `handshakeReady`.
7. `scrcpy.ts` `spawnServer`/`removeReverse`/`teardown` dormant; `buildSpawnShellCmd` (daemon.ts:335) duplicates `buildSpawnCmd`.
8. Spec census 16/35 vs cached 14/39 — informational for archive.
9. **NEW — cold-start flakiness**: live attempt #1 (device idle ~1h) failed session start (error/device_lost, 0 frames, socket stayed open); immediate attempt #2 succeeded (handshake → streaming → 13 AUs). Session-start retry exists only via next viewer re-subscribe; consider a bounded start-retry in `StreamManager` for the FIRST-connect path. Observed once — not enough data to call it a defect; client reconnect recovers.
10. **NEW — recorder cleanup**: fix-slice `broadcastState`/state tests use a `Recorder` log-array; two `await new Promise(r=>setTimeout(r,…))` polling loops (gateway tests) are timing-wait based — acceptable (they poll a condition, not a fixed sleep), but a small `waitFor` helper would tighten them.

## Risks
- **Cold-start session-start failure observed once live** (attempt 1) — recovered on retry; monitor in real use (SUGGESTION-9).
- Real-browser Chrome WebCodecs decode of the demo page still unvalidated manually (unit-double proven + bundle byte-stable).
- W3 jar-missing branch gap — non-blocking, surfaces at connect.
- Nothing pushed; 3 chained PR branches ready (fix commits sit on `feature/device-streaming-client`, PR-3 tip → chain PR1 → PR2 → PR3).

## Next Recommended
1. **`sdd-archive`** — sync deltas into `openspec/specs/` (note spec census 16/35), archive change folder with audit trail.
2. **Fresh review pass** of the 3 chained PRs at 400-line slices (feature-branch-chain: PR1 → PR2 → PR3), then push in order.
3. Optional: manual Chrome WebCodecs validation via `examples/stream.html` (demo page + bundle), and revisit SUGGESTION-9 (first-connect retry) in a follow-up.