# Design: Emulator-Native Stream (gRPC control + WebRTC video)

## Technical Approach

Browser = WebRTC peer; daemon brokers JSEP over the loopback WS, injects input via gRPC unary — the Android Studio architecture, probe-proven **live on emulator 36.5.11** (pid 2604388, bridge allowlist token). `RtcSession` (new) replaces the scrcpy daemon: `requestRtcStream` per viewer, `receiveJsepMessages` (offer relay), `sendJsepMessage` (answer/ice/bye). Media flows browser↔emulator over loopback UDP; the daemon handles zero media bytes (spec: *Media bypasses the daemon*). ONE video path; audio, MMAP, real devices out.

## Architecture Decisions

### RTC topology — browser peer, daemon passthrough (D1/D2)

| Option | Tradeoff | Decision |
|---|---|---|
| Daemon-side werift re-mux | Server WebRTC in Bun/Node unmaintained; keeps WebCodecs; extra hops | Rejected |
| Browser PC + daemon JSEP relay | Daemon touches no media; AS precedent; probe B: ICE Connected+Completed, 0 idle RTP, burst 41→73 pkts after tap | **Adopted** |

### RtcService v1 behind adapter

| Option | Tradeoff | Decision |
|---|---|---|
| Target v2 only | Drift risk; proposal D2 pins v1 | Rejected |
| v1 primary + adapter | Stable shape (probe B verbatim flow); conformance pin; v2 drift contained | **Adopted** — `RtcAdapter { start(): Promise<guid>, sendJsep(msg), receive(): AsyncIterable<JsepMsg>, stop() }` |

### JSEP ordering — answer first, then candidates

Probe B: emulator drops candidates before the answer ("The remote description was null"). Client MUST buffer local candidates until the answer is sent, then flush (probe-b2 pattern). Adapter MUST serialize `sendJsepMessage` (parallel sends reorder). Answer is video-only (audio/datachannel m-lines port 0) — proven accepted.

### Per-viewer RtcId; cap is ours

Emulator accepted **10 concurrent** `requestRtcStream` (probe C) → no emulator cap. Keep `MAX_VIEWERS=8` (proposal R5): fanout at session level, per-viewer opaque guid; first viewer starts, last viewer sends `{bye:true}` + cancels receive; `getStatus` watchdog.

### Control via gRPC unary (D3) — no sendText RPC

No `sendText` RPC in 36.5.11; text = `sendKey(KeyboardEvent{text})` (probe D). Control: `sendTouch` (tap/swipe) + `sendKey` (key/text), device physical px (D5). Bad input silently accepted (1–6ms, no error) → **validation is client-side** (`getDisplayConfigurations` bounds; actionable errors per input-channel spec).

### Launch — direct spawn, allowlist, version gate (D4/D6)

`android emulator start` forwards no extra flags → direct spawn `<sdk>/emulator/emulator @<avd> -grpc-allowlist <generated-file>` (SDK path via `android info`). Allowlist MUST keep the `android-studio` issuer entry (token is opaque, maps to it — proven by PERMISSION_DENIED grpc error). `-rtcfps` is **unknown on 36.5.11** ("unknown option: -rtcfps"; absent from `-help`) → add ≥36.6 only; gate parses `Android emulator version X.Y.Z.W`. Token per instance: serial → rc dir pid ini (`grpc.token=`), attached as `authorization: Bearer`.

## Data Flow

```
client                daemon (RtcSession)            emulator gRPC
  |-- open ws --------->|                                 |
  |<-- handshake{guid}--|-- requestRtcStream() -------->|
  |                     |<-- guid ----------------------|
  |<-- offer{sdp} ------|<-- receiveJsepMessages stream-|
  |-- answer{sdp} ----->|-- sendJsepMessage ----------->|
  |-- ice{candidate} -->|-- (flushed AFTER answer) ----->|
  |<-- state:streaming--|  (client reports connected)
media: browser RTCPeerConnection <---- UDP loopback ----> emulator
control: WS /v1/stream/control + REST /v1/input/* -> gRPC unary (device px); adb fallback
```

