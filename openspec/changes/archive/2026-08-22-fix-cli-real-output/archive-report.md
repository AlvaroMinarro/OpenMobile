# Archive Report: Fix CLI Real Output

**Date**: 2026-08-22 · **Artifact store**: hybrid (engram mirror + openspec filesystem) · **Mode**: openspec-convention delta sync + plain-filesystem archive move
**Change**: `fix-cli-real-output` (openmobile) · **Verify**: PASS (final envelope below) · **Tasks**: 16/16 complete
**This archive touched `openspec/` docs ONLY — no `src/`, `test/`, or other changes' folders touched. NO git operations performed (plain `cp`/`mv` only, nothing staged or committed, per orchestrator constraint).**

## Verdict Gating

Final verify verdict **PASS**: 0 blockers, 0 critical findings, 0 warnings. Task Completion Gate passed from the persisted `tasks.md` (16 `[x]` / 0 unchecked: Phase 1 = 4, Phase 2 = 7, Phase 3 = 5) — no stale-checkbox reconciliation was needed. Native review gate: none discovered for this candidate; archive proceeded under ordinary repository policy.

## Final Verification Evidence (state AT CLOSE)

```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:9b62f6043b56db65ce6a8f93a8bca103cfb113883f69fefe527a7d977019d8c6
verdict: pass
requirements: 28/28
scenarios: 60/60
test_command: bun test        # exit 0 — 313 pass / 0 fail / 1035 expect() calls across 21 files
build_command: bun run typecheck   # exit 0 (tsc --noEmit clean)
test_output_hash: sha256:cc3523275ddd35e306735b5e748609aa059329b80ec1bcd0f6e9d32043fdbc3c
build_output_hash: sha256:8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92
```

Authoritative sources ranked: the persisted verify-report (regenerated at close, byte-preserved into this archive) matches the dispatcher's launch envelope on every value; apply-progress (obs #37) is an intermediate snapshot — its 298→313 progression narrative is history, and its final counts agree with the close state. No unrankable contradictions remain.

**Fix round was TESTS-ONLY**: production `src/**` left byte-identical (verified via `cmp` at apply time); every admitted FAIL gap (version-pin assertion CRITICAL, 9 UNTESTED scenarios, PARTIAL rows) closed through behavioral tests plus one backward-compatible test-helper signature extension (`loadFixture(name, dir?)`). Strict-TDD evidence: obs #37 mutation-proofs (pin-check disabled, wrappers swallowing timeouts, midpoint broken, targetable flag removed, stop guard disabled, logcat default removed — each RED then restored).

## What Shipped

Hardened `src/device/` against real `android` CLI v1.0.15985488 output, closing the 3 live-run CRITICALs (C1 UI coordinates collapsed to (0,0); C2 logcat streamed forever; C3 running emulators reported stopped) plus W1/W2/W3/W5:

- **W2 per-spawn timeouts** everywhere in `BunCommandRunner`: `SPAWN_TIMEOUTS` tiers (10s–120s), `SpawnTimeoutError{argv,timeoutMs}` race+kill, surfaced end-to-end ×5 through handlers as actionable errors.
- **C1/D3 dual-shape UI parsing**: string `"[x,y]"` center, bounds-midpoint rescue, hyphenated `resource-id`/`content-desc`/`off-screen` mapping, relaxed `detectDiffShape`; `(0,0)` fallback ONLY with `targetable:false`.
- **C2/D4 bounded logcat**: `adb logcat -d -t N -v time [--pid] [*:P]`, native filterspec + fixed regex, headers dropped under filter, `truncated` flag, newest-first.
- **C3/D5 emulator lifecycle**: `emulator list --long` Online/Offline+serial parse; start correlates via `started as '(emulator-N)'` marker (pre/post device-list diff fallback) and polls THAT serial — never the first `state=device` device.
- **W1/D6 device props**: `getprop` for SDK/model (`android info` dropped), best-effort `wm size/density`.
- **W3/D7 temp PNG hygiene**: unique names (`crypto.randomUUID`), try/finally host-side rm, unique device-side path + `adb shell rm`, concurrency-safe ownership proven.
- **New capability `cli-output-fixtures`**: 6 recorded envelopes pinned v1.0.15985488 with provenance enforced AT LOAD by the production loader; recorder script + README re-record procedure.

