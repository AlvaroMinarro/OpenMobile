# Logcat Read Specification

## Purpose

Expose filtered device logs to the agent with bounded output, keeping context cost low.

## Requirements

### Requirement: Filtered Log Read

The `read_logcat` tool MUST return logcat lines filtered by priority (default `*:E`), using `adb logcat -v time`; it SHOULD support package and PID scoping.

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

#### Scenario: Overflowing buffer

- GIVEN a device log larger than the bound
- WHEN `read_logcat` is called
- THEN it returns at most N lines and notes the truncation

## Non-Goals

- No log persistence, rotation, or server-side buffering
- No real-time streaming subscription (poll-based reads)

## Out of Scope

- Log analysis or crash classification (the agent interprets)
- Historical logs across device reboots
