```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:7218ca38b07b32042e0fe9976faf3a8a5de3a6a46b362f9a24edef4400cf722f
verdict: pass_with_warnings
blockers: 0
critical_findings: 0
requirements: 20/20
scenarios: 45/45
test_command: bun test
test_exit_code: 0
test_output_hash: sha256:d120b8807f97c80b48c9416c6c64eb647e26907801b6822707f3d22c401a386c
build_command: bun run build:stream-demo
build_exit_code: 0
build_output_hash: sha256:37b4beeca099625ca969215c7842926a74e5ac3539a0ca7bb1e5af8b0835961d
```

## Verification Report

**Change**: emulator-native-stream
**Version**: delta specs at HEAD a27ad58 (branch feature/emulator-native-stream)
**Mode**: Strict TDD

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total | 30 |
| Tasks complete | 30 |
| Tasks incomplete | 0 |

### Build & Tests Execution (fresh, this session)
**Build**: ✅ Passed — `bun run build:stream-demo` exit 0, `stream-client.js 7.70 KB (browser target)`
```text
bun build src/stream/client/index.ts --outfile examples/stream-client.js --target browser
stream-client.js  7.70 KB
```
**Typecheck**: ✅ Passed — `bun run typecheck` (tsc --noEmit) exit 0
```text
$ tsc --noEmit
```
**Tests**: ✅ 549 passed / 0 failed / 1 skipped (env-gated live RTC test, `OPENMOBILE_RTC_LIVE=1`)
```text
bun test v1.4.2
 549 pass
 1 skip
 0 fail
 1753 expect() calls
Ran 550 tests across 38 files. [9.00s]
```
**Coverage**: ➖ Not available — no coverage tool configured; informational, not blocking.

### Spec Compliance Matrix

