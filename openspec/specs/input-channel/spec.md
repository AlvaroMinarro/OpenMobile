# Input Channel Specification

## Purpose

Inject touch, text, and key input into the selected device — the agent's action channel — via the emulator's gRPC EmulatorController when available and `adb shell input` otherwise. (Synced from the `emulator-native-stream` delta at archive, 2026-09-06; the scrcpy control socket is removed.)

## Requirements

### Requirement: Tap

The `tap` tool MUST inject a tap at integer screen coordinates `(x, y)` on the selected device and SHOULD reject out-of-range coordinates with an actionable error when screen size is known.

#### Scenario: Tap within bounds

- GIVEN a selected device in state `device` and a known screen size
- WHEN `tap 540 1200` is called
- THEN a tap is injected at those coordinates and success is reported

#### Scenario: Tap out of range

- GIVEN coordinates beyond the device screen size
- WHEN `tap` is called with them
- THEN it returns an actionable error stating the valid range

### Requirement: Swipe

The `swipe` tool MUST inject a swipe from `(x1, y1)` to `(x2, y2)` with an optional duration.

#### Scenario: Swipe gesture

- GIVEN a scrollable screen
- WHEN `swipe 540 1800 540 600 300` is called
- THEN a swipe is injected over the given duration

### Requirement: Text Input

The `input_text` tool MUST inject text via `adb shell input`, escaping spaces and special characters; characters the adb channel cannot inject MUST produce an actionable error rather than silent corruption.

#### Scenario: ASCII text

- GIVEN a focused text field
- WHEN `input_text "hello world"` is called
- THEN the full string with spaces is typed into the field

#### Scenario: Unsupported characters

- GIVEN text with characters adb cannot inject
- WHEN `input_text` is called with it
- THEN it returns an actionable error identifying the unsupported characters

### Requirement: Key Press

The `press_key` tool MUST inject key events by keycode name (e.g., `back`, `enter`, `home`, `app_switch`).

#### Scenario: Key event

- GIVEN a running app
- WHEN `press_key "back"` is called
- THEN the back key event is injected

### Requirement: Focus-State Rules

All input tools MUST require a selected device in state `device`; offline or unauthorized targets MUST yield actionable errors. The channel SHOULD retry once on transient adb latency before failing.

#### Scenario: Offline device

- GIVEN the selected device in state `offline`
- WHEN any input tool is called
- THEN it returns an actionable error naming the serial and state

#### Scenario: Transient adb latency

- GIVEN adb input intermittently taking 100–500ms
- WHEN `tap` is called
- THEN the channel retries once and reports success on the second attempt

### Requirement: gRPC Input Injection

When the selected emulator exposes a usable gRPC EmulatorController, input MUST travel through gRPC unary calls (`sendTouch`/`sendKey`/`sendText`) instead of `adb shell input` or any control socket; injection MUST use device physical-pixel coordinates (no video-space scaling or mapping) with range validation against the device screen, and MUST produce an actionable error when injection fails.

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

### Requirement: Text Injection Consistency

Text input MUST keep the same injectability rules in both modes: characters the active channel cannot inject MUST produce an actionable error rather than silent corruption.

#### Scenario: Unsupported character while streaming

- GIVEN a focused text field and an active stream
- WHEN text with a character the channel cannot inject is sent
- THEN an actionable error identifies the unsupported character

#### Scenario: ASCII text while streaming

- GIVEN a focused text field and an active stream
- WHEN `"hello world"` is sent
- THEN the full string with spaces is typed into the field

## Non-Goals

- No multi-touch or gesture macro recording (channel limitation, carried over from the former control socket)
- No IME-based text entry or clipboard injection

## Out of Scope

- Input replay scripting or coordinated multi-device input on the control channel
- Coordinate transformation beyond the existing range validation (density mapping is a design option)