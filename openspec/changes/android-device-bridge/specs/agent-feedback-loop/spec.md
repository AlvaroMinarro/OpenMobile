# Agent Feedback Loop Specification

## Purpose

The headless OpenCode plugin that keeps the agent's context fresh with compact device-state snapshots — pushed on idle and after tool executions, and preserved across compaction — while guarding against context bloat.

## Requirements

### Requirement: Idle Snapshot Push

On the `session.idle` hook, the plugin MUST push a compact device snapshot via `session.prompt({noReply:true})`, preferring diff-mode tree output; it MUST NOT push when no device is selected.

#### Scenario: Idle with device

- GIVEN a selected device and an idle session
- WHEN the idle event fires
- THEN a compact snapshot (diff-preferred) is pushed into the session without triggering a reply

#### Scenario: No device selected

- GIVEN no usable device
- WHEN the idle event fires
- THEN no push is made

### Requirement: Post-Tool-Execution Push

On the `tool.execute.after` hook, the plugin MUST refresh the snapshot after device-affecting tools (input, deploy, lifecycle).

#### Scenario: Tap executed

- GIVEN a tap tool execution completed
- WHEN the tool.execute.after event fires
- THEN a refreshed compact snapshot is pushed

### Requirement: Context Bloat Guard

Pushes MUST use diff-mode or small snapshots, never full dumps, and MUST be rate-limited/deduplicated so bursts do not flood the session.

#### Scenario: Rapid successive tools

- GIVEN several device tool calls within a short window
- WHEN the events fire
- THEN at most one push is emitted for the burst

### Requirement: Compaction Persistence

On the `experimental.session.compacting` hook, the plugin MUST persist the current device state (via `output.context.push`) so it survives compaction.

#### Scenario: Compaction with device state

- GIVEN an active session about to compact
- WHEN the compacting hook fires
- THEN device state is carried into the compacted context

## Non-Goals

- No UI or user-facing controls (headless only)
- No tool registration by the plugin (device work stays in the MCP server)
- No push on every event — throttled

## Out of Scope

- MCP client logic inside the plugin beyond reading snapshots (snapshot source is a design decision)
- Multi-session fan-out or cross-session state sync

> **Design decision needed**: where the plugin reads snapshots from — calling MCP tools via the OpenCode SDK vs reading the local bridge `/v1/state`; and the throttle/dedupe window.
