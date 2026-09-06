# Emulator RTC Streaming Specification

## Purpose

Native emulator video + control: the browser is the WebRTC peer, the daemon brokers JSEP signaling over the existing loopback WebSocket, and input is injected via the emulator's gRPC EmulatorController (the Android Studio architecture). ONE video path — no in-guest encode, no WebCodecs, no scrcpy. Audio deferred.

## Requirements

### Requirement: Signaling Channel

`WS /v1/stream/video` MUST upgrade to a WebSocket and MUST carry JSEP signaling as JSON text frames; it MUST NOT carry binary video frames. Message shapes SHALL be (server→client: `handshake`, `offer`, `answer`, `ice`, `state`; client→server: `answer`, `ice`, `state`):

- `{"type":"handshake","rtcId":string,"fps":number,"codecs":string[]}` — first frame; `rtcId` is the opaque RtcService stream id; `codecs` lists the emulator's offered codecs (`"VP8"` mandatory).
- `{"type":"offer","sdp":string}` / `{"type":"answer","sdp":string}` — SDP, relayed verbatim.
- `{"type":"ice","candidate":RTCIceCandidateInit}` — relayed verbatim.
- `{"type":"state","state":"connecting"|"streaming"|"error","reason"?:string}`.
- Client MUST reply to the offer with `answer`; MUST send each local candidate as `ice`; MUST send `{"type":"state","state":"streaming"}` once its peer connection reaches `connected`.
- Unknown or malformed `type` MUST produce a JSON error body `{"error":{"code","message"}}` followed by a close.

#### Scenario: Signaling connects

- GIVEN an emulator launched by the bridge with RTC enabled
- WHEN a client opens `WS /v1/stream/video` and runs an `RTCPeerConnection`
- THEN it receives `handshake`, then the emulator's `offer`, relays its `answer` and `ice` candidates, and the server reports `state: streaming` after the client's `streaming` message

#### Scenario: Malformed signaling

- GIVEN an open signaling socket
- WHEN a client sends a non-JSON frame or an unknown `type`
- THEN the server sends a JSON error and closes the connection (never a silent hang)

#### Scenario: Handshake first

- GIVEN a client opens the socket
- WHEN the first frame is read
- THEN it is the `handshake` frame (no `offer` precedes it)

### Requirement: Opaque JSEP Relay

The daemon MUST relay `offer`/`answer`/`ice` messages verbatim between client and emulator without inspecting or modifying SDP/candidates, and MUST NOT re-mux or transcode media (passthrough). Media MUST flow directly between the browser's `RTCPeerConnection` and the emulator over loopback UDP; the daemon MUST NOT carry media.

#### Scenario: Offer/answer round-trip verbatim

- GIVEN an active signaling socket
- WHEN the client sends an `answer` with a specific SDP
- THEN the emulator RtcService receives that exact SDP string

#### Scenario: Media bypasses the daemon

- GIVEN an established stream
- WHEN media is being exchanged
- THEN no binary frames traverse the WS and the daemon's process handles no media bytes

### Requirement: RtcStream Lifecycle

The system MUST start an RtcStream (`requestRtcStream`) on the FIRST viewer and MUST tear it down when the LAST viewer's socket closes; each viewer SHALL have its own opaque RtcId. While any stream is active, the daemon MUST poll `getStatus` as a watchdog; emulator loss MUST close all viewer sockets with `DEVICE_LOST` (4409) and report `stream.active: false`.

#### Scenario: First viewer starts the stream

- GIVEN no active RtcStream
- WHEN the first client connects to `WS /v1/stream/video`
- THEN the daemon calls `requestRtcStream`, receives an RtcId, and relays the emulator's offer

#### Scenario: Last viewer tears down

- GIVEN an active RtcStream with one viewer
- WHEN that viewer's socket closes
- THEN the daemon closes the RtcStream and no RtcService session remains

#### Scenario: Emulator dies mid-stream

- GIVEN an active stream
- WHEN the emulator process disappears
- THEN viewers are closed with code 4409 and `GET /v1/state` reports `stream.active: false` with a `reason` (not a 500)

