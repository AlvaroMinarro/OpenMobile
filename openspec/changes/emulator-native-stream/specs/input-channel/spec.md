# Delta for Input Channel

> Delta base: `openspec/specs/input-channel/spec.md` (archived 2026-08-16). Everything not listed here is frozen. `Tap`, `Swipe`, `Text Input`, `Key Press`, `Focus-State Rules`, and `Text Injection Consistency` are unchanged.

## ADDED Requirements

### Requirement: Control Without Stream

Input injection MUST work when no video stream is active: gRPC control is independent of any RtcStream, so REST `/v1/input/*` and the input tools MUST remain functional with `stream.active: false`. The stream state MUST NOT gate input; it only determines whether video frames exist.

#### Scenario: Input with video off

- GIVEN an emulator reachable via gRPC and no RtcStream active
- WHEN `POST /v1/input/tap` is called
- THEN the tap is injected via gRPC and 200 is returned

#### Scenario: Input before first viewer

- GIVEN a freshly launched emulator with no viewer ever connected
- WHEN an input tool is called
- THEN the input is injected without starting any RtcStream

## MODIFIED Requirements

### Requirement: gRPC Input Injection

When the selected emulator exposes a usable gRPC EmulatorController, input MUST travel through gRPC unary calls (`sendTouch`/`sendKey`/`sendText`) instead of `adb shell input` or any control socket; injection MUST use device physical-pixel coordinates (no video-space scaling or mapping) with range validation against the device screen, and MUST produce an actionable error when injection fails.
(Previously: input traveled through the scrcpy control socket while a stream was active, with scrcpy video-space coordinate translation.)

#### Scenario: Tap through gRPC

- GIVEN an emulator with gRPC reachable
- WHEN a tap at physical-pixel coordinates `(x, y)` is sent
- THEN the tap is injected via a unary TouchEvent and success is confirmed promptly

#### Scenario: Physical-pixel semantics

- GIVEN an active stream whose media resolution differs from the device's physical resolution
- WHEN a tap is sent using device physical-pixel coordinates
- THEN the emulator receives exactly those device coordinates (no video→device mapping is applied)

#### Scenario: Swipe through gRPC

- GIVEN an emulator with gRPC reachable
- WHEN a swipe from `(x1, y1)` to `(x2, y2)` with a duration is sent
- THEN the swipe is injected via gRPC

#### Scenario: Out-of-range coordinates

- GIVEN coordinates beyond the device screen size
- WHEN a tap or swipe is sent
- THEN an actionable error is returned stating the valid range

#### Scenario: Injection failure

- GIVEN gRPC unreachable or failing while input is attempted
- WHEN an input event is sent
- THEN an actionable error is returned (never a silent drop)

### Requirement: Input Mode Selection

The system MUST choose the input channel by backend capability, not stream state: gRPC unary when the selected emulator exposes a usable EmulatorController; `adb shell input` fallback otherwise (physical devices, gRPC unavailable or failed). The selected-device and offline/state rules from the base spec MUST apply to both modes.
(Previously: mode was chosen by stream state — scrcpy control socket when streaming, `adb shell input` when polling.)

#### Scenario: gRPC capable picks gRPC

- GIVEN an emulator with a usable gRPC EmulatorController
- WHEN an input event is issued
- THEN it is routed through gRPC unary regardless of stream state

#### Scenario: No gRPC falls back to adb

- GIVEN no usable gRPC surface (physical device or gRPC unavailable)
- WHEN an input tool is called
- THEN it is routed through `adb shell input`

#### Scenario: Offline device in either mode

- GIVEN the selected device in state `offline`
- WHEN any input is attempted through either channel
- THEN it returns an actionable error naming the serial and state

## REMOVED Requirements

(none)