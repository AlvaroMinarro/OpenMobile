# Delta for Local Bridge

> Delta base: `openspec/specs/local-bridge/spec.md` (archived 2026-08-16). Everything not listed here is frozen.

## ADDED Requirements

### Requirement: RTC Stream State

`GET /v1/state` MUST include an additive `rtc` object inside `stream` with `supported`, `active`, `viewers`, and optional `guid`, `fps`, `reason`; the existing `stream` scalar fields (`supported`, `active`, `reason`, `viewers`, `width`, `height`) MUST remain present and unchanged. Extending `stream` (not replacing it) keeps pre-RTC clients compatible.

- `guid`: opaque RtcId of the most recently started RtcStream, present when `rtc.active` is true.
- `fps`: configured `-rtcfps` value, present when `rtc.supported` is true.
- `reason`: present when `rtc.supported` is false (`grpc_permission_denied` for external launches, `emulator_version` below the gate, `grpc_unavailable` otherwise).

#### Scenario: RTC fields on state

- GIVEN the bridge running with an emulator launched by it
- WHEN `GET /v1/state` is requested
- THEN `stream` contains the existing scalars plus `rtc` with `supported: true`, `active`, `viewers`, `fps`, and `guid` while streaming

#### Scenario: Externally launched emulator

- GIVEN an emulator not launched by the bridge
- WHEN `GET /v1/state` is requested
- THEN `stream.rtc` reports `supported: false` with `reason: "grpc_permission_denied"`, while `stream.supported` reflects the degraded video capability and no second video path is advertised

### Requirement: Emulator Launch Configuration

`emulator_start` MUST launch AVDs with `-grpc-allowlist <bridge-generated-file>` and `-rtcfps <30|60>` (default 30) and MUST gate RTC video on emulator version ≥ 36.5.11 with an actionable error below it. The bridge MUST read the running instance's gRPC token from the per-instance pid ini (`grpc.token`) before any gRPC call.

#### Scenario: Flags passed at launch

- GIVEN a version-eligible AVD name
- WHEN `emulator_start` is called
- THEN the emulator process starts with both flags and `/v1/state` later reports `stream.rtc.supported: true`

#### Scenario: Token read

- GIVEN a running emulator started by the bridge
- WHEN the bridge establishes gRPC
- THEN the token from that instance's pid ini is used and gRPC calls authenticate

## MODIFIED Requirements

### Requirement: Streaming WebSocket Endpoints

The bridge MUST expose `WS /v1/stream/video` (JSON JSEP signaling per the emulator-rtc-streaming contract) and `WS /v1/stream/control` (JSON input events, unchanged) on the loopback listener, alongside the existing REST routes.
(Previously: `/v1/stream/video` carried binary H.264 Annex-B frames with a JSON codec handshake.)

#### Scenario: Signaling upgrade

- GIVEN the bridge running with `stream.supported: true`
- WHEN a client connects to `WS /v1/stream/video`
- THEN the connection is upgraded and carries JSON signaling frames only (`handshake` first, then `offer`/`answer`/`ice`/`state`), never binary video

#### Scenario: Control while streaming

- GIVEN the bridge running with an active stream
- WHEN a client connects to `WS /v1/stream/control`
- THEN the connection is upgraded and accepts JSON input events exactly as before

## REMOVED Requirements

(none)