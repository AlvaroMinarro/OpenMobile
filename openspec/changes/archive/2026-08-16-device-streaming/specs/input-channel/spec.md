# Delta for Input Channel

> Base: `openspec/changes/android-device-bridge/specs/input-channel/spec.md` (the android-device-bridge Input Channel Specification). Main `openspec/specs/input-channel/` is not yet populated — this change is unarchived, so this delta targets the per-change spec above. This delta adds the control-socket fast path used while streaming and the polling fallback rule; `adb shell input` and the MCP tools remain unchanged.

## ADDED Requirements

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