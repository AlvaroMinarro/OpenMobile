# Archive Report: Device Streaming

**Date**: 2026-08-16 · **Artifact store**: hybrid (engram + openspec) · **Mode**: openspec-convention delta sync + archive move
**Change**: `device-streaming` (openmobile) · **Source HEAD**: `feature/device-streaming-client` @ `24352ce` · **Verify**: PASS WITH WARNINGS (obs #590, 259/259 tests — refreshed post-review-fixes)
**This archive touched `openspec/` docs ONLY — no `src/`, tests, `package.json`, or `assets/` changes. Nothing committed, nothing staged by hand (`git status` below reflects the doc moves).**

## Verdict Gating

Verified PASS WITH WARNINGS (2 informational WARNINGs, no CRITICALs — obs #590, re-run #2 post-fix-slice). Safe to archive per sdd-archive skill gate.

## Delta Sync — what landed where

Base targets for the device-streaming DELTA specs were the **unarchived** per-change specs of `android-device-bridge` (main `openspec/specs/` was empty — first archive in this project). Each delta header documented this targeting. Sync = copy-with-edits (delta-notation stripped: `(Previously: …)` annotations removed, ADDED appended, MODIFIED replaced in place, REMOVED deleted, delta Non-Goals/Out-of-Scope supersede base sections).

| Domain | Main spec (post-archive) | Delta action | Applied onto | Result |
|--------|--------------------------|--------------|--------------|--------|
| device-streaming | `openspec/specs/device-streaming/spec.md` | **NEW** (full spec, copied verbatim) | — | 6 req / 14 sc |
| local-bridge | `openspec/specs/local-bridge/spec.md` | 3 ADDED / 2 MODIFIED / 1 REMOVED (non-goal) | `android-device-bridge/specs/local-bridge/spec.md` | 8 req / 14 sc |
| input-channel | `openspec/specs/input-channel/spec.md` | 3 ADDED | `android-device-bridge/specs/input-channel/spec.md` | 8 req / 17 sc |
| screen-capture | `openspec/specs/screen-capture/spec.md` | 2 ADDED | `android-device-bridge/specs/screen-capture/spec.md` | 5 req / 9 sc |

### Copy-with-edits judgment calls (documented, none destructive)

1. **Purposes minimally updated** where the base Purpose contradicted the merged requirements: `local-bridge` (HTTP daemon → daemon, REST + WebSocket) and `input-channel` (`via adb shell input` → adb when polling + control socket when streaming). `screen-capture` and `device-streaming` Purposes unchanged (still accurate).
2. **MODIFIED requirements** (`local-bridge`: Localhost-Only Binding, Contract Stability) merged with their NEW text + updated scenario wording; the `(Previously: …)` change-notes stripped. Contract Stability's note substance folded into the requirement as a positive clause ("documented contract MUST include the streaming WS protocol shape and the `stream` state object").
3. **Stale base marker dropped**: `local-bridge` base footer "> Design decision needed: exact JSON field schema for /v1/state, error-body shape/status codes, shared-secret header" — those decisions are now implemented AND specified (Additive Stream State defines the schema; Stream Configuration mandates the secret gate/error shape), so the marker is obsolete; not carried into the main spec.
4. **Non-Goals / Out of Scope**: delta sections supersede base sections where present (local-bridge, input-channel); screen-capture delta has no Out of Scope → base Out of Scope preserved.
5. Base requirements not mentioned in the deltas were preserved verbatim (per skill rule).

## Spec Census — reconciled to REAL on-disk numbers

| Source | Requirements | Scenarios | Notes |
|--------|-------------|-----------|-------|
| Cached preflight (superseded) | 14 | 39 | miscount: ADDED-only requirements (dropped the 2 MODIFIED); scenarios over-counted |
| Verify matrix (obs #590) | 16 | 35 | delta-scope: 6 new-domain + 3 + 2 MODIFIED + 3 + 2 ≈ 16 req; scenarios 14 + 5 + 3 + 9 + 4 = 35 ✓ reconciled |
| **Archived main specs (real on-disk)** | **27** | **54** | 6/14 + 8/14 + 8/17 + 5/9, counted from the merged files (`^### Requirement:` / `^#### Scenario:` on `openspec/specs/*/spec.md`) |

The 16/35 verify matrix is the delta-scope compliance count; the 27/54 is the total merged source-of-truth census. The archived spec files carry the real numbers; SUGGESTION-8 from verify is resolved.

## Delta chain state (base changes NOT archived — documented, not closed)

`android-device-bridge` (9 full base specs) and `fix-cli-real-output` (deltas on 6 of those domains) are **still active changes**: all tasks `[x]`, work merged and covered by the 259-test suite (refreshed post-review-fixes), but **neither has a verify-report nor an archive** — sdd-archive skill gates on the verification report, so they were NOT archived by this phase.

- When `fix-cli-real-output` archives, its screen-capture delta (Unique Temp PNG Names, Temp PNG Cleanup, Spawn Timeout — pure ADDED) merges cleanly into `openspec/specs/screen-capture/spec.md`; its other 5 deltas land as new main specs.
- When `android-device-bridge` archives, its specs are FULL specs, not deltas: the archive step must MERGE/verify against the already-populated mains (device-streaming's mains derive from exactly those bases) — **do NOT copy-over** (`openspec/specs/` non-empty rule). Remaining domains (device-discovery, emulator-lifecycle, logcat-read, ui-tree, agent-feedback-loop, deploy-app, cli-output-fixtures) will be created then.
- Recommend: run sdd-verify for both changes (test suite already green), then archive them in order (android-device-bridge → fix-cli-real-output).

## Archive contents (audit trail — unmodified originals)

- proposal.md ✅ (Intent: replace ~1fps polling with scrcpy raw H.264 WS streaming + control socket; scope: `src/stream/`, WS routes, additive state, browser client, fallback)
- specs/ ✅ (4 delta spec files, unmodified — delta annotations/headers preserved)
- design.md ✅ (scrcpy v4.1 raw-stream wiring, LIVE-validated wire facts, D1–D7 decisions)
- tasks.md ✅ (21/21 `[x]` — phases 1–3: core/wire, bridge integration, browser client)
- verify-report.md ✅ (PASS WITH WARNINGS, 259/259, obs #590 — refreshed post-review-fixes)
- state.yaml ✅ (close marker, created by this phase — no state.yaml existed for any change; DAG was session-tracked)
- archive-report.md ✅ (this file)

Folder moved to: `openspec/changes/archive/2026-08-16-device-streaming/`

## Engram traceability (project `openmobile`)

| Artifact | Topic key | Observation |
|----------|-----------|-------------|
| Proposal | `sdd/device-streaming/proposal` | #585 |
| Spec | `sdd/device-streaming/spec` | #586 |
| Design | `sdd/device-streaming/design` | #587 |
| Tasks | `sdd/device-streaming/tasks` | #588 |
| Apply progress | `sdd/device-streaming/apply-progress` | #589 |
| Verify report | `sdd/device-streaming/verify-report` | #590 |
| **Archive report** | `sdd/device-streaming/archive-report` | #591 (this save) |

## Git state (NOT committed, per archive convention)

- Branch `feature/device-streaming-client` @ `24352ce` (refreshed post-review-fixes), working tree previously clean except untracked `openspec/changes/device-streaming/verify-report.md`.
- After archive: `openspec/specs/*` (4 new files, untracked), `openspec/changes/archive/2026-08-16-device-streaming/*` (untracked new), old `openspec/changes/device-streaming/*` paths (deleted), `verify-report.md` no longer under the old path. All docs-only; nothing staged; no commit performed.
- The 3 chained PR branches are unaffected (their openspec commits stay as they are; this archive is a post-verify doc operation on the PR-3 branch tip).

## Risks / next

- **Unarchived bases** (android-device-bridge, fix-cli-real-output): their deltas/full specs are partially reflected in main specs only for the 4 device-streaming domains. Until they archive, `openspec/specs/` is a partial source of truth. Mitigation: verify+archive both (in order) before the next change whose deltas touch those domains; the screen-capture merge is additive and clean.
- **Future android-device-bridge archive must not copy-over mains** (full-spec vs delta distinction noted above).
- Verify SUGGESTIONs (cold-start retry, 4409 round-trip closure, Chrome WebCodecs manual validation, recorder waitFor helper) are follow-up candidates, not archive blockers.
- Census: cached 14/39 superseded by 16/35 (verify matrix) and 27/54 (merged on-disk); keep 27/54 as the current source-of-truth numbers.

**Next recommended**: fresh-context review of the 3-branch diff (feature-branch-chain PR1 → PR2 → PR3), then push in order; then sdd-verify + sdd-archive for android-device-bridge and fix-cli-real-output.