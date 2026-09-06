# Archive Report: emulator-native-stream

**Change**: emulator-native-stream
**Archived**: 2026-09-06
**Branch**: feature/emulator-native-stream (final commit at verify time: a27ad58; 20 work-unit commits total)
**Artifact store**: hybrid (openspec files authoritative; this report also mirrored to Engram `openmobile` topic `sdd/emulator-native-stream/archive-report`)
**Verdict carried into archive**: PASS WITH WARNINGS (final remediation rerun per verify)

## Final State at Close

Per the Final-State Authority hierarchy, this section reflects the state at close, superseding intermediate snapshots.

- **Apply**: 30/30 tasks complete across 3 phases — PR1 (native gRPC control + launch flags + full scrcpy removal), PR2 (RtcSession + JSEP signaling + rtc state), PR3 (browser RTCPeerConnection client rewrite).
- **Final test suite**: 549 pass / 0 fail / 1 documented env-gated skip (`OPENMOBILE_RTC_LIVE=1` live RTC conformance, no emulator in this environment) across 38 test files; `tsc --noEmit` clean; `bun run build:stream-demo` success at 7.70 KB.
- **Verify (final)**: PASS WITH WARNINGS — 20/20 requirements, 45/45 scenarios compliant, 0 CRITICAL / 3 WARNING / 3 SUGGESTION. The corrected verify report was admitted by the validator (sha256 a3178d72…). The previously-missing requirement `Drop-Oldest Backpressure` (device-streaming) was REMOVED in the delta and is compliant via deletion evidence (host frame queues verifiably gone; viewer cap survives folded into Video Stream Endpoint).
- **Runtime ledger**: sdd-attempt objective complete — all 3 work units implemented and verify settled passed.

## Specs Synced (main specs tree updated BEFORE the archive move)

