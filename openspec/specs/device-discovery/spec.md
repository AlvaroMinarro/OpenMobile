# Device Discovery Specification

## Purpose

Enumerate connected Android devices and their connection states, expose device metadata queried from the device over adb, and resolve which device every other capability targets. One shared selection rule powers all tools.

## Requirements

### Requirement: List Devices

The `list_devices` tool MUST return every connected device with its serial and connection state (`device`, `unauthorized`, `offline`), device model when resolvable, the list of available AVDs, and the detected `android` CLI version.

#### Scenario: Single attached device

- GIVEN one device attached in state `device`
- WHEN `list_devices` is called
- THEN it returns exactly one entry with serial, model, and state `device`
- AND includes the detected `android` CLI version

#### Scenario: No devices attached

- GIVEN no device attached
- WHEN `list_devices` is called
- THEN it returns an empty device list (not an error) plus the AVD list

#### Scenario: Unauthorized device

- GIVEN a device in state `unauthorized`
- WHEN `list_devices` is called
- THEN the device is listed with state `unauthorized` and a hint to accept the RSA prompt

### Requirement: Surface Connection States

The system MUST treat only state `device` as a usable target; `unauthorized` and `offline` devices MUST be surfaced in tool errors naming the serial, never silently skipped.

#### Scenario: Offline target

- GIVEN a selected serial in state `offline`
- WHEN any device tool is invoked
- THEN it returns an actionable error naming the serial and its state

### Requirement: Device Selection

Device selection MUST follow, in order: explicit `--device` argument, `ANDROID_DEVICE` environment variable, then single-device auto-detection. With multiple attached devices and no explicit selection, tools MUST fail listing all available serials.

#### Scenario: Explicit flag wins

- GIVEN two devices attached and `--device emulator-5554`
- WHEN a tool is invoked
- THEN it targets `emulator-5554`

#### Scenario: Ambiguous selection

- GIVEN two devices attached and no flag or env var
- WHEN a tool is invoked
- THEN it returns an error listing both serials

#### Scenario: Single device auto-detect

- GIVEN exactly one device attached
- WHEN a tool is invoked with no explicit selection
- THEN it targets that device

### Requirement: Device Info

The `get_device_info` tool MUST return device metadata — Android SDK level, screen size, density, model — from adb device property queries (`adb shell getprop`).

#### Scenario: SDK via getprop

- GIVEN a selected device with adb available
- WHEN `get_device_info` is called
- THEN it returns SDK level from `ro.build.version.sdk` on the device

#### Scenario: Screen properties

- GIVEN a selected device
- WHEN `get_device_info` is called
- THEN it returns screen size and density from adb property queries when available

### Requirement: Device Properties via adb

The device info source MUST be device properties queried through adb (`adb shell getprop`) — SDK level, model, screen properties — and MUST NOT derive device metadata from `android info`, which reports environment fields, not device state.

#### Scenario: SDK from device

- GIVEN a selected device in state `device`
- WHEN `get_device_info` is called
- THEN it returns the SDK level from `adb shell getprop ro.build.version.sdk` (device truth, not environment `android info`)

#### Scenario: Model property

- GIVEN a selected device
- WHEN `get_device_info` is called
- THEN the model is sourced from device properties when present

### Requirement: Spawn Timeout on Discovery Subprocesses

Every discovery subprocess (`adb devices`, `adb shell getprop`, and the `android` CLI wrapper) MUST be guarded by a timeout so a stuck spawn never blocks the tool indefinitely.

#### Scenario: Stuck discovery call

- GIVEN an adb or CLI spawn that does not exit
- WHEN `list_devices` or `get_device_info` is called
- THEN it returns an actionable error within the configured timeout instead of blocking

## Non-Goals

- No persistent device connections (lazy per-call resolution)
- No wireless pairing or authorization workflows
- No device management beyond listing and info

## Out of Scope

- Device flashing, factory reset, or system-app management
- Monitoring device state over time (the plugin polls; the server does not)
