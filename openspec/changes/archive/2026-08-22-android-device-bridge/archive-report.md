# Archive Report: android-device-bridge

**Archived**: 2026-08-22
**Archived to**: `openspec/changes/archive/2026-08-22-android-device-bridge/`
**Final verdict**: PASS — cycle complete (planned → implemented under strict TDD → verified → merged → archived)

## What Shipped

Nine capabilities forming the Android device bridge (`@openmobile/android-device-bridge`): an MCP server exposing ~12 device tools over stdio, a localhost-only HTTP bridge daemon locking the `/v1` contract, and an OpenCode plugin pushing device state into agent context.

| Capability | Requirements | Scenarios |
|------------|--------------|-----------|
| device-discovery | 4 | 9 |
| emulator-lifecycle | 4 | 7 |
| ui-tree | 2 | 6 |
| screen-capture | 3 | 5 |
| logcat-read | 2 | 3 |
| deploy-app | 3 | 6 |
| input-channel | 5 | 8 |
| local-bridge | 5 | 8 |
| agent-feedback-loop | 4 | 5 |
| **Total** | **32** | **57** |

## Final Verification Envelope

```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:9c5f8f31e2f6b78ccbbdb3c43dc8932bdbfd058d43e396ff52a3ddc2f2cddd43
verdict: pass
blockers: 0
critical_findings: 0
requirements: 32/32
scenarios: 57/57
test_command: bun test        # exit 0 — 318 pass / 0 fail across 21 files (190 belong to this change)
build_command: bun run typecheck  # exit 0 — tsc --noEmit strict, clean
```

Validator admission: `gentle-ai sdd-verify-validate --requirements 32 --scenarios 57` → valid/pass on exactly these bytes. Changed-file coverage averages 95.65% lines across 14 files.

## Fix Rounds After Initial Apply

