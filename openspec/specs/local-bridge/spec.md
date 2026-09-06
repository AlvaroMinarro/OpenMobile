# Local Bridge Specification

## Purpose

A localhost daemon exposing device state, screenshots, input, and streaming endpoints — the stable `/v1` contract (REST and WebSocket) the future OpenChamber surface implements against.

## Requirements

### Requirement: Device State Endpoint

`GET /v1/state` MUST return JSON describing attached devices (serial, state), the selected device, running emulators, and a frame/layout summary. The reported selection MUST reflect the runtime selection override when one is active (see `device-discovery`) and MUST indicate its source so clients can distinguish override from tier-based resolution.

#### Scenario: State request

- GIVEN the bridge running with a selected device
- WHEN `GET /v1/state` is requested
- THEN it returns 200 with JSON state including devices and selection

#### Scenario: No device

- GIVEN no device attached
- WHEN `GET /v1/state` is requested
- THEN it returns 200 with an empty device list (not an error)

#### Scenario: State reflects selection override

- GIVEN a runtime selection override for `emulator-5556`
- WHEN `GET /v1/state` is requested
- THEN `selected` reports `emulator-5556` with the override source indicated

### Requirement: Screenshot Endpoint

`GET /v1/screenshot` MUST return the current screen as PNG, suitable for polling at roughly 0.5–1 fps.

#### Scenario: Screenshot request

- GIVEN the bridge running with a usable device
- WHEN `GET /v1/screenshot` is requested
- THEN it returns 200 with `image/png`

#### Scenario: Screenshot without device

- GIVEN no usable device
- WHEN `GET /v1/screenshot` is requested
- THEN it returns an error status with a JSON error body

### Requirement: Input Endpoints

`POST /v1/input/tap`, `POST /v1/input/swipe`, and `POST /v1/input/text` MUST inject input on the selected device and return success or an actionable JSON error.

#### Scenario: Tap via bridge

- GIVEN a usable device
- WHEN `POST /v1/input/tap` is sent with coordinates
- THEN it returns 200 and the tap is injected

#### Scenario: Input without device

- GIVEN no usable device
- WHEN an input endpoint is called
- THEN it returns an error status with JSON naming the cause

### Requirement: Localhost-Only Binding

The daemon MUST bind to localhost only, MUST version the contract under the `/v1` path prefix, and MUST NOT expose MCP semantics.

#### Scenario: Binding

- GIVEN the bridge started
- THEN it listens on a loopback address only and serves only `/v1/*` routes (REST and WebSocket)

### Requirement: Contract Stability

The `/v1` contract MUST be documented with this change so the `openchamber-emulator-surface` change can implement against it without coupling to this repo's internals.

#### Scenario: Documented contract

- GIVEN the `/v1` contract shipped with this change
- WHEN any endpoint documented in README §`/v1` bridge contract is exercised
- THEN it responds with exactly the documented route shape, status codes, and error bodies

### Requirement: Streaming WebSocket Endpoints

The bridge MUST expose `WS /v1/stream/video` (JSON JSEP signaling per the emulator-rtc-streaming contract) and `WS /v1/stream/control` (JSON input events, unchanged) on the loopback listener, alongside the existing REST routes.

#### Scenario: Signaling upgrade

- GIVEN the bridge running with `stream.supported: true`
- WHEN a client connects to `WS /v1/stream/video`
- THEN the connection is upgraded and carries JSON signaling frames only (`handshake` first, then `offer`/`answer`/`ice`/`state`), never binary video

#### Scenario: Control while streaming

- GIVEN the bridge running with an active stream
- WHEN a client connects to `WS /v1/stream/control`
- THEN the connection is upgraded and accepts JSON input events exactly as before

### Requirement: RTC Stream State

`GET /v1/state` MUST include an additive `rtc` object inside `stream` with `supported`, `active`, `viewers`, and optional `guid`, `fps`, `reason`; the existing `stream` scalar fields (`supported`, `active`, `reason`, `viewers`, `width`, `height`) MUST remain present and unchanged. Extending `stream` (not replacing it) keeps pre-RTC clients compatible.

- `guid`: opaque RtcId of the most recently started RtcStream, present when `rtc.active` is true.
- `fps`: configured `-rtcfps` value, present when `rtc.supported` is true.
- `reason`: present when `rtc.supported` is false (`grpc_permission_denied` for external launches, `emulator_version` below the gate, `grpc_unavailable` otherwise, `no_device_selected` when the selected serial is `auto` and unresolved — enumeration synced at archive, 2026-09-06, per verify WARNING 1).

