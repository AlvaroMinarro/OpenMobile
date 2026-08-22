# Proposal: Device Streaming

## Intent

The OpenChamber V2 surface polls `/v1/screenshot` at ~1fps (45KB JPEG, CLI capture per frame, adb input only, flaky gating) — not usable for live interaction. Replace the polling path with real streaming: a daemon in this repo runs scrcpy-server (`raw_stream`) on the device, ships raw H.264 over WebSocket, and injects input through the scrcpy **control socket** (fast taps/swipes/text). The OpenChamber surface update is a separate fork PR after this lands.

## Scope

### In Scope
- `src/stream/` daemon: push version-pinned scrcpy-server.jar (committed asset, Apache-2.0) + spawn via `app_process` with `--raw_stream --video_codec=h264`; raw H.264 tunnel + control socket
- WS on existing bridge port: `/v1/stream/video` (binary H.264) + `/v1/stream/control` (JSON events)
- Input via control socket while streaming; `POST /v1/input/*` (adb) unchanged for polling mode
- Additive `/v1/state` fields: `stream {supported, active, reason, viewers}`
- Browser helper `src/stream/client/` (export `./stream-client`): WS client, Annex-B AU parser, WebCodecs VideoDecoder, canvas renderer
- Fallback rules: stream unsupported/missing → existing `/v1/screenshot` polling untouched

### Out of Scope
- OpenChamber surface update (separate fork PR)
- WebRTC, audio, per-viewer bitrate negotiation, emulator gRPC RTC path
- scrcpy client CLI integration, keyframe-request protocol

## Capabilities

### New Capabilities
- `device-streaming`: scrcpy raw-stream daemon, WS video+control protocol, WebCodecs browser client, fallback contract

### Modified Capabilities
- `local-bridge`: non-goal "no WebSocket/streaming endpoints" removed; `/v1/state` gains additive stream fields; all other `/v1` routes frozen

## Approach

One daemon on 8765: Bun.serve upgrades WS; scrcpy adapter pushes the pinned jar and spawns the server; daemon reads the video tunnel and broadcasts binary H.264 to N viewers (drop-oldest on slow clients); control socket encodes tap/swipe/text from WS JSON. Exact raw_stream wiring (adb forward/reverse, flags) is validated LIVE during design against the pinned server — fixture-first, like fix-cli-real-output. Browser: init message (codec/lengthSize/SPS/PPS) → Annex-B parser → `EncodedVideoChunk` → `VideoDecoder` → canvas. Input coordinates in video space (scrcpy maps to device, handles rotation). Activation default ON; `OPENMOBILE_STREAM=off` kill-switch.

Key decisions:
- scrcpy-server raw_stream, not forked ws-scrcpy → no fork maintenance (#555)
- Raw H.264 over WS, not WebRTC → loopback, no ICE/SDP; WebRTC deferred
- Bundled jar → no system scrcpy dependency; adb suffices

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/stream/{scrcpy,control,daemon}.ts` | New | spawn/tunnel, control codec, WS fan-out |
| `src/stream/client/*.ts` | New | WS proto + WebCodecs + renderer |
| `src/bridge/{server,main}.ts` | Modified | `/v1/stream/*` + state fields (additive) |
| `assets/scrcpy-server.jar` | New | pinned binary + license note |
| `test/stream*.test.ts` | New | parser/control/fan-out, synthetic frames |
| `package.json` | Modified | export `./stream-client` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| raw_stream is version-locked internal protocol | Med | pin jar, live-validate in design, re-record procedure |
| WebCodecs h264 absent (Firefox) | Med | `stream.supported` check → polling fallback; Chrome/Edge/Safari primary |
| Join mid-GOP waits for keyframe | Med | "buffering" client state; encoder keyframe interval thin if available |
| Backpressure, slow viewers | Med | drop-oldest fan-out; viewer cap |
| Control coords vs rotation | Low | scrcpy maps internally; live check |

## Rollback Plan

Revert commits: WS routes inert to existing clients; state fields additive; stream off via env. No migration.

## Dependencies

- scrcpy-server.jar pinned release (committed, no runtime network) · adb reverse · device API ≥21 (Pixel_9_Pro API 36 OK) · Chrome/Edge/Safari decode

## Success Criteria

- [ ] Glass-to-glass p95 <200ms on Pixel_9_Pro (WS arrival + paint tracking)
- [ ] Tap→inject p95 ≤150ms via control socket
- [ ] `bun test` green incl. existing bridge tests untouched (no `/v1` regression); typecheck clean
- [ ] Fallback proven: stream off/missing → polling path works
- [ ] Demo page (not surface PR) decodes + renders in Chrome