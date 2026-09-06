# Proposal: Emulator-Native Stream (gRPC control + WebRTC video)

## Intent

Replace in-guest scrcpy streaming (jar push, adb reverse, guest encode ~13fps) with emulator-native host-side APIs: gRPC EmulatorController control (live-verified 12ms) + WebRTC video via daemon-brokered JSEP — the Android Studio architecture (obs #595). Target: <100ms latency, 30-60fps (-rtcfps), all-browser video (VP8 mandatory → WebCodecs gate gone), full scrcpy deletion. ONE video path (scope decisions 1-2); MMAP avoided (obs #596).

## Scope

### In
- gRPC control backend (sendKey/sendTouch/sendText/swipe → TouchEvent/KeyboardEvent unary) replacing scrcpy socket + adb input; WS /v1/stream/control JSON contract UNCHANGED (backend swap); REST /v1/input → gRPC when capable, adb fallback kept.
- RtcSession (new) replacing scrcpy daemon session: RequestRtcStream + JSEP relay (sendJsepMessage/receiveJsepMessages); per-viewer RtcId = fanout at session level; lifecycle = manager skeleton (first-viewer start / last-viewer teardown); watchdog via gRPC getStatus.
- Emulator launch: emulator_start + androidCli.emulatorStart pass `-grpc-allowlist <ours>` + `-rtcfps N`; version gate ≥36.5.11.
- WS video contract: /v1/stream/video → JSON JSEP signaling (offer/answer/ice/state); media browser↔emulator over loopback UDP.
- DELETE: assets/scrcpy-server.jar + README + sha-pin test; src/stream/{scrcpy,wire-scrcpy-codecs,control-encoder}.ts; client/{annexb,decoder}.ts (WebCodecs); daemon.ts adb transport; stream fixtures + record script.
- Deps: @grpc/grpc-js + @grpc/proto-loader; vendored emulator protos (36.5.11 pin).

### Out
- Audio (streamAudio/WebRTC) — explicit deferral.
- MMAP transport (crash-correlated, obs #596).
- Video on externally-launched emulators — documented limitation; control-only still works (default allowlist permits EmulatorController).
- Real devices (no requirement); gRPC-web/Envoy proxy.

## Capabilities

### New
- `emulator-rtc-streaming`: gRPC control, WebRTC video (daemon-brokered JSEP), launch flags, RtcSession lifecycle.

### Modified
- `device-streaming`: Annex-B WS contract → JSEP signaling; emulator-native transport.
- `input-channel`: gRPC injection when available; device-px coordinates (kills video-space mapping).
- `local-bridge`: launch flags; additive /v1/state stream fields.

`screen-capture` unchanged (frozen).

## Approach

Browser RTCPeerConnection ↔ emulator RtcService (loopback UDP); daemon relays JSEP over existing WS; control via gRPC unary. Emulator is initial offerer (receiveJsepMessages stream). Passthrough, NOT daemon re-mux (D1).

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Browser = WebRTC peer; daemon brokers JSEP only | No maintained server-side WebRTC for Bun/Node (re-mux infeasible); deletes WebCodecs client (VP8 universal); Android Studio precedent |
| D2 | Target RtcService v1 behind adapter | Stable shape (container-scripts precedent); v2 drift contained; conformance test pins |
| D3 | Control via gRPC unary, not WebRTC data channel | Verified 12ms; data channel = extra JSEP complexity, unverified |
| D4 | Token + custom allowlist (RtcService+reflection); `-grpc` opt-in | Keeps token flow (running pid ini); loopback trust boundary |
| D5 | Coordinates = device physical px | Verified TouchEvent space; removes video→device mapping |
| D6 | Lifecycle keeps manager skeleton; getStatus watchdog | Reuses verified start/teardown + loss semantics |

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| src/stream/scrcpy.ts, wire.ts codecs, control.ts | Removed | scrcpy adapter/bytes/encoder |
| src/stream/daemon.ts | Removed | adb transport; replaced by RtcSession (new) |
| src/stream/client/annexb.ts, decoder.ts | Removed | WebCodecs path |
| src/stream/client/index.ts | Rewrite | RTCPeerConnection + WS signaling |
| src/stream/{types,manager,gateway,fanout}.ts | Modified | JSEP messages, per-viewer RtcId, lifecycle retarget |
| src/bridge/{server,main}.ts | Modified | WS shapes, gateway wiring |
| src/device/androidCli.ts, src/tools/{handlers,schemas}.ts | Modified | launch flags + token read |
| assets/*, test/fixtures/stream-*, scripts/record-stream-fixture.ts | Removed | jar, pin, fixtures |
| protos/ (vendored) | New | emulator/lib/*.proto + pin README |
| package.json | Modified | grpc deps |

Frozen: REST /v1/state additive shape, /v1/screenshot, viewer registry/caps/close codes, /v1/stream/control JSON, screen-capture.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| RtcService v1↔v2 drift | High | D2 adapter; conformance tests; version gate |
| Allowlist/token flow breaks | Med | D4; `-grpc` fallback; live-verified token path |
| Older emulators lack flags/RtcService | Med | Version gate + actionable error; upgrade to 36.6.11 |
| ICE on loopback fails | Low | Host candidates; no TURN; design probe |
| Multi-viewer per-guid cap | Med | Probe max concurrent RtcStreams in design; cap ≤ probe |

## Rollback Plan

Chained PRs/slices: mid-chain → drop remaining slices; full → revert merged PRs (scrcpy intact in git history). Graceful degradation: adb input + polling screenshots remain without gRPC/WebRTC (frozen specs).

## Dependencies

@grpc/grpc-js + @grpc/proto-loader; emulator ≥36.5.11 (`-grpc-allowlist`, `-rtcfps`); vendored protos; Bun.

## Success Criteria

- [ ] Glass-to-glass <100ms; 30-60fps via -rtcfps (measured, swiping)
- [ ] Control RTT <20ms (currently 12ms)
- [ ] `bun test` + typecheck green; v1 offer/answer/ICE round-trip conformance test live
- [ ] scrcpy fully deleted (src/assets/tests/scripts); no references remain
- [ ] emulator_start launches with allowlist flags; additive /v1/state fields reported