Legend: DS=device-streaming, ERS=emulator-rtc-streaming, IC=input-channel, LB=local-bridge. Requirement census: DS 6 req / 12 scen (5 active + 1 REMOVED with no scenarios), ERS 8/17, IC 3/10, LB 3/6 → **20 requirements / 45 scenarios**. REMOVED requirements carry no scenarios; their compliance is proven by deletion evidence (the capability is verifiably gone and its surviving piece is covered elsewhere).

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| DS: Stream Support Detection | Unsupported environment | `test/stream-gateway.test.ts` > supported:false + grpc_permission_denied / version-gate reason / no_device_selected; `test/bridge-main.test.ts` > grpc_permission_denied when no pid ini | ✅ COMPLIANT |
| DS: Stream Support Detection | Active stream reports | `test/stream-gateway.test.ts` > reports the active guid + viewers while a stream runs | ✅ COMPLIANT |
| DS: Stream Support Detection | Degraded state reporting | `test/stream-rtc-integration.test.ts` > viewers closed + active:false + reason device_lost (never a 500) | ✅ COMPLIANT |
| DS: Video Stream Endpoint | Stream connects | `test/stream-rtc-integration.test.ts` > handshake first, then fixture offer, verbatim answer + candidates | ✅ COMPLIANT |
| DS: Video Stream Endpoint | Device unusable | `test/stream-bridge.test.ts` > 4403 unsupported + JSON body; 4404 NO_DEVICE | ✅ COMPLIANT |
| DS: Video Stream Endpoint | Viewer cap reached | `test/stream-bridge.test.ts` > 9th viewer 4429; `test/stream-rtc-integration.test.ts` > 9th rejected, 8 keep relaying | ✅ COMPLIANT |
| DS: Control Channel | Tap during stream | `test/stream-bridge.test.ts` > acks a tap during an active stream via the injector | ✅ COMPLIANT |
| DS: Control Channel | Control without stream | `test/stream-bridge.test.ts` > rejects control without an active stream | ✅ COMPLIANT |
| DS: Control Channel | Unknown inject type | `test/stream-bridge.test.ts` > JSON error, connection stays open; `test/stream-control.test.ts` > rejects unknown types | ✅ COMPLIANT |
| DS: Fallback Contract | Unsupported environments still work | `test/stream-bridge.test.ts` > adb taps with no stream; screenshots regardless of stream state | ✅ COMPLIANT |
| DS: Stream Lifecycle | Emulator lost mid-stream | `test/stream-gateway.test.ts` > probe failure closes every viewer + device_lost state | ✅ COMPLIANT |
| DS: Stream Lifecycle | Restart after disconnect | `test/stream-manager.test.ts` > restarts a fresh session after device-loss teardown on re-subscribe | ✅ COMPLIANT |
| DS: Drop-Oldest Backpressure (REMOVED) | (no scenarios — removal proof) | `test/scrcpy-free.test.ts` > zero legacy refs in src/ + test/ (annex-b framing, wire parsers, scrcpy transport, jar) and deleted files absent from disk (`src/stream/wire.ts`, `src/stream/daemon.ts`, `src/stream/scrcpy.ts` — where the host frame queue lived); `test/stream-fanout.test.ts` > retargeted registry keeps NO frame queues (advisory direct send, cap + reaping + teardown only); structural proof: `src/stream/fanout.ts` has no queues, `src/bridge/server.ts` coerces every WS frame to text. Survivor (viewer cap) covered under DS Video Stream Endpoint | ✅ COMPLIANT (removal evidence) |
| ERS: Signaling Channel | Signaling connects | `test/stream-client-rtc.test.ts` > answers the offer in JSEP order after the VP8 handshake | ✅ COMPLIANT |
| ERS: Signaling Channel | Malformed signaling | `test/stream-rtc.test.ts` > BAD_MESSAGE/unknown-type/missing-field rejections; `test/stream-rtc-signaling.test.ts` > non-JSON → error + close 4400 | ✅ COMPLIANT |
| ERS: Signaling Channel | Handshake first | `test/stream-rtc-signaling.test.ts` > handshake is FIRST frame; `test/stream-client-rtc.test.ts` > rejects offer before handshake | ✅ COMPLIANT |
| ERS: Opaque JSEP Relay | Offer/answer round-trip verbatim | `test/stream-rtc-session.test.ts` > relays answer/ice as verbatim gRPC dictionaries; integration > verbatim answer | ✅ COMPLIANT |
| ERS: Opaque JSEP Relay | Media bypasses the daemon | Structural proof: `src/bridge/server.ts` coerces every WS frame to text (no binary media path); `test/scrcpy-free.test.ts` > no legacy transport/decoder refs | ✅ COMPLIANT (structural evidence) |
| ERS: RtcStream Lifecycle | First viewer starts the stream | `test/stream-rtc-session.test.ts` > first viewer attach: requestRtcStream → handshake FIRST | ✅ COMPLIANT |
| ERS: RtcStream Lifecycle | Last viewer tears down | `test/stream-rtc-session.test.ts` > last viewer detach: bye for every stream; `test/stream-rtc-integration.test.ts` > unsubscribe sends bye per guid + cancels receive | ✅ COMPLIANT |
| ERS: RtcStream Lifecycle | Emulator dies mid-stream | `test/stream-rtc-signaling.test.ts` > viewer closed with 4409 on bye; `test/stream-gateway.test.ts` > probe failure → device_lost | ✅ COMPLIANT |
| ERS: Launch Flags and Token | Flagged launch | `test/androidCli.test.ts` > direct spawn with -grpc-allowlist; -rtcfps 30 default / 60 explicit; allowlist permits RtcService + reflection | ✅ COMPLIANT |
| ERS: Launch Flags and Token | Version gate | `test/androidCli.test.ts` > actionable version-gate error below 36.5.11; `test/stream-rtc-capability.test.ts` > gates 36.5.11/36.5.10 | ✅ COMPLIANT |
| ERS: Fallback and Degradation | Externally launched emulator | `test/stream-rtc-capability.test.ts` > external launch → grpc_permission_denied; `test/stream-rtc-signaling.test.ts` > close 4403 + permission reason | ✅ COMPLIANT |
| ERS: Codec and FPS Negotiation | Default VP8 | `test/stream-rtc-signaling.test.ts` > handshake carries VP8; `test/stream-client-rtc.test.ts` > refuses a handshake without VP8 (VP8 mandatory) | ✅ COMPLIANT |
| ERS: Codec and FPS Negotiation | FPS reported | `test/stream-rtc-signaling.test.ts` > fps 60 in handshake; `test/bridge-main.test.ts` > honors OPENMOBILE_RTC_FPS=60, default 30 | ✅ COMPLIANT |
| ERS: Error States | Permission denied | `test/stream-rtc-signaling.test.ts` > 4401 naming PERMISSION_DENIED; `test/device-grpc-rtc.test.ts` > PERMISSION_DENIED mapped | ✅ COMPLIANT |
| ERS: Error States | Stream cap reached | `test/stream-rtc.test.ts` > close-code table pinned (4429 VIEWER_CAP, cap=8); `test/stream-gateway.test.ts` > 9th viewer CAP_REACHED, 8 keep running | ✅ COMPLIANT |
| ERS: gRPC Control Surface | Tap via unary | `test/stream-control.test.ts` > tap via sendTouch physical px; `test/tools-grpc-input.test.ts` > gRPC unary, adb never touched | ✅ COMPLIANT |
| ERS: gRPC Control Surface | Control while video is off | `test/tools-grpc-input.test.ts` > gRPC tap with no stream; `test/stream-rtc-session.test.ts` > watchdog armed only on first attach | ✅ COMPLIANT |
| IC: Control Without Stream | Input with video off | `test/tools-grpc-input.test.ts` > routes tap through gRPC with no stream active | ✅ COMPLIANT |
| IC: Control Without Stream | Input before first viewer | `test/stream-rtc-session.test.ts` > does NOT probe while no viewer attached; manager > no session before first subscribe | ✅ COMPLIANT |
| IC: gRPC Input Injection | Tap through gRPC | `test/tools-grpc-input.test.ts` > gRPC unary tap | ✅ COMPLIANT |
| IC: gRPC Input Injection | Physical-pixel semantics | `test/stream-control.test.ts` > sendTouch physical px (no video-space mapping); `test/tools-grpc-input.test.ts` > schemas document physical px | ✅ COMPLIANT |
| IC: gRPC Input Injection | Swipe through gRPC | `test/tools-grpc-input.test.ts` > swipe via gRPC, duration preserved; `test/stream-control.test.ts` > swipe duration preserved | ✅ COMPLIANT |
| IC: gRPC Input Injection | Out-of-range coordinates | `test/tools-grpc-input.test.ts` > error states the valid physical range; `test/stream-bridge.test.ts` > out-of-range tap JSON error | ✅ COMPLIANT |
| IC: gRPC Input Injection | Injection failure | `test/tools-grpc-input.test.ts` > actionable gRPC error, no silent adb fallback; `test/stream-control.test.ts` > injector failure → ControlError | ✅ COMPLIANT |
| IC: Input Mode Selection | gRPC capable picks gRPC | `test/tools-grpc-input.test.ts` > tap/swipe/text via gRPC regardless of stream state | ✅ COMPLIANT |
| IC: Input Mode Selection | No gRPC falls back to adb | `test/tools-grpc-input.test.ts` > adb fallback for tap/swipe/text/key without gRPC surface | ✅ COMPLIANT |
| IC: Input Mode Selection | Offline device in either mode | `test/bridge.test.ts` > 409 DEVICE_OFFLINE naming serial/state for offline auto-detected device | ✅ COMPLIANT |
| LB: RTC Stream State | RTC fields on state | `test/stream-rtc-signaling.test.ts` > supported/active/viewers/guid/fps while attached; `test/stream-gateway.test.ts` > rtc sub-object | ✅ COMPLIANT |
| LB: RTC Stream State | Externally launched emulator | `test/stream-gateway.test.ts` > rtc.supported:false + grpc_permission_denied, no second path | ✅ COMPLIANT |
| LB: Emulator Launch Configuration | Flags passed at launch | `test/androidCli.test.ts` > spawn args carry both flags; `test/stream-gateway.test.ts` > supported + endpoint once capability resolves | ✅ COMPLIANT |
| LB: Emulator Launch Configuration | Token read | `test/device-grpc-rtc.test.ts` > Bearer token attached to requestRtcStream/sendJsep; `test/bridge-main.test.ts` > resolves pid-ini capability | ✅ COMPLIANT |
| LB: Streaming WebSocket Endpoints | Signaling upgrade | `test/stream-rtc-integration.test.ts` > JSON signaling only over real gRPC stack + WS | ✅ COMPLIANT |
| LB: Streaming WebSocket Endpoints | Control while streaming | `test/stream-control.test.ts` > documented inject shapes (tap/swipe/text/key) parse and ack; contract frozen (parseControlJson kept) | ✅ COMPLIANT |

