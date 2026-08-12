# Local Bridge Specification

## Purpose

A localhost HTTP daemon exposing device state, screenshots, and input endpoints — the stable `/v1` contract the future OpenChamber surface implements against.

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
- THEN it listens on a loopback address only and serves only `/v1/*` routes

#### Scenario: Contract evolution

- GIVEN a future breaking change to the contract
- WHEN the route shape changes
- THEN the change lands under a new path version (`/v2`), leaving `/v1` intact

### Requirement: Contract Stability

The `/v1` contract MUST be documented with this change so the `openchamber-emulator-surface` change can implement against it without coupling to this repo's internals.

#### Scenario: Downstream implementation

- GIVEN the documented `/v1` contract shipped
- WHEN the OpenChamber surface change is built
- THEN it implements against the contract endpoints without changes to this repo

## Non-Goals

- No authentication beyond the localhost trust boundary
- No WebSocket/streaming endpoints (polling only)
- No proxying of MCP tools over HTTP

## Out of Scope

- Remote access (the surface is a local app)
- scrcpy-style streaming (deferred production path)
- Auth tokens, rate limiting, or multi-client coordination (design decisions if needed)

> **Design decision needed**: exact JSON field schema for `/v1/state`, error-body shape/status codes, and whether a shared-secret header is required even on localhost.