## Delta Sync — what landed where

Five domains became NEW main specs (no prior main existed); their deltas targeted the still-unarchived `android-device-bridge` per-change specs, so each was resolved against that named base (project precedent: `archive/2026-08-16-device-streaming/archive-report.md`). `screen-capture` merged onto the existing main. Sync order respected the skill rule: deltas synced BEFORE the folder move.

| Domain | Main spec (post-archive) | Delta action | Resolved against | Result |
|--------|--------------------------|--------------|------------------|--------|
| cli-output-fixtures | `openspec/specs/cli-output-fixtures/spec.md` | **NEW** full spec — verbatim mechanical `cp` + `diff -r` readback | — (change is the base) | 3 req / 11 sc |
| device-discovery | `openspec/specs/device-discovery/spec.md` | 2 ADDED / 4 MODIFIED | `android-device-bridge/specs/device-discovery/spec.md` | 6 req / 12 sc |
| emulator-lifecycle | `openspec/specs/emulator-lifecycle/spec.md` | 3 ADDED / 4 MODIFIED | `android-device-bridge/specs/emulator-lifecycle/spec.md` | 7 req / 14 sc |
| logcat-read | `openspec/specs/logcat-read/spec.md` | 2 ADDED / 2 MODIFIED | `android-device-bridge/specs/logcat-read/spec.md` | 4 req / 6 sc |
| ui-tree | `openspec/specs/ui-tree/spec.md` | 3 ADDED / 2 MODIFIED | `android-device-bridge/specs/ui-tree/spec.md` | 5 req / 12 sc |
| screen-capture | `openspec/specs/screen-capture/spec.md` (existing) | 3 ADDED (pure append) | current main spec | 8 req / 14 sc |

Synced-domain total: **28 req / 60 sc — reconciles exactly to the verify matrix's delta-scope count.**

### Copy-with-edits judgment calls (documented, none destructive)

1. **Delta notation stripped** from merged mains: `# Delta for …` titles → proper spec titles, `> Base:` headers, `(Previously: …)` annotations, and `(Unchanged behavior retained.)` bookkeeping removed.
2. **Purpose minimally updated where contradicted**: `device-discovery` ("expose environment metadata" → device metadata queried over adb, since W1 removed environment sourcing). Other Purposes unchanged (still accurate).
3. **Stale base footers dropped where decisions are now implemented AND specified**: `emulator-lifecycle`'s "define ready precisely" marker (answered: adb state `device`, bounded wait, tool-polled — D5, runtime-proven by start-correlation tests) and `ui-tree`'s `--diff` baseline-ownership marker (answered: CLI-owned baseline, no stale diff reporting — now an explicit MUST in the merged requirement).
4. **MODIFIED replaces whole requirement blocks including scenarios**: `device-discovery > Device Info` lost its CLI-available/CLI-unavailable scenarios in favor of the delta's SDK-via-getprop/screen-properties scenarios — intentional supersession recorded here.
5. **Out of Scope sections**: deltas carried none → base Out of Scope preserved verbatim in all four merged domains. **Non-Goals**: delta versions used where present (emulator-lifecycle and ui-tree add fixture-version/no-fixture lines); `screen-capture` persistence Non-Goal gained the delta's ephemerality parenthetical "(returned bytes are transmitted, temp files are ephemeral)".
6. **Base requirements not mentioned in any delta preserved verbatim** per skill rule.

## Spec Census — reconciled to REAL on-disk numbers

