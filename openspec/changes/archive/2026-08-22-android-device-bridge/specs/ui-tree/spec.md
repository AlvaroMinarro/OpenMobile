# UI Tree Specification

## Purpose

Provide the agent with the device's current UI hierarchy — as a full structured tree or a minimal change-diff — with CLI-first JSON and uiautomator XML fallback, always yielding coordinates usable by the input channel.

## Requirements

### Requirement: Full UI Tree

The `get_ui_tree` tool MUST return the UI hierarchy as structured JSON — element bounds, center coordinates, interaction affordances, state, and off-screen flags — from the `android` CLI layout when available, falling back to parsed uiautomator XML.

#### Scenario: CLI layout succeeds

- GIVEN a native screen on the selected device
- WHEN `get_ui_tree` is called
- THEN it returns structured JSON with bounds and centers for tappable elements

#### Scenario: CLI layout empty

- GIVEN a screen (e.g. WebView/animation) where the CLI returns an empty tree
- WHEN `get_ui_tree` is called
- THEN it signals the empty result explicitly (never a misleading success)
- AND it MAY retry once before reporting empty

#### Scenario: CLI unavailable

- GIVEN no `android` CLI but adb present
- WHEN `get_ui_tree` is called
- THEN it returns the parsed uiautomator XML as the tree

### Requirement: UI Tree Diff

The `get_ui_tree_diff` tool MUST return only the changed elements since the diff baseline, using the CLI `layout --diff`; the baseline MUST be CLI-owned, and the server MUST NOT report a stale diff it cannot reconstruct.

#### Scenario: First diff call

- GIVEN no prior diff baseline for the device
- WHEN `get_ui_tree_diff` is called
- THEN it establishes the baseline and returns either the full tree labeled as baseline or an explicit "baseline set" result

#### Scenario: Change detected

- GIVEN an established baseline and a UI change on screen
- WHEN `get_ui_tree_diff` is called
- THEN it returns only the changed elements

#### Scenario: Server restart

- GIVEN a server restart between diff calls
- WHEN `get_ui_tree_diff` is called
- THEN it re-establishes the baseline (no stale diff against pre-restart state)

## Non-Goals

- No semantic element analysis or accessibility-tree translation
- No server-persisted diff baselines or diff history

## Out of Scope

- UI mutation from the tree (input is a separate channel)
- Rendering the hierarchy as images

> **Design decision needed**: statelessness of `--diff` — confirm the CLI owns per-device diff state and define server behavior when the CLI cannot supply a baseline (full-tree fallback vs "baseline set" marker).
