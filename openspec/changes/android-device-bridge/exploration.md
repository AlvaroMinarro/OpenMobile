## Exploration: android-device-bridge (updated 2026-08-12 — complementary pass)

An MCP server (TypeScript/Bun) exposing an Android device to a coding agent,
plus a headless OpenCode plugin that closes the feedback loop (subscribe to
OpenCode events, push emulator state into agent context via
`session.prompt({noReply:true})`).

**Complementary update**: user brought two items IN SCOPE that the original
exploration marked out: (1) the new official `android` CLI as the PRIMARY
device-interface layer (adb as fallback), and (2) the OpenChamber "Emulator"
context-panel surface as an upstream PR. This revision keeps ALL prior findings
and integrates both. Research date: 2026-08-12. Sources: official MCP TS SDK
docs (v1.29.x), opencode.ai/docs (v1.18.16), mobile-next/mobile-mcp,
CursorTouch/Android-MCP, minhalvp/android-mcp-server, live `android` CLI
v1.0.15985488 (verified locally: `/usr/local/bin/android`, SDK at
/home/alvaro/Android/Sdk, 3 AVDs listed: Medium_Phone_API_36.1, Pixel_9_Pro,
Pixel_9_Pro_Fold; no devices currently attached), OpenChamber upstream source
(`packages/ui/src/lib/surfaces/registry.ts`,
`components/layout/ContextPanel.tsx`, `lib/surfaces/DOCUMENTATION.md`), prior
engram research obs #554/#555/#556/#557/#558.

### Current State

Greenfield repo: git initialized (branch main, zero commits), only `.atl/` and
`openspec/` exist. No package.json / tsconfig / src / tests yet. Stack planned:
TypeScript + Bun (bun test). strict_tdd is false until `bun test` is scaffolded.
No Android device bridge, no OpenCode plugin, no surface code exists today —
this is the first feature of OpenMobile (per strategy obs #556: bridge+plugin
feedback loop is build order step 1; the OpenChamber surface is step 2, a
separate change).

### Affected Areas

- `package.json` (new) — Bun package: bin entry for MCP server, exports for plugin
- `bun.lock` (new) — lockfile
- `tsconfig.json` (new) — strict TS config for Bun
- `src/mcp-server.ts` (new) — MCP server entry (stdio); routes tools CLI-first
- `src/device/` (new) — device-control core shared by BOTH the MCP server and the
  local bridge: `android` CLI wrapper (primary) + adb wrapper (fallback/input),
  per-device serialization, device selection (`--device` / `ANDROID_DEVICE` env /
  single-device auto-detect, multi-device error listing serials)
- `src/tools/` (new) — tool impls: uiautomator/layout, screencap, logcat, input,
  device-info, emulator lifecycle, deploy, diff
- `src/bridge/` (new) — localhost HTTP bridge daemon exposing device state +
  screenshot + input to the OpenChamber surface (MVP: shared core, small HTTP
  server serving JSON state + PNG + tap/swipe endpoints)
- `src/plugin/` (new) — headless OpenCode plugin: event hooks, state push, compaction
- `test/` (new) — bun test unit + integration (mock adb AND mock android CLI)
- `opencode.json` / `.opencode/plugins/` (new, sample) — consumption config + plugin load
- `README.md`, `LICENSE` (new, later bootstrap) — MIT
- Upstream (NOT in this repo): `openchamber` PR — `useUIStore.ts` (add
  `ContextPanelMode` + sanitizer whitelist), `surfaces/registry.ts` (descriptor),
  `ContextPanel.tsx` (mode dispatch + label + icon), every locale i18n dict,
  new `EmulatorView` component. Tracked as a separate closely-coupled change.

### Approaches

1. **MCP SDK: official `@modelcontextprotocol/sdk` (server package) + stdio**
   - `McpServer` + `registerTool` + `StdioServerTransport`; zod v4 input schemas.
   - Stdio is what OpenCode local MCP consumes (`"type": "local"`,
     `command: [...]`); mobile-mcp also defaults to stdio (SSE only via
     `--listen` opt-in).
   - Pros: reference implementation, documented, zero-config handshake, what
     every MCP client (incl. OpenCode) tests against; in-memory transport pair
     makes `bun test` unit-testing trivial.
   - Cons: none material for this use case.
   - Effort: Low.

   **Recommendation: option 1.** OpenCode consumption is stdio-local; the SDK's
   in-memory transport is ideal for strict TDD on tool handlers.

2. **KitMCP (kits.ai) / higher-level TS framework**
   - Pros: less boilerplate, batteries included.
   - Cons: younger ecosystem, smaller doc surface, less certainty OpenCode
     handles its transport edge cases; no benefit for a ~12 tool server.
   - Effort: Low (but riskier). **Rejected** — same reasons as before.