**Compliance summary**: 20/20 requirements (19 active + 1 REMOVED proven by deletion evidence) — 45/45 scenarios compliant, 0 UNTESTED, 0 FAILING, 0 PARTIAL (3 rows carry structural/removal-evidence notes: Media bypasses the daemon; Drop-Oldest Backpressure REMOVED; Default VP8 browser-side negotiation is wire-contract-covered, full media negotiation is live-only by design).

### Correctness (Static Evidence)
| Requirement | Status | Notes |
|------------|--------|-------|
| JSEP signaling contract shapes | ✅ Implemented | `src/stream/types.ts` pins server→client (handshake/offer/answer/ice/state) and client→server (answer/ice/state) subsets; `test/stream-rtc.test.ts` asserts shapes verbatim |
| Close codes 4400/4401/4403/4404/4409/4429 | ✅ Implemented | `test/stream-rtc.test.ts` pins WS_CLOSE_CODES table; per-code behavior in signaling/bridge tests |
| Cap = 8 (MAX_VIEWERS) | ✅ Implemented | `test/stream-rtc.test.ts` asserts MAX_VIEWERS===8; gateway/fanout/integration reject the 9th viewer |
| JSEP verbatim relay, no re-mux | ✅ Implemented | `src/stream/rtc/session.ts` relays string payloads untouched; adapter decodes without rewriting |
| Watchdog via getStatus | ✅ Implemented | `test/stream-rtc-session.test.ts` > loss fires on probe failure, disarms after last viewer, healthy probes keep session |
| 64MB gRPC receive limit | ✅ Implemented | `test/device-grpc-rtc.test.ts` > >4MB message intact |
| Host frame queue (Drop-Oldest Backpressure) removed | ✅ Removed | `src/stream/fanout.ts` registry has NO frame queues (advisory direct send, never backpressured); legacy frame world (wire.ts/daemon.ts/scrcpy.ts) deleted and proven absent by `test/scrcpy-free.test.ts` |
| scrcpy/jar/Annex-B/WebCodecs deleted | ✅ Implemented | `test/scrcpy-free.test.ts` > zero refs in src/+test/, deleted files absent from disk; src/ and assets/ greps confirm zero matches |