Both rounds ran after the first verify admitted FAIL (28/32 req, 53/57 scen) and are fully evidenced in Engram `sdd/android-device-bridge/apply-progress` (observation #33, TDD cycle tables for both rounds).

**Round 1** — implemented the specified-but-unwired screencap CLI→adb fallback on both the tool path and `/v1/screenshot` bridge path, added 18 RED-first tests covering 10 previously UNTESTED scenarios (RSA-prompt hint, unknown-AVD error, duplicate-AVD rejection, signature-conflict ×2, ui-tree composition ×4, resolve-labels unknown-label, wmSize probe, tap out-of-range gate), plus one `/v2` Non-Goals amendment. Baseline stayed green throughout (64/64 → … → 298 pass). Build hash unchanged from baseline.

**Round 2** — zero production-code changes (build hash byte-identical to round 1, proving test/spec-only closure): `deploy_app` zero-device e2e (assertSatisfied proves no install/launch issued); four behavioral compaction-hook tests executing the previously type-only-tested hook body (plugin coverage 39.44% → 52.24% lines); local-bridge spec amendment replacing the future-facing scenario; annotated-capture PARTIAL resolved honestly by spec amendment rather than coverage-by-invention (R2-4 NEEDS_DECISION outcome: no consumable CLI annotate payload exists to test against). 313 → 318 pass.

## Spec Amendments Made During Readiness Rounds

1. `specs/local-bridge/spec.md` — the Contract-evolution future-policy clause moved from a scenario to a Non-Goals bullet (`/v2` routing is future policy, no runtime test constructible today); the downstream-consumer scenario replaced by the today-testable "Documented contract" scenario (README §`/v1` route shapes/statuses/error bodies runtime-pinned by `test/bridge.test.ts`) plus a Non-Goals bullet scoping downstream consumption to the external `openchamber-emulator-surface` change.
2. `specs/screen-capture/spec.md` — the Annotated Screenshot scenario now tests the numbered-overlay PNG actually produced by the CLI `--annotate` invocation; the label→element mapping moved to Out of Scope as externally gated (no documented annotate payload format, no recorded fixture).

## Merge Reconciliations (Delta Sync onto Populated Main Tree)

Main `openspec/specs/` was already populated by the `fix-cli-real-output` (and earlier `device-streaming`) archives. Deltas were merged, not copied over; every requirement already synced by those changes was preserved.

| Domain | Action | Details |
|--------|--------|---------|
| agent-feedback-loop | Created | New domain — mechanical shell copy, `diff -r` readback empty. 4 req / 5 scen. |
| deploy-app | Created | New domain — mechanical shell copy, `diff -r` readback empty. 3 req / 6 scen. |
| device-discovery | No-op (superseding reconciliation) | List Devices, Surface Connection States, Device Selection identical to main. Delta's Device Info carried the older CLI-first transport clause ("via the `android` CLI when available") that the implementation deliberately does not follow (verify-report WARNING 1 / D6 refinement: adb getprop/wm exclusively). Main's verified wording ("from adb device property queries") was KEPT, so the source of truth matches shipped behavior. Main-only requirements preserved untouched: Device Properties via adb, Spawn Timeout on Discovery Subprocesses. Purpose kept in main's adb form. |
| emulator-lifecycle | No-op (main refines delta) | All four delta requirements present in main with stricter refinements (running-marker parse clause, Fixture-verified markers scenario, started-emulator correlation in Launch-and-boot/Boot-timeout wording). Preserved main-only: Real Running Markers, Spawn Timeout on Lifecycle Subprocesses, Start Confirms the Started Emulator. Stale trailing design-note blockquote in delta NOT synced (readiness question resolved as D3/D5). |
| input-channel | No-op | Tap, Swipe, Text Input, Key Press, Focus-State Rules byte-identical. Preserved streaming-scope requirements: Control Socket Input, Input Mode Selection, Text Injection Consistency. Purpose/Non-Goals kept in main's multi-channel form. |
| logcat-read | No-op (main refines delta) | Filtered Log Read kept in main's dump-and-tail form (`adb logcat -d -t N` with `-v time`, pinning real output). Bounded Output identical. Preserved Dump-and-Tail Read, Spawn Timeout. |
| ui-tree | No-op (main refines delta) | Full UI Tree / UI Tree Diff kept in main's hardened form (real non-zero bounds; shape-tolerance sentence; "parsed with real coordinates"). Preserved Real CLI Layout Shape Tolerance, Spawn Timeout, No Silent Fallback to (0,0). Stale design-note blockquote NOT synced (resolved as D1: server owns baseline marker). |
| screen-capture | Modified + append | MODIFIED: Annotated Screenshot requirement block replaced with the round-2 amended version (numbered-overlay PNG only; mapping deferred while no consumable CLI payload exists). APPENDED: label→element-mapping bullet to Out of Scope. Raw Screenshot and Resolve Screen Labels identical. Preserved all five prior-synced requirements: Polling as Fallback, Streaming Primary Path, Unique Temp PNG Names, Temp PNG Cleanup, Spawn Timeout. |
| local-bridge | Modified + appends | MODIFIED: Localhost-Only Binding lost its Contract-evolution future-policy scenario (per authorized round-2 amendment; Binding scenario keeps main's "(REST and WebSocket)" wording). MODIFIED: Contract Stability replaced wholesale by the amended block (today-testable Documented-contract scenario; the WS-documentation sub-clause was narrowed out — normative home for WS endpoints remains the intact Streaming WebSocket Endpoints requirement synced by device-streaming, and README documents the full contract including WS). APPENDED: two Non-Goals bullets (`/v2` policy, downstream implementation) and the scrcpy Out-of-Scope line. Preserved: Device State Endpoint, Screenshot Endpoint, Input Endpoints, Streaming WebSocket Endpoints, Additive Stream State, Stream Configuration. |

No REMOVED requirements at the whole-requirement level and no destructive merges occurred beyond the two pre-authorized amendments above; the `rules.archive` warn-before-destructive condition is satisfied by the dispatcher's explicit confirmation of both amendments in the launch prompt. Post-merge grep confirmed zero residual references to the removed scenario/clause anywhere in `openspec/specs/`.

## Gates at Archive Time

- **Task Completion Gate**: PASS — persisted `tasks.md` shows 17/17 checked (re-verified in the archived copy: 0 unchecked).
- **Native Review Receipt Gate**: `reviewGate` structurally absent from structured status — archive proceeded under ordinary repository policy.
- **Verification gate**: final verify-report verdict PASS with 0 CRITICAL findings; no override needed.

## Carried-Over Risks & Suggestions (from final verify-report)

**Warnings (non-blocking, disclosed):**
1. `get_device_info` transport deviation (deliberate, negative-control-pinned): the implementation queries adb `getprop`/`wm` exclusively. Note: the merge kept main's adb-based Device Info wording, so the main spec tree now matches the implementation; the deviation existed only against this change's delta text.
2. `swipe`/`input_text` MCP handler bodies uncovered at the tool layer — behavior proven one layer down (bridge HTTP + adb wrapper).
3. Annotated-capture pixel rendering comes from the external CLI `--annotate` overlay; tests pin the invocation and PNG return but cannot assert rendered pixels without a live device.

**Suggestions:**
- Record a real `--annotate` fixture when a live device is next available, giving the annotated-capture row payload-level ground truth.
- Once `openchamber-emulator-surface` lands, add cross-repo conformance evidence for the Contract Stability downstream goal (tracked in Non-Goals, required by no scenario).

## Traceability

- Engram observations read: #33 `sdd/android-device-bridge/apply-progress` (full — both TDD round tables), #15 `sdd/android-device-bridge/verify-report` (mirror of the on-disk report used as primary).
- Archived artifacts: proposal.md, design.md, exploration.md, tasks.md (17/17), verify-report.md (bytes preserved verbatim through the move), specs/ (all 9 delta domains).
- Mechanics: plain `mv` (no git operations, per constraint), recursive pre-move snapshot, mandatory `diff -r` readback returned empty (exit 0). Active changes directory retains only unrelated work (device-streaming, emulator-native-stream); no src//test files touched by this phase.