3. **Device layer hierarchy — `android` CLI primary, adb fallback (NEW)**
   - The new official Google `android` CLI (verified locally v1.0.15985488) is
     the PRIMARY device-interface layer:
     - `android emulator list|start|stop|create|remove` — AVD lifecycle
       (verified: list works against local SDK, 3 AVDs found)
     - `android layout` / `android layout --diff` — flat JSON UI tree with
       bounds/center/interactions/state/off-screen; `--diff` returns only
       changed elements since last invocation → minimal context for the agent
     - `android screen capture -o file.png` / `--annotate` (labeled bounding
       boxes) + `android screen resolve --screenshot file --string "#3"` →
       substitutes `#N` with the labeled element's center coordinates
     - `android run` (build+deploy+launch) / `android install` (incremental
       delta install, faster than adb) — deploy tool
     - `android info <field>` / `android describe` — environment + project
       metadata (note: `info` takes fields, not `--help`)
     - `--device=PARAM` serial flag is consistent across layout/screen/run —
       matches our `-s <serial>` adb scheme
   - adb stays as FALLBACK + the input channel: `adb shell input` for
     tap/swipe/text/keyevent (the CLI itself recommends this); `adb devices`
     for discovery/state; `adb logcat` for logs; `adb exec-out screencap -p`
     and `adb shell uiautomator dump` as fallbacks when the CLI path fails
     (layout returns empty on WebView/animation → fall back to annotated
     screenshot per user guidance; kept tools must not hard-depend on either).
   - Layer routing: MCP server tools call `android` first, catch typed failure,
     fall back to adb. Both wrappers live in `src/device/` and share device
     selection + per-device serialization.
   - Pros: CLI gives structured JSON (no XML parsing), diff mode slashes
     context tokens, annotated screenshots give the agent numeric labels to
     reference, AVD lifecycle + deploy without scripting raw emulator/install
     commands.
   - Cons: new tool (2025-2026, rapid churn), requires Android SDK
     (`--sdk=PARAM` / ANDROID_HOME), `layout` can fail on WebView/animation,
     JSON tree key stability not yet guaranteed across versions, no input
     primitives (adb stays for that).
   - Effort: Medium.

4. **Device feedback + control tool set (merged old + new)**
   - Structure (CLI-first → adb fallback):
     - `list_devices` — `android info` connected devices + `adb devices`
       (device/unauthorized/offline), AVD list from `android emulator list`
     - `get_device_info` — `android info`/`android describe` primary; getprop
       `ro.build.version.sdk`, `wm size`, `wm density` fallback (coordinate math)
     - `emulator_list` / `emulator_start` / `emulator_stop` / `emulator_create`
       (NEW — `android emulator ...`)
     - `deploy_app` (NEW — `android run` / `android install --use-delta-install`)
     - `get_ui_tree` — `android layout` JSON primary; uiautomator XML parse fallback
     - `get_ui_tree_diff` (NEW — `android layout --diff`, minimal context push)
     - `take_screenshot` — `android screen capture -o` primary; screencap fallback
     - `get_annotated_screen` (NEW — `android screen capture --annotate`) +
       `resolve_screen_labels` (NEW — `android screen resolve --string "#N"` →
       center coords the agent can tap)
     - `read_logcat` — `adb logcat -v time` filtered `*:E` + package pid scoping
     - `tap` / `swipe` / `input_text` / `press_key` — `adb shell input` (unchanged)
   - uiautomator dump quirks (slow ~500ms–1s, empty tree on some surfaces)
     carry over: retry + annotated-screen fallback replaces pure screencap
     fallback for layout failures.
   - Pros: agent gets structured labels it can reference verbally ("tap #3"),
     diff-mode context savings, lifecycle + deploy without adb scripting.
   - Cons: ~12 tools is more surface than the original ~8 → context bloat risk
     rises; more CLI surface to version-pin.
   - Effort: Medium.

5. **OpenCode plugin: event-driven feedback loop** (unchanged from original)
   - TS module in `.opencode/plugins/` or npm plugin key; hooks
     `session.idle` + `tool.execute.after` → refresh snapshot →
     `client.session.prompt({sessionID, prompt, noReply:true})`;
     `experimental.session.compacting` → `output.context.push(...)` persists
     device state across compaction. Plugin stays thin (subscribe + push);
     all device work stays in MCP.
   - Diff-mode consideration: feed `get_ui_tree_diff` results (not full trees)
     into pushes to fight context bloat.
   - Effort: Medium.

