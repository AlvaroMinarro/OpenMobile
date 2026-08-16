# Device Streaming Specification

## Purpose

Stream the selected device's screen as raw H.264 over a localhost WebSocket, with a low-latency control channel for input injection — the live interaction path replacing ~1fps polling. The bridge keeps `/v1/screenshot` polling intact as fallback and for stills.

## Requirements

### Requirement: Stream Support Detection

`GET /v1/state` MUST report stream capability in the `stream` object; `stream.supported` MUST be `false` when the scrcpy-server jar is missing (or the device is unsupported), `stream.active` MUST reflect an ongoing stream, and `reason` MUST explain when the stream is unavailable.

#### Scenario: Unsupported environment

- GIVEN the bundled scrcpy-server.jar is absent or the device cannot run the raw_stream server
- WHEN `GET /v1/state` is requested
- THEN `stream.supported` is `false` with `reason` naming the cause, and `stream.active` is `false`

#### Scenario: Active stream reports

- GIVEN a stream is running on the selected device
- WHEN `GET /v1/state` is requested
- THEN `stream` reports `supported: true`, `active: true`, and a `viewers` count equal to the connected viewer sockets

#### Scenario: Degraded state reporting

- GIVEN the adb connection to the selected device drops
- WHEN `GET /v1/state` is requested
- THEN `stream.active` is `false` with `reason` describing the disconnect (not a 500)

### Requirement: H.264 Stream Endpoint

`WS /v1/stream/video` MUST upgrade to a WebSocket and MUST send the H.264 stream for the selected device as binary messages; each message MUST carry one raw Annex-B access unit (SPS/PPS/IDR or slice). The endpoint MUST send the codec initialization (lengthSize, SPS/PPS) in a JSON handshake message before the first frame.

#### Scenario: Stream connects

- GIVEN a usable selected device with `stream.supported: true`
- WHEN a client opens `WS /v1/stream/video`
- THEN the server opens the stream and sends a JSON handshake (codec, lengthSize, SPS/PPS) followed by binary H.264 access units

#### Scenario: Device unusable

- GIVEN no usable device or the stream unsupported
- WHEN a client opens `WS /v1/stream/video`
- THEN the connection is rejected with a JSON error and closed (never a silent hang)

#### Scenario: Early keyframe

- GIVEN a client joins mid-GOP
- WHEN the stream starts
- THEN the server MUST deliver the next intra-frame as early as the encoder allows so the client can begin rendering

### Requirement: Drop-Oldest Backpressure

The stream MUST decouple viewer consumption from the scrcpy read loop; when a viewer's socket backpressures, the server MUST drop the oldest undelivered frame for that viewer rather than blocking the encoder, up to a viewer cap.

#### Scenario: Slow viewer

- GIVEN a viewer socket that cannot keep up
- WHEN frames are produced faster than the socket drains
- THEN the server drops the oldest queued frame for that viewer and continues sending newer frames

#### Scenario: Viewer cap reached

- GIVEN the maximum viewer count is reached
- WHEN an additional viewer connects
- THEN the new connection is rejected with a JSON error naming the cap

### Requirement: Control Channel

`WS /v1/stream/control` MUST accept JSON messages (`inject` with `type: tap|swipe|text` and the same coordinate semantics as `POST /v1/input/*`) while a stream is active; the control channel MUST be closed when no stream is active.

#### Scenario: Tap during stream

- GIVEN a stream active with a connected control socket
- WHEN an `inject` message of type `tap` with `{x, y}` is sent
- THEN the tap is injected via the device control socket and an `ack` is returned

#### Scenario: Control without stream

- GIVEN no active stream
- WHEN a client opens `WS /v1/stream/control`
- THEN it is rejected with an error message and closed

#### Scenario: Unknown inject type

- GIVEN a connected control channel
- WHEN an `inject` message with an unknown `type` is received
- THEN a JSON error is returned identifying the invalid type, and the connection stays open

### Requirement: Fallback Contract

When streaming is unsupported or disabled, the existing `POST /v1/input/*` (adb) and `GET /v1/screenshot` endpoints MUST remain fully functional and unchanged.

#### Scenario: Unsupported environments still work

- GIVEN `stream.supported: false` or the fallback to polling active
- WHEN a polling client uses `GET /v1/screenshot` followed by `POST /v1/input/tap`
- THEN the screenshot is returned and the tap is injected exactly as before streaming

### Requirement: Stream Lifecycle

The stream MUST be torn down when the last viewer disconnects or the device is lost; a disconnect during an active stream MUST NOT leave the device with a dangling scrcpy process.

#### Scenario: Device lost mid-stream

- GIVEN an active stream
- WHEN the selected device disconnects
- THEN the daemon tears down the stream, closes all sockets, and reports `stream.active: false` in `GET /v1/state`

#### Scenario: Restart after disconnect

- GIVEN a stream that was torn down by a device disconnect
- WHEN the device reconnects and a new viewer opens `WS /v1/stream/video`
- THEN a fresh stream starts and delivers the handshake plus frames

## Non-Goals

- No WebRTC, audio, or per-viewer bitrate negotiation
- No keyframe-request protocol from clients
- No multi-touch gestures beyond tap/swipe/text