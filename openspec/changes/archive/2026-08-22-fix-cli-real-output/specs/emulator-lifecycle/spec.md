# Delta for emulator-lifecycle

> Base: `openspec/changes/android-device-bridge/specs/emulator-lifecycle/spec.md` (the android-device-bridge Emulator Lifecycle Specification). Main `openspec/specs/emulator-lifecycle/` is not yet populated — this change is unarchived, so this delta targets the per-change spec above.

## ADDED Requirements

### Requirement: Real Running Markers

Running-detection for `emulator_list` MUST match the real `android emulator list` output markers, verified against recorded fixtures, rather than an assumed delimiter.

#### Scenario: Real list parsed

- GIVEN the recorded `android emulator list` fixture
- WHEN running status is computed
- THEN running/stopped matches the real CLI-reported state for every AVD

#### Scenario: No false negatives

- GIVEN a running emulator reported by the real CLI
- WHEN `emulator_list` is called
- THEN it MUST NOT report `running:false` for that emulator

### Requirement: Spawn Timeout on Lifecycle Subprocesses

Every emulator subprocess (`android emulator list/start/stop/create`, `adb devices`) MUST be guarded by a timeout so a stuck spawn never blocks the tool indefinitely.

#### Scenario: Stuck lifecycle spawn

- GIVEN an emulator subprocess that does not exit
- WHEN `emulator_list` or `emulator_start` is called
- THEN it returns an actionable error within the configured timeout instead of blocking

### Requirement: Start Confirms the Started Emulator

`emulator_start` MUST confirm the emulator it started — matching the requested AVD name or an emulator serial pattern — rather than returning the first device in state `device`.

#### Scenario: Named AVD started

- GIVEN a requested AVD `Pixel_9_Pro` among other devices
- WHEN it finishes booting
- THEN `emulator_start` returns a serial belonging to the STARTED emulator (by name or `emulator-*` pattern)

#### Scenario: Multi-device safety

- GIVEN another device already in state `device`
- WHEN `emulator_start` is invoked for a different AVD
- THEN it confirms the newly started emulator, not the already-attached device

#### Scenario: Start timeout

- GIVEN the started emulator never reaches readiness within the bound
- WHEN `emulator_start` times out
- THEN it returns an actionable error with the AVD name, serial, and last observed state

## MODIFIED Requirements

### Requirement: List AVDs

The `emulator_list` tool MUST return every AVD with its name and running status, using a running-marker parse verified against real CLI output.
(Previously: the parser assumed a leading `* ` delimiter; real output defeated it, reporting running emulators as stopped.)

#### Scenario: Multiple AVDs

- GIVEN three AVDs exist, one running
- WHEN `emulator_list` is called
- THEN it returns all three with correct running/stopped status

#### Scenario: Fixture-verified markers

- GIVEN the recorded `android emulator list` fixture
- WHEN `emulator_list` is called
- THEN the running AVD matches the real CLI-reported status

### Requirement: Start AVD with Readiness Wait

The `emulator_start` tool MUST accept an AVD name (or default to the single AVD when exactly one exists), launch it, wait until the started emulator reaches state `device` or a bounded timeout, and return an actionable error on timeout.
(Previously: it returned the first device in state `device`, which could be a different device under multi-device conditions.)

#### Scenario: Launch and boot

- GIVEN AVD `Pixel_9_Pro` is stopped
- WHEN `emulator_start Pixel_9_Pro` is called
- THEN the emulator launches and the tool returns success only once that emulator's device state is `device`

#### Scenario: Boot timeout

- GIVEN the started AVD fails to reach `device` within the bound
- WHEN `emulator_start` is called
- THEN it returns an error with the AVD name, serial, and last observed state

#### Scenario: Unknown AVD

- GIVEN an AVD name that does not exist
- WHEN `emulator_start` is called
- THEN it returns an actionable error listing available AVDs

### Requirement: Stop AVD

The `emulator_stop` tool MUST stop a running emulator identified by AVD name or serial and MUST report success only once the device is stopped.
(Unchanged behavior retained.)

#### Scenario: Stop running emulator

- GIVEN a running emulator
- WHEN `emulator_stop` is called
- THEN the device stops and is no longer listed as running

### Requirement: Create AVD

The `emulator_create` tool MUST create an AVD from a locally available system image and MUST reject duplicate names.
(Unchanged behavior retained.)

#### Scenario: Create from local image

- GIVEN a locally installed system image
- WHEN `emulator_create` is called with a new name
- THEN the AVD is created and appears in `emulator_list`

#### Scenario: Duplicate name

- GIVEN an AVD name that already exists
- WHEN `emulator_create` is called with that name
- THEN it returns an error and creates nothing

## Non-Goals

- No system image downloads (requires a locally installed image)
- No multi-emulator orchestration or snapshot management
- No fixture for quirks of CLI versions other than v1.0.15985488
