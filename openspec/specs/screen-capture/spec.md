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

The `get_annotated_screen` tool MUST return a PNG with numbered label overlays (`#N`) when the screen has tappable content; the label-to-element mapping in the response is deferred while no consumable CLI annotate payload exists.

#### Scenario: Annotated capture

- GIVEN a screen with tappable elements
- WHEN `get_annotated_screen` is called
- THEN it returns the annotated PNG with numbered labels

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

### Requirement: Polling as Fallback

The screenshot capture MUST remain fully functional when streaming is unavailable or disabled, so polling clients continue to work unchanged.

#### Scenario: Fallback without stream

- GIVEN `stream.supported: false` or `OPENMOBILE_STREAM=off`
- WHEN `GET /v1/screenshot` is requested
- THEN it returns 200 with `image/png` exactly as before streaming

#### Scenario: Capture failure while polling

- GIVEN no usable device
- WHEN `GET /v1/screenshot` is requested
- THEN it returns an error status with a JSON error body

### Requirement: Streaming Primary Path

When streaming is active, live interaction MUST use the WS stream rather than the screenshot endpoint; the screenshot endpoint remains available for stills and agent feedback.

#### Scenario: Live app uses stream

- GIVEN `stream.active: true`
- WHEN a live view renders the device
- THEN it renders from `WS /v1/stream/video` frames and does not rely on `/v1/screenshot` polling

#### Scenario: Stills still captured

- GIVEN an active stream
- WHEN the agent requests an annotated screenshot
- THEN `GET /v1/screenshot` still returns the PNG (stills are unaffected by streaming)

### Requirement: Unique Temp PNG Names

Every temporary PNG written to disk for capture MUST use a unique name (never a fixed path), so concurrent or same-millisecond captures cannot collide and overwrite each other.

#### Scenario: Same-ms collision avoided

- GIVEN two captures issued within the same millisecond
- WHEN both write temp PNG files
- THEN the two paths differ and each capture reads its own bytes

#### Scenario: Concurrent captures

- GIVEN two concurrent screenshot requests
- WHEN both are handled
- THEN each request reads its own unique temp file

### Requirement: Temp PNG Cleanup

The system MUST delete temporary capture PNGs after their bytes have been read, so temp files do not accumulate between calls.

#### Scenario: Cleanup after read

- GIVEN a screenshot request completes
- WHEN the PNG bytes are returned
- THEN the temp file is removed from disk

#### Scenario: Cleanup on failure

- GIVEN a screenshot request that fails after writing the temp file
- WHEN the failure is surfaced
- THEN the temp file is still removed

### Requirement: Spawn Timeout

The capture subprocesses (`android screen capture`, `adb shell screencap`, `adb pull`) MUST be guarded by a timeout so a stuck spawn never blocks the tool indefinitely.

#### Scenario: Stuck capture spawn

- GIVEN a capture spawn that does not exit
- WHEN `take_screenshot` is called
- THEN it returns an actionable error within the configured timeout instead of blocking

## Non-Goals

- No video or streaming capture through the screenshot endpoint (streaming lives on the WS surface)
- No OCR or image analysis
- No server-side screenshot persistence (returned bytes are transmitted, temp files are ephemeral)

## Out of Scope

- Annotated capture when the device has no tappable content — the tool MAY return the raw PNG instead
- Label persistence across screens (labels are per-capture)
- Label→element mapping in the annotated-capture response — the external CLI exposes no consumable annotate payload (no documented format, no recorded fixture); owned by future bridge work once upstream support exists. Per-label resolution stays available via `resolve_screen_labels`.