## File Changes

| File | Action | Description |
|---|---|---|
| `src/stream/rtc/{adapter,session,allowlist}.ts` | Create | v1 adapter (serialized sends); per-viewer RtcSession + watchdog; allowlist JSON |
| `src/device/grpc.ts` | Create | Shared client, pid-ini token, version gate, display bounds |
| `protos/`, `protos/README.md` | Create | Vendored emulator protos + 36.5.11 pin |
| `src/stream/{types,gateway,manager,fanout}.ts` | Modify | JSEP types, per-viewer RtcId fanout, lifecycle retarget (manager skeleton kept) |
| `src/stream/control.ts` | Modify | gRPC-backed injector (was scrcpy encoder) |
| `src/bridge/{server,main}.ts` | Modify | WS JSEP shapes, `/v1/state` `rtc` object, wiring |
| `src/device/{androidCli,input}.ts`, `src/tools/{handlers,schemas}.ts` | Modify | Direct spawn + flags; gRPC-first input, adb fallback |
| `src/index.ts`, `package.json` | Modify | Wiring; `@grpc/grpc-js` + `@grpc/proto-loader` |
| `src/stream/{scrcpy,wire}.ts`, `src/stream/client/{annexb,decoder}.ts`, `src/stream/daemon.ts` | Delete | scrcpy transport, Annex-B/WebCodecs client, adb daemon |
| `assets/scrcpy-server.jar`, `assets/README.md`, `scripts/record-stream-fixture.ts` | Delete | Jar + pin docs |
| `test/stream-{scrcpy,wire,daemon,client,control,bridge,gateway,manager,fanout}.test.ts`, `test/fixtures/stream-*` | Delete | Superseded |
| `test/stream-rtc{,-adapter,-session,-signaling,-control}.test.ts`, `test/fixtures/jsep-*` | Create | Unit/integration coverage |

## Interfaces / Contracts

- **WS**: server→client `{"type":"handshake","rtcId","fps","codecs"}`, `{"type":"offer"|"answer","sdp"}`, `{"type":"ice","candidate":RTCIceCandidateInit}`, `{"type":"state","state":"connecting"|"streaming"|"error","reason"?}`; client→server `answer`,`ice`,`state`. Close codes: 4401 PERMISSION_DENIED, 4404 NO_DEVICE, 4409 DEVICE_LOST, 4429 VIEWER_CAP + JSON error body.
- **gRPC JsepMsg** (verbatim relay, probe B): `{"start":{}}`, `{"sdp","type"}`, `{"candidate","sdpMid","sdpMLineIndex"}`, `{"bye":true}`. WS ice unwrap: `{type:"ice",candidate:{...}}` → candidate dict.
- **Control unary**: `TouchEvent` / `KeyboardEvent` (key+text), device px, client-validated; REST `/v1/input/*` frozen.
- **State**: additive `stream.rtc{supported,active,viewers,guid?,fps?,reason?}`; existing scalars unchanged.

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | Control mapping, px validation, version gate, allowlist JSON, answer-first ordering, close codes | bun test, fake gRPC messages |
| Integration | RtcSession lifecycle, WS signaling round-trips, fanout, state `rtc` | In-process `@grpc/grpc-js` server faking EmulatorController+Rtc (no emulator) |
| E2E | Live v1 offer/answer/ICE + media, `-rtcfps` gating | Tagged env-gated test vs running emulator (probe-b2 elevated); <100ms, 30–60fps |

## Migration / Rollout

Chained PRs (≤400 lines/slice): **PR1** gRPC control + launch flags + scrcpy deletion; **PR2** RtcSession + signaling + fanout; **PR3** browser RTC rewrite. Each slice keeps control + polling working (adb fallback); mid-chain abort = drop remaining; revert = rollback merged PRs. No data migration; capability additive via `stream.rtc`.

## Open Questions

- [ ] `-rtcfps` absent <36.6 → handshake reports configured value though flag unset; acceptable? (non-blocking)
- [ ] VP9/H.264: spec MAY; VP8-only answer in PR2, revisit PR3 (non-blocking)