# Design: Fix Device Core Against Real CLI Output

## Technical Approach

Fixture-first hardening of `src/device/` against live-verified CLI v1.0.15985488 output (all shapes re-verified live during design on Pixel_9_Pro / emulator-5554). Record real outputs into `test/fixtures/`, write RED parser tests, fix parsers to green (strict TDD per config), and add per-spawn timeouts in `BunCommandRunner`. No changes to the locked `/v1` contract or MCP tool surface.

**Live-verified facts (2026-08-14):**
- `android layout` → flat JSON array; `center:"[640,1428]"` (string), `bounds:"[0,0][1280,2856]"` (string, sometimes absent), hyphenated `resource-id` / `content-desc`, numeric `key`, no `state`/`offScreen` keys. ~3.1s.
- `android layout --diff` → `{"added":[],"modified":[]}`.
- `android emulator list` → bare names, NO running marker even with a running AVD. `android emulator list --long` → table: `AVD ID | AVD Name | API Level | Status(Online|Offline) | Serial(emulator-5554 when Online)`.
- `android emulator start` blocks (~21s warm, CLI internal budget ~300s) and prints `Virtual device successfully started as 'emulator-5554'` → name→serial correlation.
- `adb logcat -d -t 4 -v time` → bounded dump, exits; line shape `08-14 01:08:11.009 D/Tag( 1028): msg` — current `priorityOf` regex (`/\s([VDIWEFSW])\s/`) does NOT match this.
- `getprop ro.build.version.sdk` → `36`; `android info` → environment fields only (confirms W1).
- `android screen capture` ~2.2s, 2.4MB PNG.

## Architecture Decisions

### D1: Per-operation spawn timeouts (W2)

**Choice**: Extend `CommandRunner.run(argv, opts?: { timeoutMs?: number })`. `BunCommandRunner` races `proc.exited` against a timer; on timeout it `proc.kill()`s and throws `SpawnTimeoutError { argv, timeoutMs }` (new export from `runner.ts`). Defaults live in one exported `SPAWN_TIMEOUTS` table in `runner.ts`; wrappers pass the per-op entry; optional per-call override wins. Handler-level `withTimeout` (outer budgets: readiness, deploy) stays — two distinct layers. MemoryRunner ignores `opts` (no breakage).

| Operation | Default ms | Rationale |
|---|---|---|
| `android layout [–diff]`, uiautomator dump/cat | 15_000 | live ~3.1s; 5× headroom |
| screen capture, screencap+pull | 30_000 | live ~2.2s but multi-MB PNG; slow devices |
| `adb logcat -d -t N` | 15_000 | bounded dump; guards stuck adb server |
| `adb devices`, `getprop`, `android info/version` | 10_000 | sub-second normally |
| input tap/swipe/text/keyevent | 10_000 | fast ops |
| `emulator list --long`, stop, create | 30_000 | CLI startup ~1–2s; stop flushes state |
| `emulator start` | 120_000 | D3 boot budget; CLI internal wait ~300s documented; `timeoutMs` arg overrides |
| install / run (deploy) | 120_000 | large APK push; existing `ctx.timeoutMs` |

**Surfacing**: `SpawnTimeoutError` propagates through `exec()`; `safe()` converts to actionable tool text (`"<cmd> timed out after Nms; retry or raise timeout"`). Bridge: caught as unknown → 500 INTERNAL with that message (contract-safe, no new status codes).

### D2: Fixture recording plan (cli-output-fixtures)

**Choice**: JSON-envelope fixtures under `test/fixtures/`, recorded by a script.

```json
{ "argv": ["android","layout","--device=emulator-5554"], "stdout": "...", "stderr": "", "exitCode": 0,
  "provenance": { "tool": "android", "version": "1.0.15985488", "capturedAt": "2026-08-14", "context": "Pixel_9_Pro API 36 home" } }
```