#### Scenario: RTC fields on state

- GIVEN the bridge running with an emulator launched by it
- WHEN `GET /v1/state` is requested
- THEN `stream` contains the existing scalars plus `rtc` with `supported: true`, `active`, `viewers`, `fps`, and `guid` while streaming

#### Scenario: Externally launched emulator

- GIVEN an emulator not launched by the bridge
- WHEN `GET /v1/state` is requested
- THEN `stream.rtc` reports `supported: false` with `reason: "grpc_permission_denied"`, while `stream.supported` reflects the degraded video capability and no second video path is advertised

#### Scenario: Unresolved auto serial

- GIVEN the selection is `auto` with no resolvable device serial
- WHEN `GET /v1/state` is requested
- THEN `stream.rtc` reports `supported: false` with `reason: "no_device_selected"`

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

### Requirement: Additive Stream State

`GET /v1/state` MUST include a `stream` object with `supported`, `active`, `reason`, and `viewers` fields; existing fields (`schema`, `bridge`, `selected`, `frame`, `devices`, `emulators`) MUST remain present and unchanged.

#### Scenario: Stream fields on state

- GIVEN the bridge running with a selected device
- WHEN `GET /v1/state` is requested
- THEN the response contains the existing fields plus `stream` with `supported`, `active`, `reason`, `viewers`

#### Scenario: Stream fields absent when disabled

- GIVEN `OPENMOBILE_STREAM=off`
- WHEN `GET /v1/state` is requested
- THEN `stream.supported` is `false` and `stream.active` is `false`

### Requirement: Stream Configuration

The bridge MUST read an `OPENMOBILE_STREAM` env var (`on` default; `off` disables streaming) and MUST keep the loopback binding, secret gate, CORS headers, and error-body shape working for the new WS routes exactly as for the REST routes.

#### Scenario: Env kill-switch

- GIVEN the bridge started with `OPENMOBILE_STREAM=off`
- WHEN a client attempts `WS /v1/stream/video`
- THEN the upgrade is rejected with `stream.supported: false` in the error body

### Requirement: Emulator Lifecycle Routes

The bridge MUST expose `POST /v1/emulator/start`, `POST /v1/emulator/stop`, and `POST /v1/emulator/create`, delegating to the existing emulator-lifecycle handlers and zod schemas. Status mapping MUST be: duplicate AVD name on create → 409 `avd_exists`; unknown AVD on start/stop → 404 `avd_not_found` with `details.available` naming existing AVDs; readiness timeout on start → 504 `boot_timeout` naming the AVD, its serial, and last observed state; malformed or schema-invalid bodies → 422 `validation_error`. Stop MUST be idempotent at the route layer: stopping a known AVD that is already stopped returns 200 with `alreadyStopped: true` without issuing another CLI stop.

#### Scenario: Successful start returns serial

- GIVEN stopped AVD `Pixel_9_Pro`
- WHEN `POST /v1/emulator/start` is sent with that name
- THEN it responds 200 `{started, serial}` once that emulator reaches state `device`

#### Scenario: Duplicate AVD rejected

- GIVEN AVD `Pixel_9_Pro` already exists
- WHEN `POST /v1/emulator/create` is sent with name `Pixel_9_Pro`
- THEN it responds 409 code `avd_exists`, and no AVD is created

#### Scenario: Unknown AVD listed

- GIVEN AVDs `A` and `B` exist and `Missing` does not
- WHEN `POST /v1/emulator/start` is sent with name `Missing`
- THEN it responds 404 code `avd_not_found` and `details.available` lists `A`, `B`

#### Scenario: Boot timeout surfaced

- GIVEN a started AVD that cannot reach state `device` within its bound
- WHEN `POST /v1/emulator/start` times out
- THEN it responds 504 code `boot_timeout` naming the AVD, its serial, and last observed state

#### Scenario: Double stop is idempotent

- GIVEN AVD `Pixel_9_Pro` exists and is not running
- WHEN `POST /v1/emulator/stop` is sent twice for that name
- THEN both requests respond 200 (`alreadyStopped: true` on the second) and no error occurs

### Requirement: Device Selection Route

