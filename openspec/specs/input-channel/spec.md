# Input Channel Specification

## Purpose

Inject touch, text, and key input into the selected device — the agent's action channel — via `adb shell input` when polling and the scrcpy control socket when streaming.

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

### Requirement: Control Socket Input

While a stream is active, input MUST travel through the scrcpy control socket instead of `adb shell input`; the input MUST use the same coordinate semantics and range validation as the `tap`/`swipe`/`text` REST endpoints, and MUST produce an actionable error when injection fails.

#### Scenario: Tap through control socket

- GIVEN an active stream with a connected control channel
- WHEN a tap at coordinates `(x, y)` is sent
- THEN the tap is injected through the control socket and success is confirmed promptly

#### Scenario: Swing through control socket

- GIVEN an active stream with a connected control channel
- WHEN a swipe from `(x1, y1)` to `(x2, y2)` with a duration is sent
- THEN the swipe is injected through the control socket

#### Scenario: Out-of-range coordinates

- GIVEN coordinates beyond the device screen size
- WHEN a tap or swipe is sent to the control channel
- THEN an actionable error is returned stating the valid range

#### Scenario: Control injection failure

- GIVEN the control socket breaks while a stream is supposedly active
- WHEN an input event is sent
- THEN an actionable error is returned (never a silent drop)

### Requirement: Input Mode Selection

The system MUST choose the input channel by stream state: control socket when streaming, `adb shell input` when polling — and the selected device and offline/state rules from the base spec MUST apply to both modes.

#### Scenario: Streaming picks control socket

- GIVEN `stream.active: true` on the selected device
- WHEN an input event is issued
- THEN it is routed through the control socket

#### Scenario: Polling picks adb

- GIVEN `stream.active: false` on the selected device
- WHEN an input tool is called
- THEN it is routed through `adb shell input`

#### Scenario: Offline device in either mode

- GIVEN the selected device in state `offline`
- WHEN any input is attempted through either channel
- THEN it returns an actionable error naming the serial and state

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

- No multi-touch or gesture macro recording (control socket limitations)
- No IME-based text entry or clipboard injection

## Out of Scope

- Input replay scripting or coordinated multi-device input on the control channel
- Coordinate transformation beyond the existing range validation (density mapping is a design option)