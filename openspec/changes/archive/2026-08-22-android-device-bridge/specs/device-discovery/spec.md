# Device Discovery Specification

## Purpose

Enumerate connected Android devices and their connection states, expose environment metadata, and resolve which device every other capability targets. One shared selection rule powers all tools.

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

The `get_device_info` tool MUST return device metadata — Android SDK level, screen size, density, model — via the `android` CLI when available, falling back to `getprop`/`wm` queries.

#### Scenario: CLI available

- GIVEN a selected device and the `android` CLI on PATH
- WHEN `get_device_info` is called
- THEN it returns structured SDK level, size, density, and model

#### Scenario: CLI unavailable

- GIVEN a selected device but no `android` CLI
- WHEN `get_device_info` is called
- THEN it still returns SDK level, size, and density via adb fallback

## Non-Goals

- No persistent device connections (lazy per-call resolution)
- No wireless pairing or authorization workflows
- No device management beyond listing and info

## Out of Scope

- Device flashing, factory reset, or system-app management
- Monitoring device state over time (the plugin polls; the server does not)
