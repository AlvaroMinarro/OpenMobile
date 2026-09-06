# Input Channel Specification

## Purpose

Inject touch, text, and key input into the selected device — the agent's action channel — via `adb shell input`.

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

## Non-Goals

- No multi-touch or gesture macro recording (adb `input` limitations)
- No IME-based text entry or clipboard injection

## Out of Scope

- Input replay scripting or coordinated multi-device input
- Coordinate transformation beyond range validation (density mapping is a design option)
