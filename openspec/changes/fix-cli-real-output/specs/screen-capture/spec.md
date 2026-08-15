# Delta for screen-capture

> Base: `openspec/changes/android-device-bridge/specs/screen-capture/spec.md` (the android-device-bridge Screen Capture Specification). Main `openspec/specs/screen-capture/` is not yet populated — this change is unarchived, so this delta targets the per-change spec above. Attached here: W2 (spawn timeouts) and W3 (temp PNG hygiene) from the fix-cli-real-output review.

## ADDED Requirements

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

- No video or streaming capture
- No OCR or image analysis
- No server-side screenshot persistence (returned bytes are transmitted, temp files are ephemeral)