### Coherence (Design)
| Decision | Followed? | Notes |
|----------|-----------|-------|
| D1 Browser = WebRTC peer; daemon brokers JSEP only | ✅ Yes | Client is RTCPeerConnection (`src/stream/client/index.ts`); daemon relays JSON JSEP, zero media path (server.ts coerces all WS frames to text) |
| D2 RtcService v1 behind adapter | ✅ Yes | `RtcAdapter` interface + `GrpcRtcAdapter` (`src/stream/rtc/adapter.ts`); v2 drift contained in one file + conformance tests |
| D3 Control via gRPC unary, not data channel | ✅ Yes | sendTouch/sendKey (KeyboardEvent{text} for text, probe D); no data-channel code exists |
| D4 Token + custom allowlist; direct spawn | ✅ Yes | pid-ini `grpc.token` → Bearer (device-grpc-rtc tests); `androidCli.emulatorStart` direct spawn with generated allowlist incl. android-studio issuer |
| D5 Coordinates = device physical px | ✅ Yes | sendTouch in device px; range validation; schemas document physical px; no video-space mapping code survives |
| D6 Manager skeleton + getStatus watchdog | ✅ Yes | Manager starts/stops on first/last viewer, poll-based device-loss; watchdog arms on first attach only |
| JSEP ordering: answer before candidates (probe-b2) | ✅ Yes | `session.ts` buffers pending candidates until the answer is sent, then flushes; adapter serializes sends via a chained promise; proven end-to-end over the real gRPC stack (`stream-rtc-integration.test.ts` > probe-b2 flush) |
| Per-viewer RtcId + bye teardown | ✅ Yes | `attach()` issues one `adapter.start()` per viewer; `detach()` sends bye + cancels only that guid's receive stream; last viewer tears the session down |