The bridge MUST expose `POST /v1/device/select` accepting `{serial}`, validated against the attached device list. A valid selection MUST return 200 `{selected}` and become the runtime selection override (precedence per `device-discovery`). An invalid serial MUST return 404 `device_not_found` with `details.attached` naming attached serials. The override lives in daemon memory only: restarting the bridge MUST clear it.

#### Scenario: Select attached serial

- GIVEN devices `emulator-5554` and `emulator-5556` attached
- WHEN `POST /v1/device/select` is sent with serial `emulator-5556`
- THEN it responds 200 `{selected:"emulator-5556"}` and `GET /v1/state` reports that selection

#### Scenario: Invalid serial rejected

- GIVEN devices `emulator-5554` attached
- WHEN `POST /v1/device/select` is sent with serial `does-not-exist`
- THEN it responds 404 code `device_not_found` and `details.attached` lists `emulator-5554`

#### Scenario: Restart clears override

- GIVEN a selection override active for `emulator-5556`
- WHEN the bridge daemon process restarts
- THEN no override remains and selection follows the standard tiers again

### Requirement: UI Tree Route

`GET /v1/ui-tree` MUST return the same JSON shape the local `get_ui_tree` tool produces — `{serial, empty, tree}`. An empty UI hierarchy MUST be signalled in-band as 200 with `empty: true` and an empty `tree` array, never as an HTTP error.

#### Scenario: Tree mirrors local tool

- GIVEN a usable device showing a populated window
- WHEN `GET /v1/ui-tree` is requested
- THEN it responds 200 with `{serial, empty:false, tree}` equal in shape to local `get_ui_tree` output

#### Scenario: Empty UI signalled in-band

- GIVEN a usable device whose UI hierarchy is empty
- WHEN `GET /v1/ui-tree` is requested
- THEN it responds 200 with `empty: true` and `tree: []`

### Requirement: Logcat WebSocket Route

The bridge MUST expose `WS /v1/logcat/ws` on the loopback listener. After upgrade, the client subscribes by sending one JSON filter message (`{tags?, priority?, backlog?}`); the server then applies the stream semantics specified in `logcat-read`. This route is subject to the same loopback binding, error conventions, and auth gate as every other WS route.

#### Scenario: Subscribe and receive

- GIVEN a connected, authorized logcat WS client
- WHEN it sends `{"priority":"E","backlog":10}`
- THEN it first receives up to 10 recent matching lines, then continues receiving matching live lines

#### Scenario: Auth gate applies

- GIVEN auth is enabled
- WHEN a client attempts `WS /v1/logcat/ws` without a valid subprotocol credential
- THEN the upgrade is rejected per `bridge-auth` WS rules

### Requirement: Additive Route Compatibility

New routes and the auth gate MUST NOT alter existing `/v1` behavior: with auth unset, responses of `GET /v1/state`, `GET /v1/screenshot`, input routes, stream-state fields, and video/control WS upgrades remain byte-identical to their pre-change contracts. All new routes MUST be served by the same localhost-only listener under `/v1`.

#### Scenario: Legacy surface untouched

- GIVEN the bridge restarted on the new build with auth unset
- WHEN pre-existing routes are exercised exactly as in the shipped golden tests
- THEN every response matches the pre-change contract byte-for-byte

## Non-Goals

- Unauthenticated access while auth is enabled: credential checks are delegated to the opt-in `bridge-auth` capability (default-off preserves the legacy loopback-trust posture) — the former blanket "no authentication" non-goal is superseded for the authenticated mode
- `POST /v1/input/key` stays MCP-only — excluded from the HTTP surface by maintainer decision
- No GET-style logcat tail/dump HTTP route (streaming WS only, per `logcat-read`)
- No rate limiting, no non-loopback binding, no async job queue for lifecycle routes
- No proxying of MCP tools over HTTP
- No audio or per-viewer bitrate negotiation (WebRTC video is the shipped path — see `emulator-rtc-streaming`; audio explicitly deferred)
- No `/v2` versioning policy: routing future breaking changes under `/v2` is future policy, exercisable only when an actual breaking change lands — no runtime test is constructible today (`/v1` versioning remains normative in the Binding requirement)
- No downstream implementation of the documented contract: consuming the shipped `/v1` WS/stream-state contract (documented in README) is owned by the external `openchamber-emulator-surface` change (OpenChamber fork PR, explicit proposal Out-of-Scope)

## Out of Scope

- Remote access (the surface is a local app)
- Rate limiting or multi-client coordination (design decisions if needed); issued-token authentication itself shipped as the opt-in `bridge-auth` capability