### Requirement: Launch Flags and Token

`emulator_start` MUST launch the emulator with `-grpc-allowlist <generated-file>` and `-rtcfps <fps>`; the allowlist MUST permit `RtcService` and server reflection for the bridge's token. The gRPC auth token MUST be read from the running instance's `grpc.token` (per-instance pid ini) and MUST be attached to every gRPC call. The bridge MUST NOT start RTC streaming below emulator version 36.5.11 and MUST return an actionable error naming the version requirement.

#### Scenario: Flagged launch

- GIVEN a version-eligible AVD
- WHEN `emulator_start` runs
- THEN the emulator launches with the allowlist and fps flags, and the token file for the new pid is readable

#### Scenario: Version gate

- GIVEN an emulator below 36.5.11
- WHEN streaming is attempted
- THEN `stream.rtc.supported` is `false` with `reason` naming the version requirement and an actionable upgrade path

### Requirement: Fallback and Degradation

When the emulator was launched externally (no bridge allowlist), video MUST degrade gracefully: `stream.rtc.supported: false` with `reason: "grpc_permission_denied"`, surfaced in `/v1/state`; there MUST NOT be a second video path (no fallback stream). Control MUST keep working (default allowlist permits `EmulatorController`).

#### Scenario: Externally launched emulator

- GIVEN an emulator not started by the bridge
- WHEN `GET /v1/state` is requested
- THEN `stream.rtc.supported` is `false` with the permission reason, while gRPC control still injects input successfully

### Requirement: Codec and FPS Negotiation

The media negotiation MUST offer VP8 by default; VP9 and H.264 MAY be offered/negotiated via standard RTCRtpTransceiver negotiation. The configured `-rtcfps` value (30 or 60) MUST be reported in the `handshake` and in `/v1/state` `stream.rtc.fps`.

#### Scenario: Default VP8

- GIVEN a fresh stream
- WHEN the emulator's offer arrives
- THEN `handshake.codecs` contains `"VP8"` and the browser's peer connection negotiates it successfully

#### Scenario: FPS reported

- GIVEN an emulator launched with `-rtcfps 60`
- WHEN a viewer connects
- THEN the `handshake` reports `fps: 60` and state reports `stream.rtc.fps: 60`

### Requirement: Error States

Streaming errors MUST be expressed as a JSON error body plus a close code. `PERMISSION_DENIED` (4401) MUST be used when the token/allowlist blocks RtcService; `VIEWER_CAP` (4429) MUST be used when the emulator's concurrent-RtcStream cap (probed, ≤ the emulator maximum) is reached; `DEVICE_LOST` (4409) MUST be used for mid-stream disconnects; `NO_DEVICE` (4404) when the RtcStream cannot start.

#### Scenario: Permission denied

- GIVEN no allowlist entry for RtcService
- WHEN a client opens `WS /v1/stream/video`
- THEN the connection is rejected with a JSON error naming `PERMISSION_DENIED` and closed with 4401

#### Scenario: Stream cap reached

- GIVEN the emulator's concurrent RtcStream cap reached
- WHEN an additional viewer connects
- THEN the new connection is rejected with a JSON error naming the cap, closed with 4429, and existing streams keep running

### Requirement: gRPC Control Surface

Control MUST be injected via gRPC unary calls (`sendTouch`, `sendKey`, `sendText` mapped to TouchEvent/KeyboardEvent) with coordinates in device physical pixels. gRPC control MUST work independently of any RtcStream. Unary control round-trips SHOULD stay under 20ms.

#### Scenario: Tap via unary

- GIVEN an emulator with gRPC reachable
- WHEN a tap at physical-pixel coordinates is sent
- THEN the emulator injects the touch and the unary call returns promptly

#### Scenario: Control while video is off

- GIVEN no RtcStream active
- WHEN a REST `/v1/input/*` call or a gRPC control call is made
- THEN the input is injected (video state does not gate control)

## Non-Goals

- No audio (streamAudio/WebRTC — explicit deferral)
- No MMAP transport (crash-correlated, obs #596)
- No WebRTC data channel for control
- No real-device streaming; no gRPC-web/Envoy proxy