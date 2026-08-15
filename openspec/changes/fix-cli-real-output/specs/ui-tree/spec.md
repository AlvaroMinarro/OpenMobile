# Delta for ui-tree

> Base: `openspec/changes/android-device-bridge/specs/ui-tree/spec.md` (the android-device-bridge UI Tree Specification). Main `openspec/specs/ui-tree/` is not yet populated — this change is unarchived, so this delta targets the per-change spec above.

## ADDED Requirements

### Requirement: Real CLI Layout Shape Tolerance

`toUiElement` MUST parse the real `android layout` element shapes — center as a string `"[x,y]"` and hyphenated keys (`resource-id`, `off-screen`) — in addition to the previously-assumed object shapes. Center MUST be parsed from a string `"[x,y]"` shape and MAY be parsed from an object `{x,y}` shape; hyphenated keys MUST be mapped (`resource-id` → id, `off-screen` → off-screen).

#### Scenario: String center with hyphenated keys

- GIVEN a real layout element with `center: "[640,1384]"`, `"resource-id"`, and `"off-screen"`
- WHEN `toUiElement` parses it
- THEN center is `{x:640,y:1384}` and the off-screen flag is honored

#### Scenario: Object center retained

- GIVEN an element with `center: {x:100,y:40}` and camelCase `offScreen`
- WHEN `toUiElement` parses it
- THEN it parses to the same result as before (object shapes remain accepted)

#### Scenario: Bounds-only element

- GIVEN an element with bounds but no center at all
- WHEN `toUiElement` parses it
- THEN center is derived from bounds midpoint as today

### Requirement: Spawn Timeout

The layout subprocesses (`android layout`, `adb uiautomator dump`) MUST be guarded by a timeout so a stuck spawn never blocks the tool indefinitely.

#### Scenario: Stuck layout spawn

- GIVEN a layout spawn that does not exit
- WHEN `get_ui_tree` is called
- THEN it returns an actionable error within the configured timeout instead of blocking

### Requirement: No Silent Fallback to (0,0) With Parseable Data

The element parser MUST NOT silently fall back to coordinates `(0,0)` when parseable center/bounds data is present; a fallback to `(0,0)` is allowed ONLY when the input genuinely provides neither parseable center nor bounds.

#### Scenario: Parseable string center wins

- GIVEN an element with `center: "[640,1384]"`
- WHEN `toUiElement` parses it
- THEN taps target `(640,1384)`, never `(0,0)`

#### Scenario: Unparseable center + no bounds

- GIVEN an element with neither a parseable center nor bounds
- WHEN `toUiElement` parses it
- THEN it MAY output `(0,0)` but MUST record the element as non-targetable so the input channel cannot tap it

## MODIFIED Requirements

### Requirement: Full UI Tree

The `get_ui_tree` tool MUST return the UI hierarchy as structured JSON — element bounds, center coordinates, interaction affordances, state, and off-screen flags — from the `android` CLI layout when available, falling back to parsed uiautomator XML.
(Previously: real CLI shape — string center, hyphenated keys — was not parsed, so every element collapsed to coordinates (0,0).)

#### Scenario: CLI layout succeeds

- GIVEN a native screen on the selected device
- WHEN `get_ui_tree` is called
- THEN it returns structured JSON with real, non-zero bounds and center coordinates for tappable elements

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

The `get_ui_tree_diff` tool MUST return only the changed elements since the diff baseline, using the CLI `layout --diff`; the baseline MUST be CLI-owned, and the server MUST NOT report a stale diff it cannot reconstruct. Elements inside `added`/`modified` MUST be parsed with the same real-CLI shape tolerance as the full tree.
(Previously: diff parsing assumed object center and camelCase keys, inheriting the same collapse-to-(0,0) bug; unmodified requirement otherwise unchanged.)

#### Scenario: First diff call

- GIVEN no prior diff baseline for the device
- WHEN `get_ui_tree_diff` is called
- THEN it establishes the baseline and returns either the full tree labeled as baseline or an explicit "baseline set" result

#### Scenario: Change detected

- GIVEN an established baseline and a UI change on screen
- WHEN `get_ui_tree_diff` is called
- THEN it returns only the changed elements, parsed with real coordinates

#### Scenario: Server restart

- GIVEN a server restart between diff calls
- WHEN `get_ui_tree_diff` is called
- THEN it re-establishes the baseline (no stale diff against pre-restart state)

## Non-Goals

- No semantic element analysis or accessibility-tree translation
- No server-persisted diff baselines or diff history
- No fixtures for shapes the CLI does not emit