| Source | Requirements | Scenarios | Notes |
|--------|-------------|-----------|-------|
| Verify matrix (obs #20, delta scope) | 28 | 60 | cli-output-fixtures 3/11, device-discovery 6/12, emulator-lifecycle 7/14, logcat-read 4/6, screen-capture 3/5, ui-tree 5/12 ✓ equals synced-domain total above |
| **Main specs after sync (real on-disk)** | **55** | **114** | counted via `^### Requirement:` / `^#### Scenario:` across all 9 domains |

Full source-of-truth census: cli-output-fixtures 3/11 · device-discovery 6/12 · device-streaming 6/14 (untouched) · emulator-lifecycle 7/14 · input-channel 8/17 (untouched) · local-bridge 8/14 (untouched) · logcat-read 4/6 · screen-capture 8/14 · ui-tree 5/12.

## Archive contents (audit trail — unmodified originals)

- proposal.md ✅ (Intent: harden device core against real CLI v1.0.15985488 output; C1–C3 + W1/W2/W3/W5)
- specs/ ✅ (6 delta spec files, unmodified — delta annotations/headers preserved)
- design.md ✅ (live-verified wire facts 2026-08-14, D1–D7 decisions, SPAWN_TIMEOUTS table)
- tasks.md ✅ (16/16 `[x]`)
- verify-report.md ✅ (PASS, 28/28 req · 60/60 sc, 313/0 tests, typecheck clean — bytes preserved exactly; file sha256 `0b62214b46f1f2909c465a48804ed86c4a0e3f2e4b451c41923c51895b03e8a1`)
- archive-report.md ✅ (this file — the only addition, excluded from the `diff -r` readback)

Folder moved to: `openspec/changes/archive/2026-08-22-fix-cli-real-output/` via plain `mv`; pre-move recursive snapshot compared with `diff -r` → **empty (byte-identical)**; source path confirmed gone. No `state.yaml` existed for this change and none was invented (DAG was session-tracked; the orchestrator's artifact list did not include one).

Mechanical Copy Contract evidence (verbatim):
```
=== diff -r snapshot vs archived tree ===
=== READBACK PASS: byte-identical ===
```
(The `diff -r` produced no difference lines; cli-output-fixtures verbatim spec copy likewise produced an empty diff before its rename into place.)

## Engram traceability (project `openmobile`)

| Artifact | Topic key | Observation |
|----------|-----------|-------------|
| Apply progress (TDD evidence) | `sdd/fix-cli-real-output/apply-progress` | #37 (read) |
| Verify report | `sdd/fix-cli-real-output/verify-report` | #20 (read) |
| **Archive report** | `sdd/fix-cli-real-output/archive-report` | saved by this phase |

Proposal/spec/design/tasks for this change were not found as Engram observations under the `sdd/fix-cli-real-output/*` namespace (searched); the archived files on disk are authoritative for them (hybrid mode).

## Working tree / git state (NOT committed, per constraint)

No `git add`/`commit`/`git mv` was run. Net filesystem effects of this phase: `openspec/changes/fix-cli-real-output/` → `openspec/changes/archive/2026-08-22-fix-cli-real-output/` (moved), 5 new + 1 updated files under `openspec/specs/`. Unrelated in-flight RTC/emulator work (`src/device/grpc.ts`, `protos/`, `stream/rtc/`) present in the tree was NOT touched and is NOT part of this change. Other active changes (`android-device-bridge`, `device-streaming`, `emulator-native-stream`) untouched.

## Risks / follow-ups carried from verify (all SUGGESTION-level, none blocking)

1. Disjunctive stuck-spawn scenarios proven end-to-end through one entry point each (`list_devices`, `emulator_list`); cheap belt-and-suspenders twins exist for `get_device_info`/`emulator_start` (shared guarded-spawn wiring).
2. Add coverage reporting so changed-file coverage can be evidenced in future verify rounds instead of being skipped.
3. Per-change test isolation would keep unrelated WIP out of future runs (hygiene only; does not affect these results).
4. **Chain state**: `android-device-bridge` remains the last unarchived base. When it archives, its specs arrive as FULL specs against now-populated mains (including the five created here) — MERGE/reconcile, do NOT copy-over. Its `screen-capture`/`input-channel`/`local-bridge` bases also predate device-streaming's additions, so three-way reconciliation may be needed there.
5. Fixture pin v1.0.15985488 will drift with future CLI upgrades — re-record procedure is documented in `test/fixtures/README.md`.

**Next recommended**: Phase 0 — done. The SDD cycle for `fix-cli-real-output` is fully closed: planned, implemented (strict TDD), verified PASS, specs synced, archived.