6. **OpenChamber "Emulator" surface — upstream PR (NEW, separate change)**
   - OpenChamber (8.5k★, MIT, React 19/Zustand): Context Panel surface system
     verified in upstream source: `ContextSurfaceDescriptor` {id, mode, icon,
     labelKey, availability: 'always'|'has-content', descriptionKey,
     defaultWidthFraction} in `lib/surfaces/registry.ts`; rendered by
     `ContextPanel.tsx`; existing surfaces: editor, git/PR, terminal,
     preview/browser, plan/notes. **Preview is the closest analog**
     (`availability: 'has-content'`, hosts live web content via iframe + proxy
     with token auth through runtimeFetch — the documented pattern for a
     localhost-driven surface).
   - Adding a surface = 4 documented steps (DOCUMENTATION.md):
     (1) add `ContextPanelMode` in `useUIStore` + sanitizer whitelist;
     (2) register descriptor in `registry.ts` (`has-content`, ~0.45 wf for an
     emulator pane); (3) render the mode in `ContextPanel.tsx` (content
     dispatch, label, icon — heavy views use `lazyWithChunkRecovery`);
     (4) add i18n keys to EVERY locale dictionary.
   - **Minimal viable streaming pipeline — periodic screenshot polling (MVP)**:
     surface polls a localhost bridge endpoint over HTTP for a PNG
     (`android screen capture` or screencap at ~0.5–1 fps), renders in an
     `<img>`/canvas; clicks map panel coords → device coords → POST to bridge →
     `adb shell input tap`. No WebCodecs, no scrcpy-server, works with the same
     `src/device/` core as the MCP server. Agent-paced work tolerates the
     latency.
   - **Production pipeline (deferred)**: scrcpy-server `raw_stream` H.264 +
     WebCodecs canvas + control socket via a local bridge daemon. High
     complexity, version-locked wire protocol, control-channel coordination —
     explicitly NOT part of the MVP.
   - **What the PR to OpenChamber actually contains**: the 4 registry steps +
     an `EmulatorView` React component (device picker, start/stop, canvas/img,
     tap/swipe capture) + i18n dictionaries. It must speak a generic localhost
     HTTP contract, NOT OpenMobile-specific code, to be acceptable upstream.
   - **What stays in OUR repo**: the local bridge daemon (`src/bridge/`)
     exposing device state (JSON: devices, selected, running, frame) +
     screenshot endpoint + input endpoints on localhost; and the strategy to
     reuse `src/device/` for both MCP and bridge. The surface gets device state
     from the BRIDGE (localhost HTTP), not from the MCP server directly (MCP is
     stdio agent-facing).
   - Pros: surface fits the documented registry pattern; no fork; Preview
     precedent proves the localhost-driven surface pattern.
   - Cons: upstream review friction (strict PR contract, automated AI review
     with `review:*` labels, evidence screenshots/recordings required, bus
     factor 1 lead maintainer, SDK pinned per release), i18n across all
     locales, PR is in a different repo so it can never share this change's PR.
   - Effort: Medium (MVP polling) / High (streaming).

7. **Project scaffolding: single Bun package, two entrypoints** (unchanged)
   - One `package.json`: `bin` → MCP server (stdio), `exports`/plugin path →
     plugin index; bridge daemon as a third entrypoint (`src/bridge/main.ts`,
     localhost HTTP). Same repo, same lockfile, one `bun install`, trivial CI.
   - Bun workspace monorepo deferred until independent npm publish is needed.
   - Effort: Low.

### Recommendation

Single Bun package (approach 7) shipping, with the device layer restructured
CLI-first (approach 3) and the tool set merged + extended (approach 4):

- **Layer hierarchy**: `android` CLI (primary) for layout/diff, screen
  capture/annotate/resolve, emulator lifecycle, deploy, info/describe; adb
  (fallback) for input (`adb shell input`), discovery/state, logcat, and CLI
  failure fallbacks. Both behind one `src/device/` core (shared by MCP server
  and local bridge), device selection `--device`/`ANDROID_DEVICE` env +
  single-device auto-detect, per-device serialization.
- **MCP server** (approach 1, stdio) exposing ~12 tools: `list_devices`,
  `get_device_info`, `emulator_list/start/stop/create` (NEW), `deploy_app`
  (NEW), `get_ui_tree` (CLI-first, XML fallback), `get_ui_tree_diff` (NEW),
  `take_screenshot` (CLI-first, screencap fallback), `get_annotated_screen`
  (NEW), `resolve_screen_labels` (NEW), `read_logcat`, `tap/swipe/input_text/
  press_key`.
- **Local bridge daemon** (approach 6, MVP slice): small localhost HTTP server
  on the same package sharing `src/device/` — JSON device state + screenshot
  endpoint + tap/swipe/text endpoints. This is the seam the OpenChamber surface
  consumes; it ships with THIS change so change 2 has a stable contract.
- **Headless OpenCode plugin** (approach 5): `session.idle` +
  `tool.execute.after` → push compact snapshot (prefer diff-mode output) via
  `session.prompt({noReply:true})`; compaction hook persists state.
