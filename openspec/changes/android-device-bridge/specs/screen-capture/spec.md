# Screen Capture Specification

## Purpose

Capture the device screen as a raw PNG, as an annotated PNG with numbered `#N` labels, and resolve those labels to tappable center coordinates — the agent's visual feedback channel.

## Requirements

### Requirement: Raw Screenshot

The `take_screenshot` tool MUST return PNG bytes of the selected device's screen via the `android` CLI capture, falling back to `screencap`; it MUST return an actionable error when the device is not usable.

#### Scenario: Capture succeeds

- GIVEN a selected device in state `device`
- WHEN `take_screenshot` is called
- THEN it returns valid PNG bytes

#### Scenario: CLI fails, adb fallback

- GIVEN the `android` CLI capture path failing
- WHEN `take_screenshot` is called
- THEN it returns PNG bytes via the `screencap` fallback

### Requirement: Annotated Screenshot

The `get_annotated_screen` tool MUST return a PNG with numbered label overlays (`#N`) plus the label-to-element mapping when the CLI provides it.

#### Scenario: Annotated capture

- GIVEN a screen with tappable elements
- WHEN `get_annotated_screen` is called
- THEN it returns the annotated PNG and a mapping of labels to elements

### Requirement: Resolve Screen Labels

The `resolve_screen_labels` tool MUST accept one or more `#N` labels and return each label's center coordinates; unknown or out-of-range labels MUST produce an actionable error listing valid labels.

#### Scenario: Resolve a valid label

- GIVEN an annotated screen with label `#3`
- WHEN `resolve_screen_labels "#3"` is called
- THEN it returns the center coordinates of element `#3`

#### Scenario: Unknown label

- GIVEN a label that does not exist on the current screen
- WHEN `resolve_screen_labels` is called with it
- THEN it returns an actionable error listing valid labels

## Non-Goals

- No video or streaming capture
- No OCR or image analysis
- No persistence of screenshots server-side

## Out of Scope

- Annotated capture when the device has no tappable content — the tool MAY return the raw PNG instead
- Label persistence across screens (labels are per-capture)
