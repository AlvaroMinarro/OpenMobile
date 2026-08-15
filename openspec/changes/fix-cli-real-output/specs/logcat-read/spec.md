# Delta for logcat-read

> Base: `openspec/changes/android-device-bridge/specs/logcat-read/spec.md` (the android-device-bridge Logcat Read Specification). Main `openspec/specs/logcat-read/` is not yet populated — this change is unarchived, so this delta targets the per-change spec above.

## ADDED Requirements

### Requirement: Dump-and-Tail Read

`read_logcat` MUST invoke adb in dump-and-tail mode — `adb logcat -d -t N` — instead of streaming continuously, so memory stays bounded and the call always returns.

#### Scenario: No streaming hang

- GIVEN a device producing continuous log output
- WHEN `read_logcat` is called
- THEN it returns the bounded tail and exits (never hangs)

#### Scenario: Bound applied server-side

- GIVEN a requested tail count
- WHEN `read_logcat` is called
- THEN the adb command carries `-d -t N` and the server filters to at most N lines

### Requirement: Spawn Timeout

The logcat subprocess MUST be guarded by a timeout so a stuck adb spawn never blocks the tool indefinitely.

#### Scenario: Stuck adb spawn

- GIVEN an adb spawn that does not exit
- WHEN `read_logcat` is called
- THEN it returns an actionable error within the configured timeout instead of blocking

## MODIFIED Requirements

### Requirement: Filtered Log Read

The `read_logcat` tool MUST return logcat lines filtered by priority (default `*:E`), using `adb logcat -d -t N` with `-v time`; it SHOULD support package and PID scoping.
(Previously: `adb logcat -v time` without `-d` streamed forever and buffered the full log.)

#### Scenario: Errors only

- GIVEN a device with mixed log levels
- WHEN `read_logcat` is called with no filter
- THEN it returns only priority E and above, newest first

#### Scenario: PID scoped

- GIVEN a running app with a known PID
- WHEN `read_logcat` is called scoped to that PID
- THEN it returns only that process's lines

### Requirement: Bounded Output

`read_logcat` MUST bound the number of returned lines (last-N) so output never grows unbounded, and MUST note when truncation occurred.
(Previously: bounding happened after buffering the full stream; now the adb side limits capture with `-t N` and the server still confirms the bound.)

#### Scenario: Overflowing buffer

- GIVEN a device log larger than the bound
- WHEN `read_logcat` is called
- THEN it returns at most N lines and notes the truncation

## Non-Goals

- No log persistence, rotation, or server-side buffering
- No real-time streaming subscription (poll-based reads)
