# Delta for Screen Capture

> Base: `openspec/changes/android-device-bridge/specs/screen-capture/spec.md` (the android-device-bridge Screen Capture Specification). Main `openspec/specs/screen-capture/` is not yet populated — this change is unarchived, so this delta targets the per-change spec above. This delta adds the fallback contract: polling `/v1/screenshot` becomes the fallback live path when streaming is unavailable, and remains the only path for stills (annotated screenshots, agent feedback). Streaming is the primary live path.

## ADDED Requirements

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

## Non-Goals

- No video or streaming capture through the screenshot endpoint (streaming lives on the WS surface)
- No OCR or image analysis
- No server-side screenshot persistence