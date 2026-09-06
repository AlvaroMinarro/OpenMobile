# Tasks: Emulator-Native Stream (gRPC control + WebRTC video)

## Review Workload Forecast

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

~4,200 changed lines (PR1 ~1,900, PR2 ~1,400, PR3 ~900); deletions dominate; vendor protos exempt.

### Work Units

| Unit | Goal | PR | Notes |
|------|------|----|-------|
| 1 | Native gRPC control + launch flags + full scrcpy removal | PR 1 | base=feature branch; video WS 4403 till PR2; control+polling kept |
| 2 | RtcSession (RtcService v1) + JSEP signaling WS + rtc state | PR 2 | base=PR1 branch; restores video WS as JSON signaling |
| 3 | Browser RTCPeerConnection rewrite; delete WebCodecs | PR 3 | base=PR2; example+exports+docs |

## Phase 1: PR1, Native control, scrcpy removed

- [x] 1.1 Vendor `emulator_controller.proto`, `rtc_service{,_v2}.proto`, `ice_config.proto` → `protos/` + README pin (from /tmp/opencode/protos)
- [x] 1.2 `package.json`: add `@grpc/grpc-js` + `@grpc/proto-loader`
- [x] 1.3 `src/device/grpc.ts` RED→GREEN: token from pid ini, version gate ≥36.5.11, bounds, sendTouch/sendKey unary, ControlError incl. 4401 (probe-d)
- [x] 1.4 `src/stream/rtc/allowlist.ts`: android-studio issuer + Rtc/reflection entries, golden vs om_allowlist.json
- [ ] 1.5 `src/device/androidCli.ts`: `emulatorStart` direct spawn `emulator @avd -grpc-allowlist <gen>`; `-rtcfps` ≥36.6; tests
- [ ] 1.6 `src/tools/{handlers,schemas}.ts`: tap/swipe/text/key gRPC-first, adb fallback, physical-px bounds validation
- [ ] 1.7 `src/stream/control.ts`: delete scrcpy encoder; gRPC injector; keep parseControlJson/ControlError/ack
- [ ] 1.8 `src/stream/{manager,gateway}.ts`: sever StreamSession/encoder deps; subscribeVideo→UNSUPPORTED; manager skeleton kept
- [ ] 1.9 `src/bridge/server.ts`: `/v1/input/*` → gRPC injector (adb fallback); `/v1/state` supported:false + reason
- [ ] 1.10 DELETE `stream/{scrcpy,daemon,wire}.ts`, scrcpy/Annex-B consts, jar + assets README, record-stream-fixture, stream-* fixtures; add 4401
- [ ] 1.11 DELETE/rework stream-{scrcpy,wire,daemon,bridge,gateway,manager,client} tests, jar pin, fixture loads
- [ ] 1.12 Proof test: zero scrcpy/jar/Annex-B/WebCodecs refs in src+test
- [ ] 1.13 `bun test` + typecheck green; work-unit commits

## Phase 2: PR2, RtcSession + signaling + fanout

- [ ] 2.1 `src/stream/rtc/adapter.ts`: RtcService v1 conformance, start/sendJsep/receive/stop; serialized sends
- [ ] 2.2 `src/stream/rtc/session.ts`: per-viewer RtcId; first-viewer start, last-viewer bye:true; answer-before-candidates flush (probe-b2)
- [ ] 2.3 getStatus watchdog; loss→4409+active:false; 4401/4404/4429 JSON bodies; cap=8
- [ ] 2.4 `src/stream/types.ts`: JSEP types (handshake/offer/answer/ice/state); viewer contract
- [ ] 2.5 `src/stream/{manager,gateway,fanout}.ts`: retarget lifecycle to RtcSession; controlActive→gRPC injector
- [ ] 2.6 `src/device/grpc.ts`: Rtc stub, requestRtcStream, receiveJsepMessages (server-stream), sendJsepMessage; 64MB receive limit
- [ ] 2.7 `src/bridge/server.ts`: video WS→JSON signaling (handshake first; malformed→error+close); additive `stream.rtc{supported,active,viewers,guid?,fps?,reason?}`
- [ ] 2.8 `src/bridge/main.ts`: wire grpc client + RtcSession factory into gateway deps
- [ ] 2.9 Integration: in-process fake grpc server replaying jsep fixtures (probe-b2): round-trips, flush, cap, teardown, state
- [ ] 2.10 Live conformance (env-gated): v1 offer/answer/ICE round-trip
- [ ] 2.11 `bun test` + typecheck green; work-unit commits

## Phase 3: PR3, Browser RTC rewrite

- [ ] 3.1 `src/stream/client/index.ts`: RTCPeerConnection + signal WS; VP8 mandatory; delete annexb/decoder/support
- [ ] 3.2 `package.json`: exports/scripts cleanup (drop record-stream-fixture, rewire build:stream-demo)
- [ ] 3.3 `examples/stream.html` + bundle: demo page
- [ ] 3.4 Docs: replace scrcpy/H.264/WebCodecs refs with native RTC
- [ ] 3.5 Client tests: signaling vs fake WS server; proof: no annexb/WebCodecs refs
- [ ] 3.6 `bun build` demo + typecheck green; work-unit commits