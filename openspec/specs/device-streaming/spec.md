# Device Streaming Specification

## Purpose

Stream the selected emulator's screen natively via WebRTC: the browser is the WebRTC peer, the daemon brokers JSEP signaling over a loopback WebSocket, and input is injected via the emulator's gRPC control surface — the live interaction path replacing ~1fps polling. The bridge keeps `/v1/screenshot` polling intact as fallback and for stills. (Synced from the `emulator-native-stream` delta at archive, 2026-09-06; the scrcpy H.264 path is removed — the RTC contract lives in `emulator-rtc-streaming`.)

## Requirements

### Requirement: Stream Support Detection

`GET /v1/state` MUST report stream capability in the `stream` object; `stream.supported` MUST be `false` when the selected emulator cannot run RTC video (version below the gate, externally launched without allowlist, or no RtcService), `stream.active` MUST reflect an ongoing stream, `reason` MUST explain when the stream is unavailable, and `stream.rtc` MUST carry the detailed RTC capability.

#### Scenario: Unsupported environment

- GIVEN an emulator below version 36.5.11, launched externally, or lacking RtcService access
- WHEN `GET /v1/state` is requested
- THEN `stream.supported` is `false` with `reason` naming the cause, `stream.active` is `false`, and `stream.rtc.supported` is `false`

#### Scenario: Active stream reports

- GIVEN a RtcStream running on the selected emulator
- WHEN `GET /v1/state` is requested
- THEN `stream` reports `supported: true`, `active: true`, a `viewers` count equal to the connected viewer sockets, and `rtc.active: true`

#### Scenario: Degraded state reporting

- GIVEN the emulator process disappears mid-stream
- WHEN `GET /v1/state` is requested
- THEN `stream.active` is `false` with `reason` describing the disconnect (not a 500)

### Requirement: Video Stream Endpoint

`WS /v1/stream/video` MUST upgrade to a WebSocket and MUST carry JSON JSEP signaling for the selected emulator per the emulator-rtc-streaming contract (`handshake` first, then `offer`/`answer`/`ice`/`state`); it MUST NOT carry binary video frames. The endpoint MUST reject new viewers with a JSON error (naming the cap) and close code 4429 when the viewer cap is reached.

#### Scenario: Stream connects

- GIVEN a usable emulator with `stream.supported: true`
- WHEN a client opens `WS /v1/stream/video`
- THEN the server sends the `handshake` and relays the emulator's `offer`, then relays `answer`/`ice` in both directions

#### Scenario: Device unusable

- GIVEN no usable emulator or the stream unsupported
- WHEN a client opens `WS /v1/stream/video`
- THEN the connection is rejected with a JSON error and closed (never a silent hang)

#### Scenario: Viewer cap reached

- GIVEN the maximum concurrent RtcStream count is reached
- WHEN an additional viewer connects
- THEN the new connection is rejected with a JSON error naming the cap and closed with 4429, while existing streams keep running

### Requirement: Control Channel

`WS /v1/stream/control` MUST accept JSON messages (`inject` with `type: tap|swipe|text` and the same coordinate semantics as `POST /v1/input/*`) while a stream is active; the control channel MUST be closed when no stream is active. The RTC world keeps this contract frozen; the backend is now gRPC unary (see input-channel spec).

#### Scenario: Tap during stream

- GIVEN a stream active with a connected control socket
- WHEN an `inject` message of type `tap` with `{x, y}` is sent
- THEN the tap is injected via the gRPC-backed channel and an `ack` is returned

#### Scenario: Control without stream

- GIVEN no active stream
- WHEN a client opens `WS /v1/stream/control`
- THEN it is rejected with an error message and closed

#### Scenario: Unknown inject type

- GIVEN a connected control channel
- WHEN an `inject` message with an unknown `type` is received
- THEN a JSON error is returned identifying the invalid type, and the connection stays open

### Requirement: Fallback Contract

When streaming is unsupported or disabled, the existing `POST /v1/input/*` (gRPC unary when available, `adb shell input` otherwise) and `GET /v1/screenshot` endpoints MUST remain fully functional and unchanged.

#### Scenario: Unsupported environments still work

- GIVEN `stream.supported: false` or the fallback to polling active
- WHEN a polling client uses `GET /v1/screenshot` followed by `POST /v1/input/tap`
- THEN the screenshot is returned and the tap is injected exactly as before streaming

### Requirement: Stream Lifecycle

The stream MUST be torn down when the last viewer disconnects or the emulator is lost; a disconnect during an active stream MUST NOT leave the emulator with a dangling RtcStream.

#### Scenario: Emulator lost mid-stream

- GIVEN an active stream
- WHEN the emulator stops being reachable
- THEN the daemon tears down the RtcStream, closes all sockets with 4409, and reports `stream.active: false` in `GET /v1/state`

#### Scenario: Restart after disconnect

- GIVEN a stream that was torn down by an emulator disconnect
- WHEN the emulator returns and a new viewer opens `WS /v1/stream/video`
- THEN a fresh RtcStream starts and delivers the `handshake` plus signaling

## Non-Goals

- No audio or per-viewer bitrate negotiation (WebRTC video is the shipped path — see `emulator-rtc-streaming`; audio explicitly deferred)
- No keyframe-request protocol from clients
- No multi-touch gestures beyond tap/swipe/text
- No early-keyframe delivery guarantee: intra-frame timing is encoder-controlled ("as early as the encoder allows"); verified manually on live devices, not deterministically automatable