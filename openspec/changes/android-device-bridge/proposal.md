# Proposal: android-device-bridge

An MIT MCP server (TS/Bun) exposing an Android device to a coding agent, a headless
OpenCode plugin closing the feedback loop, and a localhost bridge daemon — the seam
for the future OpenChamber surface (2nd change). First feature of OpenMobile (strategy #556).

## Intent

Agent-paced Android UI work needs a low-context feedback loop. Full uiautomator XML +
raw screencap is expensive/noisy; the new official `android` CLI (verified v1.0.15985488)
delivers flat JSON layout + `--diff`, annotated screenshots (`#N` labels), emulator
lifecycle, and delta install — a leaner agent contract for any coding agent.

## Scope

### In Scope
- MCP server (stdio, `@modelcontextprotocol/sdk` v1.29.x): `list_devices`, `get_device_info`, `emulator_list/start/stop/create`, `deploy_app`, `get_ui_tree`, `get_ui_tree_diff`, `take_screenshot`, `get_annotated_screen`, `resolve_screen_labels`, `read_logcat`, `tap/swipe/input_text/press_key` (~12).
- `src/device/` core (shared by MCP + bridge): `android` CLI wrapper (primary) + adb wrapper (fallback/input); `--device`/`ANDROID_DEVICE`/auto-detect selection; per-device serialization.
- Bridge daemon (`src/bridge/main.ts`): localhost HTTP JSON state + screenshot + input endpoints — the OpenChamber seam.
- Plugin (`src/plugin/`): `session.idle` + `tool.execute.after` → `session.prompt({noReply:true})` diff-mode push; compaction hook.
- Single Bun package, 3 entrypoints; `bun test` with in-memory adb + android-CLI runners; strict TDD on; MIT + README.

### Out of Scope
- OpenChamber Emulator surface = SEPARATE closely-coupled 2nd change (upstream PR).
- Streaming (scrcpy raw_stream + WebCodecs + control socket); MVP = polling via bridge.
- WebSocket/SSE MCP; monorepo split.

## Capabilities (all NEW — `openspec/specs/` empty)
- `device-discovery`, `emulator-lifecycle`, `deploy-app`, `ui-tree` (incl. `--diff`), `screen-capture` (annotate + resolve), `logcat-read`, `input-channel`, `agent-feedback-loop`, `local-bridge` (`/v1` contract).
- Modified: None.

## Approach

Single Bun package; device layer CLI-first, adb fallback, both behind `src/device/`.
MCP routes tools through the shared core; bridge reuses the core over localhost HTTP;
thin plugin only subscribes + pushes. TDD on scaffold, versioned fixtures.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Device layer | CLI-first, adb fallback | Structured JSON/`--diff`/annotate/lifecycle/deploy; adb = input, discovery, logcat, failure fallback |
| Packaging | Single Bun package | One lockfile, trivial CI; monorepo deferred until npm publish |
| MCP transport | stdio | What OpenCode local MCP consumes; in-memory transport eases TDD |
| Bridge in this change | Yes | Surface (2nd change) needs stable localhost contract to implement |
| Streaming | MVP polling | Tolerable agent latency; avoids scrcpy version-lock complexity |

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `package.json`/`bun.lock`/`tsconfig.json` | New | Bun package, 3 entrypoints |
| `src/device/` | New | android-CLI + adb wrappers, selection, serialization |
| `src/tools/` | New | ~12 MCP tool impls |
| `src/mcp-server.ts` | New | stdio server |
| `src/bridge/` | New | localhost daemon (state/screenshot/input) |
| `src/plugin/` | New | OpenCode plugin |
| `test/` | New | in-memory runners + fixtures |
| `opencode.json`/`.opencode/plugins/` | New | sample consumption |
| upstream `openchamber` | Not here | separate 2nd change/PR |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| android CLI churn / JSON key stability | High | Pin version, feature-detect, versioned fixtures, mandatory adb fallback |
| `layout` empty on WebView/animation | Med | Fall back to annotated screen + resolve, uiautomator last resort |
| Context bloat (~12 tools + pushes) | Med | Diff-mode trees + small snapshots, never full dumps |
| adb latency (input 100–500ms, uiautomator 0.5–1s) | Med | Retry + annotated fallback; document latency |
| MCP SDK / OpenCode API churn | Med | Pin SDK v1.29.x; pin plugin OpenCode version; isolate hooks |
| adb/CLI PATH / SDK resolution | Med | Startup diagnostics; surface CLI version in list_devices |

## Rollback Plan

Greenfield, no prod data — revert = delete package (no consumers). `src/device/` stays
pure so CLI-primary is a wrapper swap; bridge contract versioned (`/v1`) so a breaking
change is a path bump. No DB/migrations.

## Dependencies

- Android SDK (verified `/home/alvaro/Android/Sdk`) + `android` CLI v1.0.15985488 on PATH.
- `@modelcontextprotocol/sdk` pinned v1.29.x; OpenCode >= v1.18.16 (noReply + compaction hook).
- OpenChamber surface (2nd change) consumes the bridge contract shipped here.

## Success Criteria

- [ ] ~12 MCP tools over stdio, consumed by OpenCode local MCP.
- [ ] All tools CLI-first with working adb fallback; correct selection across 3 AVDs.
- [ ] `get_ui_tree_diff` returns only changed elements.
- [ ] `get_annotated_screen` + `resolve_screen_labels` yield tappable `#N` coords.
- [ ] Plugin pushes compact snapshots on idle/tool-execute and survives compaction.
- [ ] Bridge serves state JSON + PNG + input on localhost `/v1/*`.
- [ ] `bun test` green: unit (layout/XML parse, logcat-filter, bridge contract) + integration.
- [ ] MIT LICENSE + README present.