- **Mechanism**: `scripts/record-fixtures.ts` (bun task `bun run record-fixtures`) runs canonical commands via `BunCommandRunner` against a booted emulator and writes envelopes. Manual run, committed output — no CI recording.
- **Naming**: `test/fixtures/<tool>-<slug>.json`: `android-layout.json`, `android-layout-diff.json`, `android-emulator-list-long.json`, `adb-logcat-d-t.json`, `adb-devices-l.json`, `adb-getprop.json`.
- **Consumption**: new `test/helpers/fixtures.ts` → `loadFixture(name)` + `expectFixture(runner, name)` (feeds `MemoryRunner.expect`, playback keyed by exact argv — existing semantics).
- **Version pin**: envelope `provenance.version`; `test/fixtures/README.md` documents pin + re-record procedure. On CLI version change: re-run script, review diff, bump pin. A test asserts every fixture envelope carries provenance.

### D3: Dual-shape parsing (ui-tree)

**Choice**: Tolerant normalization in `toUiElement` + relaxed `detectDiffShape`.

- `center`: string `"[x,y]"` via `/\[(-?\d+)\s*,\s*(-?\d+)\]/`; else object `{x,y}`; else bounds midpoint; else `(0,0)` + `targetable:false`.
- `bounds`: string `"[l,t][r,b]"` (reuse `parseBounds`, exported from `serialize.ts`) or object form.
- Keys: `resource-id`→`resourceId?`, `content-desc`→`contentDesc?`, `off-screen`→`offScreen` (camelCase still accepted). `key` ignored (noted extension).
- `UIElement` gains optional `resourceId?`, `contentDesc?`, `targetable?` (sparse: only serialized when present/false). Unparseable element with parseable-looking data → `targetable:false`, never silently tappable at (0,0); no throw (one bad element must not kill the tree).
- `detectDiffShape`: diff if `added`/`modified` arrays; full if `bounds` or `center` key present; else unknown (real sparse elements lack `offScreen`/`state` keys).

### D4: Logcat bounded read

**Choice**: `adb -s S logcat -d -t N -v time [--pid P] [*:P]`; N = tail (default 100 from handler). Priority filtered natively via filterspec AND confirmed in-process with fixed regex `/\s([VDIWEFS])\//` (fallback legacy `/\s([VDIWEFS])\s/`). Output newest-first (existing reverse). `truncated` set when the server slices. `--------- beginning of main` headers carry no priority → dropped under a priority filter. Timeout (15s) → actionable error.

### D5: Emulator lifecycle

**Choice**: `emulatorList` switches to `android emulator list --long`; parse per line: first token = AVD ID (the name used by start/stop), `/^(Online|Offline)$/` = status, `/^emulator-\d+$/` = serial. `running = status === "Online"`; `AVD` gains `serial?`. Fixture-verified; old plain-list parsing removed (it can never report running). `emulatorStart` parses `started as '(emulator-\d+)'` from CLI stdout → returns serial; the handler polls `adb devices` for THAT serial reaching `device`. Fallback when stdout lacks the marker: diff pre-/post-start device lists for a new `emulator-*` serial. Never "first state=device device".

### D6: Device props

**Choice**: new `AdbWrapper.getprop(serial, prop)`; `getDeviceInfo` returns `{ serial, state, model: getprop ro.product.model (fallback devices -l), sdk: getprop ro.build.version.sdk, screenSize?: wm size, density?: wm density }` (screen fields best-effort, omitted when unavailable). `cli.info` for SDK dropped; `cli.version()` kept for `listDevices`.

### D7: Temp file hygiene (W3)

**Choice**: helper `tempPngPath(kind, serial)` → `/tmp/om-<kind>-<serial>-<Date.now()>-<rand6>.png` (rand from `crypto.randomUUID()`); `try/finally` `rm(path, { force: true })` after read — cleanup on failure too. `adb.screencap` device-side path also uniquified (`/sdcard/om_shot_<rand>.png`) + `adb shell rm` after pull.