- **OpenChamber surface = SEPARATE closely-coupled second change** (approach 6
  upstream): see Question 3 below.
- **Tests**: `bun test` with in-memory adb AND in-memory android-CLI runners
  (record/playback fixtures) so strict_tdd can flip on at scaffold time;
  unit tests for `layout` JSON parsing (versioned fixtures), uiautomator XML
  parsing, logcat filtering, bridge HTTP contract.

MIT license + README bootstrapped with the scaffold.

### Change boundary (Question 3)

**Recommendation**: the OpenChamber Emulator surface is a SEPARATE,
closely-coupled CHANGE — not part of android-device-bridge.

- PRs cannot span repos: this change's PR lands in OUR repo; the surface PR
  lands in openchamber upstream. They are structurally two PRs.
- Review budget: our 400-line budget is for OUR PR. The surface PR alone
  (EmulatorView + registry edits + i18n × all locales) is ~400+ lines upstream
  with its own strict review contract.
- Dependency order: the bridge+bridge-contract (this change) MUST exist first
  — the surface consumes the localhost bridge contract; there is nothing for
  the surface to render against today (no devices connected right now either).
- Risk isolation: CLI-first tooling churn (this change) stays away from
  upstream UI review friction; failures don't conflate.
- What makes them "closely coupled": this change defines the localhost bridge
  contract (state JSON shape, screenshot endpoint, input endpoints) that the
  surface implements later. Decide the contract now, implement the surface
  after verify/archive of this change.

### Risks

- **android CLI maturity (NEW)**: brand-new official tool (2025–2026),
  v1.0.15985488 verified locally but evolving fast — subcommand/flag drift,
  JSON tree key stability unproven, needs SDK present (`--sdk`/ANDROID_HOME;
  verified SDK at /home/alvaro/Android/Sdk). Mitigate: pin CLI version in
  diagnostics, feature-detect subcommands at startup, keep versioned fixtures
  for `layout` JSON parsing, keep adb fallbacks mandatory, surface CLI version
  in `list_devices`/`get_device_info`.
- **layout failure on WebView/animation (NEW)**: `android layout` can return an
  empty tree; per user guidance fall back to `android screen capture
  --annotate` + `resolve_screen_labels` (user can still reference `#N` labels),
  uiautomator XML as the last resort.
- **OpenChamber upstream review friction (NEW)**: strict PR contract, automated
  AI review (`review:*` labels), mandatory type-check/lint/build, evidence
  (screenshots/recordings) required for UI changes, bus factor 1 lead
  maintainer, SDK pinned per OpenCode release. Mitigate: follow
  DOCUMENTATION.md steps exactly, keep the surface PR minimal and generic
  (no OpenMobile-specific code), provide evidence, expect iteration.
- **Streaming pipeline complexity (NEW)**: WebCodecs + scrcpy-server
  raw_stream H.264 (version-locked protocol) + control socket is high-effort,
  high-risk scope creep. Mitigate: MVP = periodic screenshot polling via the
  bridge; streaming is explicitly out of scope for this change and deferred.
- **Context bloat (carried)**: bigger tool set (~12) + plugin pushes. Mitigate:
  diff-mode trees (`layout --diff`) for pushes and `get_ui_tree` results, small
  annotated snapshots, never full dumps.
- **adb latency (carried)**: `adb shell input` 100–500ms/event; uiautomator
  ~500ms–1s and can return empty trees. Mitigate: retry + annotated-screen
  fallback, document latency in tool descriptions.
- **Unauthorized/offline devices (carried)**: surface states as actionable tool
  errors (not crashes); lazy per-call resolution.
- **OpenCode API churn (carried)**: `session.prompt({noReply})` + compaction
  hook are young; pin the plugin to a specific OpenCode version, isolate hooks.
- **MCP SDK version drift (carried)**: pin exact version (v1.29.x); verify
  in-memory transport API at scaffold.
- **adb/CLI not on PATH (carried + NEW)**: clear startup diagnostics for both
  adb platform-tools and the `android` CLI (PATH + SDK resolution).

### Ready for Proposal

Yes — the merged scope is validated against the live `android` CLI (v1.0.15985488,
subcommands verified locally) and OpenChamber upstream source (registry +
DOCUMENTATION.md surface-add contract verified). For the proposal phase: single
Bun package, stdio MCP server with CLI-first device layer (~12 tools) + localhost
bridge daemon (the surface seam) + thin event-driven plugin, strict TDD on from
day one, MIT. The OpenChamber Emulator surface is a SEPARATE closely-coupled
change (its own upstream PR) building on the bridge contract shipped here. Flag
for proposal: CLILL version/SDK pinning, layout-failure fallback chain, and
OpenChamber upstream review friction.