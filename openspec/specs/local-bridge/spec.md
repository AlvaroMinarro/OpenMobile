# Local Bridge Specification

## Purpose

A localhost daemon exposing device state, screenshots, input, and streaming endpoints — the stable `/v1` contract (REST and WebSocket) the future OpenChamber surface implements against.

## Requirements

### Requirement: Device State Endpoint

`GET /v1/state` MUST return JSON describing attached devices (serial, state), the selected device, running emulators, and a frame/layout summary.

#### Scenario: State request

- GIVEN the bridge running with a selected device
- WHEN `GET /v1/state` is requested
- THEN it returns 200 with JSON state including devices and selection

#### Scenario: No device

- GIVEN no device attached
- WHEN `GET /v1/state` is requested
- THEN it returns 200 with an empty device list (not an error)

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

The bridge MUST expose `WS /v1/stream/video` (binary H.264 frames) and `WS /v1/stream/control` (JSON input events) on the loopback listener, alongside the existing REST routes.

#### Scenario: Streaming upgrade

- GIVEN the bridge running with `stream.supported: true`
- WHEN a client connects to `WS /v1/stream/video`
- THEN the connection is upgraded and carries binary H.264 with a JSON handshake first

#### Scenario: Control while streaming

- GIVEN the bridge running with an active stream
- WHEN a client connects to `WS /v1/stream/control`
- THEN the connection is upgraded and accepts JSON input events

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

## Non-Goals

- No authentication beyond the localhost trust boundary
- No proxying of MCP tools over HTTP
- No WebRTC, audio, or per-viewer bitrate negotiation (deferred production path)
- No `/v2` versioning policy: routing future breaking changes under `/v2` is future policy, exercisable only when an actual breaking change lands — no runtime test is constructible today (`/v1` versioning remains normative in the Binding requirement)
- No downstream implementation of the documented contract: consuming the shipped `/v1` WS/stream-state contract (documented in README) is owned by the external `openchamber-emulator-surface` change (OpenChamber fork PR, explicit proposal Out-of-Scope)

## Out of Scope

- Remote access (the surface is a local app)
- Auth tokens, rate limiting, or multi-client coordination (design decisions if needed)