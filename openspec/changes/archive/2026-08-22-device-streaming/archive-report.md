# Archive Report: device-streaming

**Archived**: 2026-08-22
**Archived to**: `openspec/changes/archive/2026-08-22-device-streaming/`
**Final verdict**: PASS — cycle complete (planned → implemented under strict TDD → verified → spec-amended & remediated post-build → re-verified PASS → merged → archived)

## What Shipped

WebSocket H.264 live streaming for the Android device bridge, with a low-latency input control channel and a browser client — the primary live interaction path replacing ~1 fps `/v1/screenshot` polling:

| Capability | Detail |
|------------|--------|
| Stream core (`src/stream/`) | scrcpy 4.1 server push/reverse-tunnel/spawn lifecycle (`scrcpy.ts`), binary wire protocol parsing — 64B device-meta / 12B frame-meta / Annex-B AU split / control serialization from live-recorded fixtures (`wire.ts`), drop-oldest viewer fan-out ≤4 queued/viewer, cap 8 (`fanout.ts`) |
| Bridge integration | `WS /v1/stream/video` + `WS /v1/stream/control` routes in `src/bridge/server.ts` (secret gate, CORS, error shape consistent with REST); `StreamManager` start-on-first-viewer / teardown-on-last, device-loss watchdog (`manager.ts`, `daemon.ts`, `control.ts`); additive `stream {supported,active,reason,viewers}` on `GET /v1/state`; `OPENMOBILE_STREAM` env kill-switch |
| Browser client (`src/stream/client/`) | Annex-B splitter with cross-message buffering, WebCodecs `VideoDecoder`→canvas session (`avc1.PPCCLL`, SPS/PPS from handshake), `isStreamSupported()` probe (Firefox → polling fallback), `createStreamClient()` + `./stream-client` export; `examples/stream.html` demo |
| Assets & fixtures | Pinned `assets/scrcpy-server.jar` (sha256 asserted in tests) + live-recorded stream fixtures under `test/fixtures/` with re-record procedure |

## Final Verification Envelope

```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:eb9e196bb93cce21499a54751c157d0b7430abbf9d6408fb16860500daf1fcd7
verdict: pass
blockers: 0
critical_findings: 0
requirements: 16/16
scenarios: 32/32
test_command: bun test        # exit 0 — 313 pass / 0 fail across 21 files
build_command: bun run typecheck  # exit 0 — tsc --noEmit strict, clean
```

Validator admission: `gentle-ai sdd-verify-validate --requirements 16 --scenarios 32` → valid/pass on exactly these bytes. Tasks: **23/23 complete** (Phase 1: 9, Phase 2: 9 incl. 2.2a/2.5a, Phase 3: 5). Native dispatcher confirmed `verify=all_done`, `archive=ready`. Census per domain: device-streaming 6 req/13 scen, input-channel 3/9, local-bridge 4 normative + 1 completed REMOVED entry / 6 scen, screen-capture 2/4.

## Post-Build Remediation Summary