## Data Flow

```
tool → handler → AndroidCli/AdbWrapper.exec → BunCommandRunner.run(argv,{timeoutMs})
       → SpawnTimeoutError? → safe() → actionable error
fixture tests: fixtures.ts → MemoryRunner.expect(argv) → parser under test
emulator start: CLI stdout "started as 'emulator-N'" → poll adb devices for THAT serial
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/device/runner.ts` | Modify | `run(argv, opts)`, `SpawnTimeoutError`, `SPAWN_TIMEOUTS` table, kill-on-timeout |
| `src/device/types.ts` | Modify | `UIElement` += `resourceId?/contentDesc?/targetable?`; `AVD` += `serial?` |
| `src/device/androidCli.ts` | Modify | D3 toUiElement, D5 `--long` list + start-serial parse, per-op timeouts |
| `src/device/adb.ts` | Modify | D4 logcat, D6 getprop, D7 screencap unique path + cleanup, timeouts |
| `src/device/serialize.ts` | Modify | export `parseBounds`, relax `detectDiffShape`, serialize new fields |
| `src/tools/handlers.ts` | Modify | D5 start correlation, D6 getDeviceInfo, D7 temp PNGs, logcat bound |
| `test/helpers/fixtures.ts` | Create | `loadFixture` / `expectFixture` |
| `test/fixtures/*.json` + `README.md` | Create | 6 envelopes, provenance pin v1.0.15985488 |
| `scripts/record-fixtures.ts`, `package.json` | Create/Modify | recording task |
| `test/androidCli.test.ts`, `adb.test.ts`, `tools.test.ts` | Modify | real shapes + fixture-backed tests |
| `test/runner.test.ts` | Create | timeout kill + SpawnTimeoutError (real `sleep` spawn) |

`src/bridge/server.ts`, `src/tools/context.ts`, MCP surface: unchanged.

## Interfaces / Contracts

```ts
// runner.ts
export class SpawnTimeoutError extends Error { argv: string[]; timeoutMs: number }
export interface CommandRunner { run(argv: string[], opts?: { timeoutMs?: number }): Promise<CommandResult> }
export const SPAWN_TIMEOUTS = { layout: 15_000, capture: 30_000, logcat: 15_000, query: 10_000,
  input: 10_000, lifecycle: 30_000, emulatorStart: 120_000, deploy: 120_000 } as const;
// types.ts additions
interface UIElement { resourceId?: string; contentDesc?: string; targetable?: boolean }
interface AVD { serial?: string }
// adb.ts
getprop(serial: string, prop: string): Promise<string>
// androidCli.ts
emulatorStart(name: string): Promise<string | null> // parsed serial when printed
```

## Testing Strategy

| Layer | What | How |
|-------|------|-----|
| Unit | toUiElement dual shapes, detectDiffShape, priorityOf, `--long` parse, temp-path uniqueness | fixture-backed (RED on pre-fix code) + hand-crafted for non-CLI shapes |
| Unit | timeout kill, SpawnTimeoutError fields | `runner.test.ts` with real `sleep` spawn, 50ms timeout |
| Integration | handlers: start correlation, getDeviceInfo getprop, screenshot cleanup | MemoryRunner + fixture playback; temp files in tmpdir |
| Live (manual, apply) | Pixel_9_Pro: tree has non-zero coords, list shows running, logcat returns | recorded as verify evidence |

## Migration / Rollout

No migration. `/v1` additive-only (`AVD.serial` allowed per D2 of base design). Revert fix commits to roll back.

**Size forecast**: ~600–900 changed lines incl. fixtures/tests → 400-line budget risk **High**; recommend chained PR slices (1: runner timeouts; 2: parsers + fixtures; 3: handlers/lifecycle/temp hygiene) — decision needed before apply.

## Open Questions

- None blocking. (Verified live; emulator left running for apply-phase checks.)
