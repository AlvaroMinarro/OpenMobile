# Emulator Lifecycle Specification

## Purpose

Manage Android Virtual Devices — list, start, stop, create — through the `android` CLI so the agent can bring up a device when none is attached.

## Requirements

### Requirement: List AVDs

The `emulator_list` tool MUST return every AVD with its name and running status.

#### Scenario: Multiple AVDs

- GIVEN three AVDs exist, one running
- WHEN `emulator_list` is called
- THEN it returns all three with correct running/stopped status

### Requirement: Start AVD with Readiness Wait

The `emulator_start` tool MUST accept an AVD name (or default to the single AVD when exactly one exists), launch it, and wait until the device reaches state `device` or a bounded timeout, returning an actionable error on timeout.

#### Scenario: Launch and boot

- GIVEN AVD `Pixel_9_Pro` is stopped
- WHEN `emulator_start Pixel_9_Pro` is called
- THEN the emulator launches and the tool returns success only once the device state is `device`

#### Scenario: Boot timeout

- GIVEN an AVD that fails to boot within the bound
- WHEN `emulator_start` is called
- THEN it returns an error with the serial and last observed state

#### Scenario: Unknown AVD

- GIVEN an AVD name that does not exist
- WHEN `emulator_start` is called
- THEN it returns an actionable error listing available AVDs

### Requirement: Stop AVD

The `emulator_stop` tool MUST stop a running emulator identified by AVD name or serial and MUST report success only once the device is stopped.

#### Scenario: Stop running emulator

- GIVEN a running emulator
- WHEN `emulator_stop` is called
- THEN the device stops and is no longer listed as running

### Requirement: Create AVD

The `emulator_create` tool MUST create an AVD from a locally available system image and MUST reject duplicate names.

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

## Out of Scope

- Cold-boot vs snapshot-boot tuning, GPU/network configuration
- `android emulator remove` (create/remove pairs deferred unless needed)

> **Design decision needed**: define "ready" precisely — adb state `device` alone vs `sys.boot_completed=1`; and whether readiness is polled by the server or delegated to the CLI.
