# Deploy App Specification

## Purpose

Install and launch an application on the selected device with minimal agent context cost, preferring delta installs.

## Requirements

### Requirement: Install APK

The `deploy_app` tool MUST install a provided APK onto the selected device, preferring the `android` CLI delta install and falling back to `adb install`; it MUST surface actionable errors for signature mismatch, incompatible SDK level, and insufficient storage.

#### Scenario: Clean install

- GIVEN a valid APK and a selected device in state `device`
- WHEN `deploy_app` is called with the APK path
- THEN the APK is installed and success is reported

#### Scenario: Signature mismatch

- GIVEN an APK whose signature conflicts with the installed app
- WHEN `deploy_app` is called
- THEN it returns an actionable error naming the signature conflict

#### Scenario: CLI failure falls back to adb

- GIVEN the `android` CLI install path failing
- WHEN `deploy_app` is called
- THEN installation proceeds via the adb fallback

### Requirement: Launch Activity

When an activity is provided, `deploy_app` MUST launch it after installation; when omitted, it MUST install only and not launch.

#### Scenario: Launch after install

- GIVEN an APK and an activity name
- WHEN `deploy_app` is called
- THEN the activity is launched on the device

#### Scenario: Install only

- GIVEN an APK and no activity
- WHEN `deploy_app` is called
- THEN the app is installed and no launch attempt is made

### Requirement: Device Targeting

`deploy_app` MUST obey the shared device-selection rules and MUST fail with an actionable error when no usable device is selected.

#### Scenario: No device

- GIVEN no device attached
- WHEN `deploy_app` is called
- THEN it returns an error indicating no target device

## Non-Goals

- No Gradle builds from source inside the tool (project-directory builds are a design option, not required)
- No APK signing, keystore, or store deployment concerns

## Out of Scope

- App uninstall, update-channel logic, or multiple simultaneous installs
- Build-tooling configuration (SDK/NDK setup) — diagnostics only
