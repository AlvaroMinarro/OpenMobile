# Delta for Local Bridge

> Base: `openspec/changes/android-device-bridge/specs/local-bridge/spec.md` (the android-device-bridge Local Bridge Specification). Main `openspec/specs/local-bridge/` is not yet populated — this change is unarchived, so this delta targets the per-change spec above. This delta removes the "no WebSocket/streaming" non-goal, adds the streaming WS surface, and adds additive `stream` fields to `/v1/state`; all other `/v1` REST routes are frozen and unchanged.

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Localhost-Only Binding

The daemon MUST bind to localhost only, MUST version the contract under the `/v1` path prefix, and MUST NOT expose MCP semantics.
(Previously: same binding rule, but no WebSocket routes were specified — the WS streaming surface is now part of `/v1`.)

#### Scenario: Binding

- GIVEN the bridge started
- THEN it listens on a loopback address only and serves only `/v1/*` routes (REST and WebSocket)

## REMOVED Requirements

### Requirement: No WebSocket/streaming endpoints (polling only)

(Reason: streaming is now in scope — the WS surface is the primary live path; `/v1/screenshot` polling remains as fallback and for stills. The other non-goals — no auth beyond loopback, no MCP proxying — remain.)

## Non-Goals

- No authentication beyond the localhost trust boundary
- No proxying of MCP tools over HTTP
- No WebRTC, audio, or per-viewer bitrate negotiation (deferred production path)
- No `/v2` versioning policy: routing future breaking changes under `/v2` is future policy, exercisable only when an actual breaking change lands — no runtime test is constructible today (`/v1` versioning remains normative in the Binding requirement)
- No downstream implementation of the documented contract: consuming the shipped `/v1` WS/stream-state contract (documented in README) is owned by the external `openchamber-emulator-surface` change (OpenChamber fork PR, explicit proposal Out-of-Scope)

## Out of Scope

- Remote access (the surface is a local app)
- Auth tokens, rate limiting, or multi-client coordination (design decisions if needed)