| Domain | Action | Details |
|--------|--------|---------|
| device-streaming | Updated | 5 requirements replaced (Stream Support Detection; H.264 Stream Endpoint → renamed **Video Stream Endpoint** per the delta's `(Previously: …)` line; Control Channel; Fallback Contract; Stream Lifecycle); 1 requirement REMOVED: `Drop-Oldest Backpressure` (Reason present in delta; viewer cap survives inside Video Stream Endpoint). Purpose and Non-Goals refreshed — they still described the removed scrcpy/H.264 path and would have contradicted the merged RTC requirements. |
| emulator-rtc-streaming | Created | Full-spec mechanical copy (no prior main spec existed); `diff -r` readback empty. 8 requirements / 17 scenarios. |
| input-channel | Updated | 1 requirement ADDED: `Control Without Stream` (2 scenarios); 2 requirements replaced: `Control Socket Input` → renamed **gRPC Input Injection** per the delta's `(Previously: …)` line, and `Input Mode Selection` (capability-driven, not stream-state-driven). Purpose and Non-Goals parenthetical refreshed (control-socket references removed). Frozen requirements preserved untouched: Tap, Swipe, Text Input, Key Press, Focus-State Rules, Text Injection Consistency. |
| local-bridge | Updated | 2 requirements ADDED: `RTC Stream State` (3 scenarios, see WARNING-1 touch-up below) and `Emulator Launch Configuration` (2 scenarios), inserted after Stream Configuration; 1 requirement replaced: `Streaming WebSocket Endpoints` (JSON JSEP signaling, never binary video). Non-Goals "No WebRTC … (deferred production path)" refreshed — WebRTC is now the shipped path. All other requirements preserved untouched. |

### Archive-time touch-ups (documented, all editorial or verify-recommended)

1. **WARNING-1 reconciliation (verify-recommended)**: the local-bridge delta enumerated `rtc.reason` values as `grpc_permission_denied` / `emulator_version` / `grpc_unavailable`, but the shipped implementation returns `no_device_selected` at `src/stream/gateway.ts:281` for an unresolved `auto` serial, pinned by a passing test. Per verify's recommendation, the merged main spec enumeration now includes `no_device_selected`, with a new scenario `Unresolved auto serial` documenting the behavior. No code change.
2. **Rename handling**: the device-streaming delta's `Video Stream Endpoint` and the input-channel delta's `gRPC Input Injection` were declared MODIFIED with `(Previously: …)` notes rather than RENAMED blocks; merged as rename+replace since the old names (`H.264 Stream Endpoint`, `Control Socket Input`) no longer describe shipped behavior.
3. **Purpose/Non-Goals editorial sync**: device-streaming, input-channel, and local-bridge had Purpose/Non-Goals prose still describing the removed scrcpy/H.264 world (including "No WebRTC" non-goals). The delta note declares the WS video contract superseded; these prose sections were refreshed minimally so the main specs are internally consistent. No normative requirement text outside the deltas was altered.
4. **Device-streaming Control Channel**: the delta's "see input-channel delta" reference was normalized to "see input-channel spec" since deltas cease to exist as deltas at archive.

## Verification Evidence (Mechanical Copy Contract)

- **emulator-rtc-streaming full-spec copy**: `diff -r openspec/changes/emulator-native-stream/specs/emulator-rtc-streaming/spec.md <temp>` → empty (PASS).
- **Archive move** (git mv path with pre-move snapshot fallback guard): `diff -r <snapshot>/source openspec/changes/archive/2026-09-06-emulator-native-stream` → empty (PASS).
- Merge edits into existing main specs are model-authored by definition (delta application), verified by re-reading each merged spec against the delta content.

## Sources Read (traceability)

- `openspec/changes/emulator-native-stream/`: proposal.md, design.md, tasks.md (30/30 `[x]` — Task Completion Gate passed), specs/ (4 delta domains), verify-report.md
- Engram verify report: observation **#530** (`sdd/emulator-native-stream/verify-report`, verdict pass_with_warnings, 20/20 requirements, 45/45 scenarios, test_output_hash sha256:d120b880…)

## Carried Open Items (before chain merge to main)

1. **Live RTC conformance never executed here**: the env-gated live test (`OPENMOBILE_RTC_LIVE=1`, `test/stream-rtc-live.test.ts`) is the suite's 1 skip — no emulator in this environment. Wire contract is integration-covered over the real `@grpc/grpc-js` stack with fixture replay; live offer/answer/ICE and the proposal's live success-criteria (glass-to-glass latency, fps) remain open for a live-emulator session.
2. **WS `key{keycode}` Usb code-space assumption**: wire shape pinned by unit tests (`sendKey{keyCode, codeType Usb=0}`, `src/stream/control.ts`); emulator's semantic keycode space unverified live (only GoHome was probe-verified, probe D).
3. **back→GoBack mapping assumption**: pinned by shape tests (`key(GoBack)` sent for `back`, adb untouched); same family as verified GoHome but live semantic verification pending.

None of these breaks a normative spec scenario; all are documented gaps requiring a live emulator session.

## Warnings and Suggestions Carried (from final verify)

- WARNING 1: `no_device_selected` enumeration — **resolved at archive** via spec touch-up (see above).
- WARNING 2: env-gated live RTC conformance — carried (open item 1).
- WARNING 3: keycode code-space + back→GoBack assumptions — carried (open items 2–3).
- SUGGESTION 1: task 3.1 wording says "delete annexb/decoder/support" though that deletion landed in PR1 (task 1.12's zero-reference proof required it) — harmless tasks.md history bookkeeping mismatch, recorded for audit.
- SUGGESTION 2: "Media bypasses the daemon" is proven structurally (all WS frames coerced to text, no binary path, scrcpy-free proof) rather than by a dedicated runtime binary-frame assertion — future hardening note.
- SUGGESTION 3: apply-progress TDD evidence was a merged narrative rather than a literal per-task table — format suggestion for future changes.

## SDD Cycle Complete

Planned → specced → designed → tasked → implemented (30/30) → verified (pass with warnings, all CRITICAL none) → specs synced → archived.