### Deviations Assessment
| Deviation | Verdict | Rationale |
|-----------|---------|-----------|
| Client {annexb,decoder} deletion pulled forward PR1→ (originally PR3) | SUGGESTION | Spec-consistent: task 1.12's zero-reference proof would be contradictory if WebCodecs files survived until PR3; final state matches all specs (scrcpy-free proof). Bookkeeping note: task 3.1 still says "delete annexb/decoder/support" — the delete happened in PR1 (obs #516), PR3 rebuilt `index.ts` cleanly. |
| Socket ownership split (RtcSession closes a socket only when ITS stream ends; gateway owns 4409 closeAll) | SUGGESTION (accepted) | Spec-consistent: both halves tested — emulator bye ends one viewer (`stream-rtc-session.test.ts` > "emulator bye ends that viewer's stream"), full loss closes all with 4409 via gateway (`stream-gateway.test.ts` > probe failure). Matches ERS lifecycle semantics. |
| `no_device_selected` rtc.reason for unresolved auto serial | WARNING | Literal deviation from the LB delta enumeration (`grpc_permission_denied` / `emulator_version` / `grpc_unavailable`) at `specs/local-bridge/spec.md` line 13: `gateway.ts:281` returns `no_device_selected` when serial is `auto` and unresolved, with a passing test pinning it. More actionable and true to the DS "reason MUST explain" intent, but the enumerated value set in the delta spec does not include it — recommend a delta-spec touch-up at archive (add `no_device_selected`) or map to `grpc_unavailable`. |

### Carried Open Questions (honest gaps, documented — not blocking)
| Item | Mitigation status |
|------|-------------------|
| WS `key{keycode}` code-space assumption (relayed as `sendKey{keyCode, codeType Usb=0}`, `src/stream/control.ts:151-153`) | Unit tests pin the wire shape (`stream-control.test.ts` > key keycode via sendKey) but the emulator's semantic keycode space is unverified live. Documented in apply-progress; needs a live-emulator session. Design D3/probe D context supports USB space; no spec scenario normatively pins the code space (Input Channel spec scenarios cover tap/swipe/text + mapping, all covered). |
| back→GoBack mapping assumption | `tools-grpc-input.test.ts` pins `key(GoBack)` is sent for `back` and adb is untouched; only GoHome was probe-verified live (probe D). Same call-shape, same family as the verified GoHome; documented. No spec scenario requires live proof. |
| Env-gated live conformance (task 2.10) skipped | `test/stream-rtc-live.test.ts` is the 1 skip: `OPENMOBILE_RTC_LIVE=1` + reachable pid ini required — no emulator in this environment. Mitigated by: probe-b2 was executed live pre-apply (36.5.11), and `stream-rtc-integration.test.ts` replays the real `@grpc/grpc-js` stack over jsep fixtures. The proposal's live success-criteria item (glass-to-glass latency, fps) remains open for a live session — documented, not a delta-spec scenario. |

