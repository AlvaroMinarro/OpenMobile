# Logcat Read Specification

## Purpose

Expose filtered device logs to the agent with bounded output, keeping context cost low.

## Requirements

### Requirement: Filtered Log Read

The `read_logcat` tool MUST return logcat lines filtered by priority (default `*:E`), using `adb logcat -d -t N` with `-v time`; it SHOULD support package and PID scoping.

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

### Requirement: Live Log Stream

The bridge MUST provide a continuous logcat stream that pumps each new matching line to subscribed clients as it is produced, reusing the shared adb/logcat invocation helpers where practical. Streamed lines MUST carry per-line metadata (timestamp, priority, tag) and MUST be delivered only after any requested backlog replay completes.

#### Scenario: Live delivery without polling

- GIVEN a subscribed logcat stream client
- WHEN the device emits a line matching the active filters
- THEN the client receives that line without any polling request

#### Scenario: Backlog precedes live

- GIVEN a device log buffer holding at least 30 matching lines
- WHEN a client subscribes with `backlog: 30`
- THEN it receives exactly those 30 most-recent matching lines first, then live lines only

### Requirement: Stream Filter Subscription

Clients MUST subscribe by sending one JSON filter message after upgrade: `{tags?: string[], priority?: "V"|"D"|"I"|"W"|"E"|"F"|"S", backlog?: number}`. Matching MUST be: tag equals ANY subscribed tag (all tags when omitted or empty) AND priority at or above the subscribed floor (default `E`, consistent with `read_logcat`). Filters apply identically to backlog replay and live pumping. A malformed filter message MUST yield an actionable error frame followed by server-side close.

#### Scenario: Filter composition

- GIVEN a subscription `{tags:["ActivityManager","System.err"],priority:"W"}`
- WHEN lines arrive tagged `ActivityManager`(I), `System.err`(E), and `Canvas`(W)
- THEN the client receives exactly the `System.err`(E) line — tag union intersected with the priority floor

#### Scenario: Defaults apply

- GIVEN a subscription `{}` with no tags or priority
- WHEN lines arrive across mixed tags and priorities
- THEN the client receives all tags at priority `E` and above

#### Scenario: Malformed filter rejected

- WHEN the client sends `{"backlog":"many"}`
- THEN the server sends an actionable error frame and closes the socket

### Requirement: Bounded Backlog Replay

On subscription the server MUST replay the most recent N matching lines before going live, where N is the requested `backlog` clamped to `[0,1000]` and defaulting to 100 when omitted. Replay MUST respect the same filters as the live pump.

#### Scenario: Cap enforced on oversized backlog

- WHEN a client subscribes with `backlog: 5000`
- THEN replay is clamped to the server cap of 1000 lines and the stream proceeds normally

#### Scenario: Zero backlog skips replay

- WHEN a client subscribes with `backlog: 0`
- THEN no historical lines are delivered and live pumping starts immediately

### Requirement: Backpressure Drop-Oldest

When a consumer cannot keep up, the server MUST apply drop-oldest buffering — discarding the oldest undelivered matching lines rather than blocking the pump or growing memory unboundedly — consistent with the existing fanout precedent. The connection MUST stay open under backpressure; the server SHOULD report dropped-line counts opportunistically.

#### Scenario: Slow consumer stays connected

- GIVEN a subscriber that stops reading while the device emits rapidly
- WHEN its send buffer fills
- THEN the oldest queued lines are discarded, newest lines continue flowing, and the socket remains open

### Requirement: Stream Teardown

Client disconnect MUST tear down that subscriber's logcat source cleanly — subprocess readers stopped and nothing further buffered for the closed connection — leaving other subscribers unaffected and a fresh subscription fully functional. Device loss mid-stream MUST close the socket with an actionable reason identifying `device_lost` and the serial, never a silent hang.

#### Scenario: Close tears down cleanly

- GIVEN a live subscribed client
- WHEN the client closes the socket
- THEN the server stops reading/buffering for that client and a subsequent new subscription works independently

#### Scenario: Device loss mid-stream

- GIVEN a live subscribed client whose selected device detaches
- WHEN the logcat source dies
- THEN the server closes that socket with a `device_lost` reason naming the serial

## Non-Goals

- No log persistence or rotation
- Retiring the existing dump-and-tail requirements above (`read_logcat` remains poll-based shipped behavior; retirement is a future change — this capability ADDS the WS live stream only)
- Any HTTP GET tail/dump logcat route (streaming WS only)
- Multi-device fan-out from one subscription

## Out of Scope

- Log analysis or crash classification (the agent interprets)
- Historical logs across device reboots