Work that happened AFTER the original build round, before final PASS (full detail in Engram observations #22, #27):

1. **Spec amendment** (3 by-design runtime-unverifiable clauses moved out of the verifiable census into Non-Goals):
   - `Early keyframe` scenario (device-streaming → Non-Goal "No early-keyframe delivery guarantee": intra-frame timing is encoder-controlled; manually verified on live devices only).
   - `Contract evolution` scenario (local-bridge → Non-Goal "No `/v2` versioning policy": future policy exercisable only when an actual breaking change lands).
   - `Downstream implementation` moved wholesale with its parent requirement `Contract Stability` (delta-format rules require ≥1 scenario per requirement; intent preserved as Non-Goal "No downstream implementation of the documented contract" — consumption owned by external `openchamber-emulator-surface` change).
2. **jar-missing PARTIAL closed by implementation**: `StreamManager.snapshot()` now gates `supported = enabled && jarPresent` at state-read time with machine-readable `reason: "jar_missing"` (src/stream/manager.ts, +26/-9; cached single `existsSync` in constructor). Strict TDD RED→GREEN: focused test failed first (`Expected: false, Received: true`), then 18/18 green; full suite 280 pass at fix time.
3. **Census correction**: requirements corrected from 15/15 to **16/16** — the completed REMOVED entry "No WebSocket/streaming endpoints (polling only)" counts as finished delta work (native dispatcher measures heading count). Scenarios unchanged 32/32; validator re-admitted PASS.

Earlier verify snapshots reported different numbers (e.g., the superseded pre-fix report claimed ~250 tests): those are historical intermediate states, superseded by the envelope above.

## Merge Reconciliations (Delta Sync onto Populated Main Tree)

Main `openspec/specs/{device-streaming,input-channel,local-bridge,screen-capture}/spec.md` already existed — populated by the earlier (stale) Aug-16 session and re-synced since by the `android-device-bridge` and `fix-cli-real-output` archives. Deltas were merged against actual main content, not copied over. Every requirement synced by prior changes was preserved.

| Domain | Action | Details |
|--------|--------|---------|
| device-streaming | Updated (2 edits) | Main carried the PRE-amendment sync: removed the stale `Early keyframe` scenario under "H.264 Stream Endpoint" and appended the early-keyframe Non-Goals bullet. Post-edit, main is byte-identical to today's delta (`diff -u` empty). |
| local-bridge | Updated (2 edits) | ADDED (Streaming WebSocket Endpoints, Additive Stream State, Stream Configuration) already present byte-identical; MODIFIED Localhost-Only Binding already applied ("REST and WebSocket"). Edits: downstream-implementation Non-Goal updated to amended wording ("`/v1` REST contract … no runtime test is constructible until that change lands" → "`/v1` WS/stream-state contract … (OpenChamber fork PR, explicit proposal Out-of-Scope)"); removed stale Out-of-Scope line "scrcpy-style streaming (deferred production path)" (superseded — streaming shipped). Base "Contract Stability" requirement synced by android-device-bridge preserved unchanged. |
| input-channel | No-op | All 3 ADDED requirements (Control Socket Input, Input Mode Selection, Text Injection Consistency) plus Non-Goals/Out-of-Scope already byte-identical in main; base Tap/Swipe/Text Input/Key Press/Focus-State Rules preserved. |
| screen-capture | No-op | Both ADDED requirements (Polling as Fallback, Streaming Primary Path) already present byte-identical. Main's enriched persistence Non-Goal ("…returned bytes are transmitted, temp files are ephemeral") supersedes the delta's shorter clause and was kept. |

### REMOVED Requirement Outcome

Delta declares `## REMOVED Requirements` → "No WebSocket/streaming endpoints (polling only)" (with Reason/Migration note present in the delta). Checked current main `openspec/specs/local-bridge/spec.md`: **the requirement is absent** — it never survived to the populated tree (earlier archives did not carry it forward, and the streaming surface is already specified there). Outcome: **no-op / already-absent**; no deletion required. The completed removal still counts as finished delta work in the 16/16 census.

## Stale Archive Directory Resolution

A parallel-truth hazard existed: `openspec/changes/archive/2026-08-16-device-streaming/` contained OUTDATED artifacts from a prior session (pre-fix `verify-report.md` with ~250 tests, pre-amendment delta specs, its own archive-report and state.yaml). Resolution performed this session:

1. Today's change folder was archived first as `2026-08-22-device-streaming/` (single source of truth), verified byte-identical via snapshot `diff -r` readback (empty, exit 0).
2. Uniquely-historical files from the old dir were hash-compared against the new archive and MOVED intact into `2026-08-22-device-streaming/superseded-2026-08-16/` preserving relative paths:
   - `archive-report.md` (sha256 `1be36046…`)
   - `state.yaml` (sha256 `08770233…`)
   - `verify-report.md` — pre-fix version (sha256 `7b6385a2…`)
   - `specs/device-streaming/spec.md` — pre-amendment (sha256 `9db8471d…`)
   - `specs/local-bridge/spec.md` — pre-amendment (sha256 `49f0dc35…`)
   All destination hashes verified equal to source hashes after the move.
3. The remaining old-dir files were proven byte-identical to their counterparts in the new archive (sha256 match: design.md, proposal.md, tasks.md, specs/input-channel/spec.md, specs/screen-capture/spec.md) before the old dir was removed with `rm -rf`. No unique bytes were destroyed.

`openspec/changes/archive/2026-08-16-device-streaming/` no longer exists; this folder is the single archive of record for the change. Files inside `superseded-2026-08-16/` are historical evidence ONLY — not current truth.

## Engram Traceability

Observation IDs read during this archive (project `openmobile`):
- **#21** `sdd/device-streaming/verify-report` — census correction 15→16 + authoritative final envelope (matches the archived verify-report bytes exactly)
- **#27** `sdd/device-streaming/spec-amendment` (+ appended `sdd/device-streaming/jar-supported-fix`) — amendment rationale, jar gating RED→GREEN evidence
- **#22** session summary — verify-report regeneration context

No separate Engram proposal/design/tasks/apply-progress observations exist for this change (it predates mirror coverage); repo artifacts are authoritative and were read from disk.

## Archive Contents

- proposal.md ✅
- specs/ ✅ (4 domains)
- design.md ✅
- tasks.md ✅ (23/23 complete)
- verify-report.md ✅ (final PASS bytes, sha256 `cb6bc8628087e7102c9c6f8c143ea278013dea6805d45618cb8040172e2e7f2b` — preserved byte-exact through the move)
- archive-report.md ✅ (this file, additive)
- superseded-2026-08-16/ ✅ (historical evidence subfolder)

Move executed via plain `mv` (no git operations per orchestrator constraint); `diff -r` readback against pre-move recursive snapshot returned empty.

## Source of Truth Updated

- `openspec/specs/device-streaming/spec.md` — post-amendment streaming spec (byte-identical to archived delta)
- `openspec/specs/local-bridge/spec.md` — WS surface + additive stream state + kill-switch config; amended Non-Goals; stale out-of-scope line dropped
- `openspec/specs/input-channel/spec.md` — control-socket fast path + mode selection (unchanged; already synced)
- `openspec/specs/screen-capture/spec.md` — polling fallback + streaming primary path (unchanged; already synced)

## Carried Risks

1. **Chained-PR branch composition check before push**: tasks forecast High 400-line budget risk with a 3-slice feature-branch chain (core → bridge → client). Before any push, verify each branch contains only its slice's commits — the working tree also holds unrelated RTC WIP (`src/device/grpc.ts`, `protos/`, `src/stream/rtc/`, `test/device-grpc.test.ts`, `test/stream-rtc-allowlist.test.ts`) that MUST NOT leak into these PRs.
2. **Cold-start flakiness**: live emulator capture paths (fixture recording, first-stream startup on emulator-5554) depend on device warm-up timing; the deterministic suite mocks sockets, but cold starts on real devices may need retry patience.
3. **Suite re-baseline after RTC lands**: the 313-pass baseline includes passing WIP tests from the separate in-progress RTC effort; once that change lands, expect the suite total to shift — re-baseline counts rather than comparing against this number blindly.
