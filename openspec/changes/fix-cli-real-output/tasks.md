# Tasks: Fix Device Core Against Real CLI Output

**Branch**: `fix/cli-real-output` FROM `feature/android-device-bridge` (PR #1 unmerged). Strict TDD (`bun test`); Pixel_9_Pro running for fixtures.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~600–900 (9 modified + 4 created, incl. fixtures/tests) |
| Suggested split | PR 1 timeouts → PR 2 fixtures+parsers → PR 3 handlers/hygiene |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High
Delivery strategy: ask-on-risk

### Suggested Work Units

| Unit | Goal | PR | Base |
|------|------|----|------|
| 1 | Spawn timeouts (D1) | PR 1 | `feature/android-device-bridge` |
| 2 | Fixtures + parsers (D2–D4, D5-list) | PR 2 | PR 1 branch |
| 3 | Handlers + lifecycle + hygiene (D5-start, D6, D7) | PR 3 | PR 2 branch |

## Phase 1: Runner Timeouts — PR 1 (D1; Spawn Timeout reqs, all 5 deltas)

- [x] 1.1 RED `test/runner.test.ts`: real `sleep` spawn killed at 50ms; assert `SpawnTimeoutError.argv/timeoutMs`; MemoryRunner ignores `opts`
- [x] 1.2 GREEN `src/device/runner.ts`: `run(argv, opts?)`, export `SpawnTimeoutError` + `SPAWN_TIMEOUTS` (per D1); race `proc.exited` vs timer + `proc.kill()`
- [x] 1.3 Wire `SPAWN_TIMEOUTS.*` into `androidCli.ts`/`adb.ts` exec calls; per-call override wins
- [x] 1.4 `bun test` green; commit `fix(device): add per-spawn timeouts to BunCommandRunner`

## Phase 2: Fixtures + Parsers — PR 2 (D2–D4, D5-list)

- [x] 2.1 Create `scripts/record-fixtures.ts` + `package.json` script; run vs Pixel_9_Pro; commit 6 envelopes + `test/fixtures/README.md` (pin v1.0.15985488, re-record procedure)
- [x] 2.2 Create `test/helpers/fixtures.ts`: `loadFixture`/`expectFixture` → `MemoryRunner.expect` by exact argv; provenance assertion test (spec: Recorded Real-Output Fixtures)
- [x] 2.3 RED `test/androidCli.test.ts`/`serialize.test.ts` from fixtures: string `center:"[x,y]"`, hyphenated `resource-id`/`content-desc`/`off-screen`, sparse keys, `--diff` shape (ui-tree: Shape Tolerance / Full Tree / Diff); MUST fail pre-fix
- [x] 2.4 GREEN: `serialize.ts` export `parseBounds`, relax `detectDiffShape`; `types.ts` `UIElement += resourceId?/contentDesc?/targetable?`; `androidCli.ts` `toUiElement` dual-shape, `targetable:false` fallback — no silent (0,0) tap (No Silent Fallback)
- [x] 2.5 RED→GREEN `test/adb.test.ts`: logcat `-d -t N -v time` bounded, priority regex `/\s([VDIWEFS])\//`, headers dropped under filter (logcat-read: Dump-and-Tail, Filtered, Bounded)
- [x] 2.6 RED→GREEN `emulatorList`: parse `emulator list --long` (Online/Offline, `AVD += serial?`); delete plain-list parse (spec: Real Running Markers, List AVDs)
- [x] 2.7 `bun test` green; commit `fix(device): parse real CLI output shapes with recorded fixtures`

## Phase 3: Handlers + Lifecycle + Hygiene — PR 3 (D5-start, D6, D7)

- [x] 3.1 RED `test/tools.test.ts` (MemoryRunner+fixtures): start polls THAT serial (never first `state=device`); `getDeviceInfo` via getprop; temp PNG unique + deleted (specs: Start Confirms Started Emulator, Device Properties via adb, Unique Temp PNG, Cleanup)
- [x] 3.2 GREEN `androidCli.ts` `emulatorStart`: parse `started as '(emulator-\d+)'` → serial (fallback: pre/post device-list diff); `handlers.ts` polls that serial to `device`
- [x] 3.3 GREEN `adb.ts` `getprop(serial, prop)`; `handlers.ts` `getDeviceInfo` model/sdk via getprop (+ `wm size/density` best-effort); drop `cli.info` SDK
- [x] 3.4 GREEN `tempPngPath(kind, serial)` (`crypto.randomUUID`), `try/finally rm(force)`; unique device-side screencap path + `adb shell rm`
- [x] 3.5 Live verify Pixel_9_Pro: `/v1/state` running:true, non-zero coords, logcat returns; `bun run typecheck` clean; commit `fix(tools): start correlation, getprop info, temp PNG hygiene`
