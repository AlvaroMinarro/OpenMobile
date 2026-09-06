# Delta for Local Bridge

> Base: `openspec/specs/local-bridge/spec.md`. All changes are ADDITIVE under
> `/v1`: five new route groups plus auth-gate hooks (specified in `bridge-auth`).
> Existing route semantics, the `{error:{code,message,details}}` body shape, and
> localhost-only binding are untouched. The former "no authentication beyond the
> localhost trust boundary" non-goal is superseded by opt-in `bridge-auth`
> (default-off preserves today's trust posture).

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Device State Endpoint

`GET /v1/state` MUST return JSON describing attached devices (serial, state), the selected device, running emulators, and a frame/layout summary. The reported selection MUST reflect the runtime selection override when one is active (see `device-discovery`) and MUST indicate its source so clients can distinguish override from tier-based resolution.
(Previously: selection was purely tier-resolved (`device` parameter / env / auto) with no HTTP-manageable runtime override.)

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

## Non-Goals

- `POST /v1/input/key` stays MCP-only — excluded from this change by maintainer decision
- No GET-style logcat tail/dump HTTP route in this change (streaming WS only)
- No rate limiting, no non-loopback binding, no async job queue for lifecycle routes
- No `/v2` policy; additive `/v1` only
