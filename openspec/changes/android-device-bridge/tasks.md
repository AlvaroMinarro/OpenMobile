# Tasks: android-device-bridge

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 2600–3200 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 → PR 3 → PR 4 |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Scaffold + device core | PR 1 | bun init flips strict_tdd; in-memory runners; tests+docs in |
| 2 | MCP tools + stdio server | PR 2 | ~12 tools routed through src/device/ |
| 3 | Bridge daemon | PR 3 | locks /v1 contract (unit 4's source) |
| 4 | Plugin + samples + docs | PR 4 | final /v1 README + verification |

## Phase 1: Foundation / Scaffold
- [x] 1.1 bun init → `package.json` (3 entrypoints: `bin/mcp-server`, `exports/plugin`, `src/bridge/main.ts`), `tsconfig.json`, `bun.lock`; pin `@modelcontextprotocol/sdk` v1.29.x; `test_command: bun test` enables strict_tdd
- [x] 1.2 Add MIT `LICENSE` + `README.md` scaffold (usage, latency notes, stub /v1 contract section)

## Phase 2: Device Core (`src/device/`)
- [x] 2.1 `src/device/androidCli.ts`: run / layout / `--diff`, capture / `--annotate`, screen resolve, emulator, install/run; version + feature-detect
- [x] 2.2 `src/device/adb.ts`: devices/state, logcat, screencap, uiautomator, shell input (input channel + fallback)
- [x] 2.3 `src/device/selection.ts`: `--device` > `ANDROID_DEVICE` > auto-detect; ambiguous error listing serials
- [x] 2.4 `src/device/serialize.ts`: UIElement→JSON, diff-shape detection, XML→tree parser
- [x] 2.5 `test/`: in-memory CLI + adb runners + fixtures; unit tests (selection precedence, XML→JSON, diff-shape, logcat filter → spec device-discovery, ui-tree, logcat-read)

## Phase 3: MCP Tools (`src/tools/` + `src/mcp-server.ts`)
- [ ] 3.1 tools: list_devices, get_device_info, emulator_list/start/stop/create, deploy_app
- [ ] 3.2 tools: get_ui_tree, get_ui_tree_diff (in-memory baselineEstablished per D1; never stale diff)
- [ ] 3.3 tools: take_screenshot, get_annotated_screen, resolve_screen_labels
- [ ] 3.4 tools: read_logcat, tap/swipe/input_text/press_key (retry-once on transient adb latency)
- [ ] 3.5 `src/mcp-server.ts`: stdio server registering ~12 tools; integration tests tool→device round trips

## Phase 4: Bridge Daemon (`src/bridge/`)
- [ ] 4.1 `src/bridge/server.ts` + `main.ts`: localhost-only HTTP `/v1/*` routes, state cache, error mapping (400/404/409/422/500), loopback bind
- [ ] 4.2 Contract tests per locked D2: GET /v1/state, GET /v1/screenshot, POST /v1/input/{tap,swipe,text} statuses + error bodies (`{error:{code,message,details?}}` → spec local-bridge)

## Phase 5: Plugin (`src/plugin/`)
- [ ] 5.1 hooks: `session.idle` + `tool.execute.after` → GET /v1/state → `session.prompt({noReply:true})`; debounce 2000ms + content-hash dedupe; skip when no selected device (D4)
- [ ] 5.2 `experimental.session.compacting` → `output.context.push`; E2E debounce/dedupe tests; sample `opencode.json` + `.opencode/plugins/`

## Phase 6: Verification / Docs
- [ ] 6.1 `bun test` + `bun build` green across unit/integration/E2E; finalize README /v1 contract reference

## Decisions / Blockers
- Live re-verify at apply: `layout --diff` output shapes + emulator-start vs `sys.boot_completed=1` (design Open Questions) — tests use in-memory doubles, so real CLI bob confirmed at apply.
- Chain strategy (stacked-to-main vs feature-branch-chain) — user decision before apply.