### TDD Compliance
| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | Merged apply-progress (Engram obs #514) + per-phase session summaries (#516/#522/#529) carry per-work-unit RED→GREEN evidence and order-pinning RED notes |
| All tasks have tests | ✅ | 30/30 tasks cite test files; every cited file exists and passes |
| RED confirmed (tests exist) | ✅ | 38 test files verified on disk; 550 tests execute |
| GREEN confirmed (tests pass) | ✅ | 549 pass / 0 fail fresh run (this session, exit 0) |
| Triangulation adequate | ✅ | Multi-scenario behaviors have multiple cases (e.g., probe-b2 flush at session, signaling, integration, and client layers) |
| Safety Net for modified files | ✅ | Full-suite runs at every work-unit boundary (532→549 pass progression documented) |

**TDD Compliance**: 6/6 checks passed

### Test Layer Distribution
| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | ~370 | 24 | bun test (in-memory doubles, fake adapters) |
| Integration | ~178 | 13 | bun test + in-process Bun.serve WS daemon + in-process @grpc/grpc-js fake server |
| E2E (live) | 1 (skipped) | 1 | bun test, env-gated (OPENMOBILE_RTC_LIVE=1); browser media via manual demo page |
| **Total** | 549 pass + 1 skip | 38 | |

### Changed File Coverage
Coverage analysis skipped — no coverage tool configured (informational, not blocking).

### Assertion Quality
**Assertion quality**: ✅ All assertions verify real behavior — audited across the change-critical files (`stream-rtc*.test.ts`, `stream-client-rtc.test.ts`, `stream-control.test.ts`, `tools-grpc-input.test.ts`, `stream-{bridge,gateway,manager,fanout}.test.ts`, `scrcpy-free.test.ts`): no tautologies, no ghost loops, no smoke-only tests; assertions pin order, verbatim payloads, close codes, and error semantics. 1753 expect() calls over 550 tests.

### Quality Metrics
**Linter**: ➖ Not configured
**Type Checker**: ✅ No errors (`tsc --noEmit` exit 0)

### Issues Found
**CRITICAL**: None
**WARNING**:
1. `no_device_selected` rtc.reason is outside the local-bridge delta enumeration (gateway.ts:281) — spec-text deviation, behavior is sound and tested; fix via archive-time delta touch-up or remap.
2. Env-gated live RTC conformance (task 2.10) has never been executed fresh in this environment (no emulator); wire contract is integration-covered over the real gRPC stack, live offer/answer/ICE remains unproven here.
3. WS `key{keycode}` Usb code-space + back→GoBack mapping are assumptions pinned by shape-tests only — live semantic verification pending a real emulator session.

**SUGGESTION**:
1. Task 3.1 wording says "delete annexb/decoder/support" though the deletion landed in PR1 (task 1.12 proof required it) — harmless bookkeeping mismatch in tasks.md history.
2. "Media bypasses the daemon" is proven structurally (no binary path; all WS frames coerced to text; scrcpy-free proof) rather than by a dedicated runtime binary-frame assertion — acceptable given the architecture, note for future hardening.
3. apply-progress TDD evidence is a merged narrative rather than a literal per-task table — content was verifiable per task; format suggestion for future changes.

### Verdict
**PASS WITH WARNINGS** — All 30 tasks complete, 20/20 requirements (including the REMOVED Drop-Oldest Backpressure, proven by deletion evidence) and 45/45 delta-spec scenarios covered by passing tests on a fresh run (549 pass / 0 fail / 1 documented env-gated skip), typecheck and build clean, all design decisions D1-D7 verified in source. The 3 warnings are documented deviations/gaps with mitigations; none breaks a normative spec scenario.
