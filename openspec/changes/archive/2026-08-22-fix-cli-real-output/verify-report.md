```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:9b62f6043b56db65ce6a8f93a8bca103cfb113883f69fefe527a7d977019d8c6
verdict: pass
blockers: 0
critical_findings: 0
requirements: 28/28
scenarios: 60/60
test_command: bun test
test_exit_code: 0
test_output_hash: sha256:cc3523275ddd35e306735b5e748609aa059329b80ec1bcd0f6e9d32043fdbc3c
build_command: bun run typecheck
build_exit_code: 0
build_output_hash: sha256:8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92
```

## Verification Report

**Change**: fix-cli-real-output
**Version**: N/A (unarchived delta specs; base = android-device-bridge change specs)
**Mode**: Strict TDD

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total | 16 |
| Tasks complete | 16 |
| Tasks incomplete | 0 |

All tasks in `tasks.md` are checked ([x]): Phase 1 (4), Phase 2 (7), Phase 3 (5). This regeneration follows a completed fix round that closed the prior FAIL findings (version-pin assertion quality, 9 UNTESTED scenarios, PARTIAL rows) with a tests-only diff — production `src/` was left byte-identical for this round (verified at apply time via `cmp`). The working tree also carries unrelated in-flight work from later efforts (device-streaming/grpc); it was present in both prior and current runs.

### Build & Tests Execution
**Build**: ✅ Passed
```text
$ bun run typecheck
$ tsc --noEmit
exit code: 0 (no errors emitted)
```

**Tests**: ✅ 313 passed / ❌ 0 failed / ⚠️ 0 skipped
```text
$ bun test
bun test v1.4.0 (34cbb9a40)

 313 pass
 0 fail
 1035 expect() calls
Ran 313 tests across 21 files. [4.10s]
exit code: 0
```

Evidence digests: `evidence_revision` = SHA-256 over the concatenation of the exact `bun test` output bytes followed by the exact `bun run typecheck` output bytes; `test_output_hash` / `build_output_hash` = SHA-256 of each command's exact captured output. The build hash is byte-identical to the prior round because `tsc --noEmit` output is unchanged (`src/` untouched this round).

**Coverage**: ➖ Not available

### Spec Compliance Matrix

Requirements/scenarios re-counted directly from `openspec/changes/fix-cli-real-output/specs/*/spec.md`: cli-output-fixtures 3/11, device-discovery 6/12, emulator-lifecycle 7/14, logcat-read 4/6, screen-capture 3/5, ui-tree 5/12 = **28 requirements / 60 scenarios**.

Capability `cli-output-fixtures` (3 requirements / 11 scenarios):

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| Recorded Real-Output Fixtures | Fixtures present | `test/fixtures.test.ts > loads every recorded fixture and pins it to the CLI version` (loads all six envelopes: layout, layout --diff, emulator list --long, logcat -d -t, devices -l, getprop) | ✅ COMPLIANT |
| Recorded Real-Output Fixtures | Provenance | same test (`provenance?.version === FIXTURE_VERSION` for all six) + `test/fixtures.test.ts > loadFixture(dir) rejects missing provenance and accepts fresh envelopes from the same directory` + `test/fixtures/README.md` capture context | ✅ COMPLIANT |
| Recorded Real-Output Fixtures | Re-record procedure | `test/fixtures.test.ts > rejects a fixture pinned to a different CLI version via the production loader` (production `loadFixture` throws naming the recorded version, FIXTURE_VERSION, and the re-record escape hatch) + fresh-envelope-with-current-version acceptance + README-documented capture procedure | ✅ COMPLIANT |
| Fixture Coverage of Critical Shapes | Layout element shape | `test/fixtures.test.ts > loads the android layout fixture with the real CLI shape (string center, hyphenated keys, sparse)` + `test/androidCli.test.ts > maps hyphenated off-screen key to offScreen (dual-shape like center/resource-id)` (off-screen covered by unit test as spec allows) | ✅ COMPLIANT |
| Fixture Coverage of Critical Shapes | Diff shapes | `test/serialize.test.ts > classifies the recorded --diff envelope as diff ({added,modified})` | ✅ COMPLIANT |
| Fixture Coverage of Critical Shapes | Emulator list markers | `test/androidCli.test.ts > emulatorList() parses the recorded --long table: Online/Offline + serial` | ✅ COMPLIANT |
| Fixture Coverage of Critical Shapes | Logcat samples | `test/adb.test.ts > logcat() dumps a bounded tail (-d -t N) of the recorded real output` | ✅ COMPLIANT |
| Fixture-Backed Parser Tests | Layout parse regression | `test/androidCli.test.ts > layout() parses the recorded real CLI shape: string center/bounds, hyphenated keys, sparse JSON` (non-zero coords for every element; pre-fix failure established by live-run evidence C1 in proposal/design) | ✅ COMPLIANT |
| Fixture-Backed Parser Tests | Emulator running regression | `test/androidCli.test.ts > emulatorList() reads the AVD ID column as the name (spaces only in the display name)` (+ previous row; pre-fix failure established by C3) | ✅ COMPLIANT |
| Fixture-Backed Parser Tests | Diff regression | `test/androidCli.test.ts > layoutDiff() parses the recorded real --diff shape (added/modified arrays)` | ✅ COMPLIANT |
| Fixture-Backed Parser Tests | Logcat regression | `test/adb.test.ts > logcat() filters by priority on the real line shape (P/Tag, no trailing space)` + `logcat() drops buffer headers under a priority filter` | ✅ COMPLIANT |

Capability `device-discovery` (6 requirements / 12 scenarios):

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| Device Properties via adb | SDK from device | `test/tools.test.ts > reports SDK/model from getprop with best-effort screen metrics` (sdk "36" via `ro.build.version.sdk`) | ✅ COMPLIANT |
| Device Properties via adb | Model property | same test (model via `ro.product.model`, fallback to `devices -l` model) | ✅ COMPLIANT |
| Spawn Timeout on Discovery Subprocesses | Stuck discovery call | `test/tools.test.ts > list_devices surfaces a stuck discovery spawn within the configured timeout` (TimeoutRunner double → handler returns `isError:true`, "adb devices -l timed out after 10000ms", retry hint; scenario's WHEN is disjunctive — list_devices proven end-to-end, get_device_info shares the identical guarded-spawn wiring) | ✅ COMPLIANT |
| List Devices | Single attached device | `test/tools.test.ts > returns devices, AVDs and CLI version` (serial/model/state + cliVersion) | ✅ COMPLIANT |
| List Devices | No devices attached | `test/tools.test.ts > returns an empty device list (not an error) when nothing is attached` | ✅ COMPLIANT |
| List Devices | Unauthorized device | `test/tools.test.ts > lists an unauthorized device with a hint to accept the RSA prompt` (state `unauthorized` + RSA hint asserted) | ✅ COMPLIANT |
| Surface Connection States | Offline target | `test/tools.test.ts > tap refuses an offline device with an actionable error naming serial and state` | ✅ COMPLIANT |
| Device Selection | Explicit flag wins | `test/selection.test.ts > prefers the explicit --device argument over env and auto-detect` | ✅ COMPLIANT |
| Device Selection | Ambiguous selection | `test/selection.test.ts > fails ambiguously listing every serial when multiple devices and no selection` | ✅ COMPLIANT |
| Device Selection | Single device auto-detect | `test/selection.test.ts > auto-detects the single attached device when nothing else selects` | ✅ COMPLIANT |
| Device Info | SDK via getprop | `test/tools.test.ts > never calls 'android info' for device metadata` + `reports SDK/model from getprop...` | ✅ COMPLIANT |
| Device Info | Screen properties | `test/tools.test.ts > degrades gracefully when wm metrics or props are unavailable` (best-effort, omitted when absent) | ✅ COMPLIANT |

Capability `emulator-lifecycle` (7 requirements / 14 scenarios):

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| Real Running Markers | Real list parsed | `test/androidCli.test.ts > emulatorList() parses the recorded --long table: Online/Offline + serial` (fixture-backed) | ✅ COMPLIANT |
| Real Running Markers | No false negatives | same test — Pixel_9_Pro reported `running:true` against real output that previously defeated the parser | ✅ COMPLIANT |
| Spawn Timeout on Lifecycle Subprocesses | Stuck lifecycle spawn | `test/tools.test.ts > emulator_list surfaces a stuck lifecycle spawn instead of blocking` ("android emulator list --long timed out after 30000ms"; scenario WHEN disjunctive — emulator_list proven end-to-end) | ✅ COMPLIANT |
| Start Confirms the Started Emulator | Named AVD started | `test/tools.test.ts > polls the serial named in the CLI 'started as' marker, ignoring an already-attached device` (returns emulator-5554) | ✅ COMPLIANT |
| Start Confirms the Started Emulator | Multi-device safety | same test — other device emulator-5556 already in state `device`; tool returns emulator-5554, NOT 5556 | ✅ COMPLIANT |
| Start Confirms the Started Emulator | Start timeout | `test/tools.test.ts > returns an actionable error when the started serial never reaches 'device'` (+ refusal when no serial can be correlated) | ✅ COMPLIANT |
| List AVDs | Multiple AVDs | `test/tools.test.ts > returns every AVD with running status` (three AVDs, one running) | ✅ COMPLIANT |
| List AVDs | Fixture-verified markers | `test/androidCli.test.ts > emulatorList() reads the AVD ID column as the name` (recorded fixture) | ✅ COMPLIANT |
| Start AVD with Readiness Wait | Launch and boot | `test/tools.test.ts > starts the single AVD (no name) and waits for the reported serial to reach 'device'` | ✅ COMPLIANT |
| Start AVD with Readiness Wait | Boot timeout | `test/tools.test.ts > returns an actionable error when the started serial never reaches 'device'` (AVD name + serial + last observed state) | ✅ COMPLIANT |
| Start AVD with Readiness Wait | Unknown AVD | `test/tools.test.ts > returns an error naming the unknown AVD and listing the available ones` (names Ghost_AVD + lists Pixel_9_Pro; `assertSatisfied()` proves no start was ever issued) | ✅ COMPLIANT |
| Stop AVD | Stop running emulator | `test/tools.test.ts > stops a running emulator which is then no longer listed as running` (+ companion `refuses success while the emulator is STILL listed as running after the stop command`) | ✅ COMPLIANT |
| Create AVD | Create from local image | `test/tools.test.ts > creates an AVD that then appears in emulator_list (Create-from-local-image spec)` (create → next listing contains Fresh_AVD through real handlers) | ✅ COMPLIANT |
| Create AVD | Duplicate name | `test/tools.test.ts > rejects a duplicate AVD name and creates nothing` ("already exists" + `assertSatisfied()` proves create never issued) | ✅ COMPLIANT |

Capability `logcat-read` (4 requirements / 6 scenarios):

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| Dump-and-Tail Read | No streaming hang | `test/adb.test.ts > logcat() dumps a bounded tail (-d -t N) of the recorded real output` (bounded dump exits; `-d` structural) + `test/runner.test.ts` kill-on-timeout proof | ✅ COMPLIANT |
| Dump-and-Tail Read | Bound applied server-side | `test/adb.test.ts > logcat() scopes to a pid, defaults to errors-only, and bounds + notes truncation` (exact argv carries `-d -t 100`) + `truncates to the tail bound and flags it` (server-side slice ≤ N) | ✅ COMPLIANT |
| Spawn Timeout | Stuck adb spawn | `test/tools.test.ts > read_logcat surfaces a stuck logcat dump instead of blocking` ("logcat -d ... timed out after 15000ms") | ✅ COMPLIANT |
| Filtered Log Read | Errors only | `test/tools.test.ts > with NO filter it defaults to errors-only (E) and returns them newest first` (handler executes `priority ?? "E"` — argv carries default `E:*`; only E lines returned, newest first) + explicit-W override companion | ✅ COMPLIANT |
| Filtered Log Read | PID scoped | `test/adb.test.ts > logcat() scopes to a pid, defaults to errors-only, and bounds + notes truncation` (`--pid 1234` argv + pid-scoped lines) | ✅ COMPLIANT |
| Bounded Output | Overflowing buffer | `test/adb.test.ts > logcat() truncates to the tail bound and flags it` (3 lines → last 2, `truncated:true`, newest-first) | ✅ COMPLIANT |

Capability `screen-capture` (3 requirements / 5 scenarios):

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| Unique Temp PNG Names | Same-ms collision avoided | `test/tools.test.ts > tempPngPath() returns unique, sanitized, serial-bearing names per call` (`a !== b`, pattern `/tmp/om-shot-emulator-5554-\d+-\w{6}\.png`) | ✅ COMPLIANT |
| Unique Temp PNG Names | Concurrent captures | `test/tools.test.ts > two CONCURRENT captures each read their own unique temp file bytes (no cross-talk)` (Promise.all pair; distinct bytes; each path read exactly once; both temps removed) | ✅ COMPLIANT |
| Temp PNG Cleanup | Cleanup after read | `test/tools.test.ts > takeScreenshot reads its temp file THEN deletes it (file gone after result)` (`existsSync(shotPath) === false`) | ✅ COMPLIANT |
| Temp PNG Cleanup | Cleanup on failure | `test/tools.test.ts > cleans up the temp file even when the read throws` (file removed despite read explosion) | ✅ COMPLIANT |
| Spawn Timeout | Stuck capture spawn | `test/tools.test.ts > take_screenshot surfaces a stuck capture spawn (through the adb screencap fallback)` (CLI capture and screencap fallback both time out; actionable "screencap ... timed out after 30000ms" reaches the caller) | ✅ COMPLIANT |

Capability `ui-tree` (5 requirements / 12 scenarios):

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| Real CLI Layout Shape Tolerance | String center with hyphenated keys | `test/androidCli.test.ts > layout() parses the recorded real CLI shape...` (center `{x:640,y:1428}` from string; `resource-id` mapped) + `maps hyphenated off-screen key to offScreen` | ✅ COMPLIANT |
| Real CLI Layout Shape Tolerance | Object center retained | `test/androidCli.test.ts > layout() targets a device via --device=<serial> and returns parsed elements` (object `{x,y}` shape unchanged) | ✅ COMPLIANT |
| Real CLI Layout Shape Tolerance | Bounds-only element | `test/androidCli.test.ts > derives center from the bounds midpoint when an element has string bounds but no center` + `derives center from the bounds midpoint for OBJECT-shaped bounds without a center too` (midpoint `{x:200,y:300}` / `{x:60,y:70}`, stays targetable) | ✅ COMPLIANT |
| Spawn Timeout | Stuck layout spawn | `test/tools.test.ts > get_ui_tree surfaces a stuck layout spawn instead of blocking` (hung `android layout` falls back to the XML path; the stuck `uiautomator dump` — sharing SPAWN_TIMEOUTS.layout — surfaces "timed out after 15000ms") | ✅ COMPLIANT |
| No Silent Fallback to (0,0) With Parseable Data | Parseable string center wins | `layout() parses the recorded real CLI shape...` — loop asserts NO element collapses to `{x:0,y:0}`; workspace taps at (640,1428) | ✅ COMPLIANT |
| No Silent Fallback to (0,0) With Parseable Data | Unparseable center + no bounds | `test/androidCli.test.ts > marks elements with neither parseable center nor bounds as non-targetable (never silent (0,0))` (`targetable:false` asserted) + `unparseable center still falls back to parseable bounds and keeps the element targetable` (midpoint rescue variance) | ✅ COMPLIANT |
| Full UI Tree | CLI layout succeeds | `test/tools.test.ts > returns the CLI layout tree when the CLI answers with content` (real non-zero coords, `assertSatisfied()` proves uiautomator never touched) + wrapper fixture parse + JSON serialization | ✅ COMPLIANT |
| Full UI Tree | CLI layout empty | `test/tools.test.ts > signals empty explicitly when BOTH the CLI layout and the XML dump are empty` (`empty:true`, `tree:[]`) + `falls back to parsed uiautomator XML when the CLI layout is empty` (XML rescues, not a false empty) | ✅ COMPLIANT |
| Full UI Tree | CLI unavailable | `test/tools.test.ts > returns the parsed uiautomator XML as the tree when the android CLI is unavailable` (CLI exits 1 "command not found" → XML fallback delivered, `isError:false`) | ✅ COMPLIANT |
| UI Tree Diff | First diff call | `test/tools.test.ts > first call in a process establishes a baseline and returns a full tree` | ✅ COMPLIANT |
| UI Tree Diff | Change detected | `test/tools.test.ts > later calls use --diff and return only changed elements` (parsed via dual-shape `toUiElement`) | ✅ COMPLIANT |
| UI Tree Diff | Server restart | `test/tools.test.ts > a fresh context re-establishes the baseline (no stale diff after restart)` + `when --diff falls back to a full tree it reports baseline re-set` | ✅ COMPLIANT |

**Compliance summary**: 60/60 scenarios compliant (0 ⚠️ PARTIAL, 0 ❌ UNTESTED)

### TDD Compliance
| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | Engram apply-progress artifact (`sdd/fix-cli-real-output/apply-progress`) contains a complete TDD Cycle Evidence table covering all fix-round tasks |
| All tasks have tests | ✅ | 16/16 tasks map to existing suites (runner/androidCli/adb/serialize/selection/fixtures/tools verified on disk); fix-round files: `fixtures.test.ts`, `helpers/fixtures.ts`, `androidCli.test.ts`, `tools.test.ts`, new `helpers/timeoutRunner.ts` |
| RED confirmed (tests exist) | ✅ | All covering test files exist and execute; apply-progress records mutation-proofs for 7 of 8 test-bearing tasks (pin-check disabled, wrappers swallowing timeouts, midpoint broken, targetable flag removed, stop guard disabled, logcat default removed — each failed then restored); 2 rows are composition covering-tests verified green |
| GREEN confirmed (tests pass) | ✅ | 313/313 pass on the current tree including every new covering test |
| Triangulation adequate | ✅ | Bounds string vs object shapes; non-targetable vs rescued-targetable variance; stop success vs still-running refusal; default-E vs explicit-W override; stale-pin vs missing-provenance vs fresh-load rejection matrix |
| Safety Net for modified files | ✅ | Per-task baseline runs recorded (file-level suites plus 298/0 full-suite before modification; suite ended 313/0) |

**TDD Compliance**: 6/6 checks passed

---

### Test Layer Distribution
| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | 72 | 6 | bun:test (MemoryRunner double; BunCommandRunner real-spawn for kill proofs) |
| Integration | 54 | 1 | bun:test (tools.test.ts handlers; MemoryRunner fixture playback + TimeoutRunner double for end-to-end surfacing) |
| E2E | 0 | 0 | not installed |
| **Total** | **126** | **7** | |

Change-related files: `test/runner.test.ts` (11), `test/androidCli.test.ts` (20), `test/adb.test.ts` (18), `test/serialize.test.ts` (11), `test/selection.test.ts` (5), `test/fixtures.test.ts` (7), `test/tools.test.ts` (54). Only `bun:test` is used — consistent with detected capabilities; no cross-layer tool warning.

---

### Changed File Coverage
Coverage analysis skipped — no coverage tool detected.

---

### Assertion Quality
✅ All assertions verify real behavior. Audit of every file touched this round found zero tautologies, ghost loops, type-only assertions, or assertions without production-code calls:
- `fixtures.test.ts` version-pin tests invoke production `loadFixture(name, dir)` against temp directories and assert the throw message names BOTH the recorded version and FIXTURE_VERSION plus the re-record escape hatch (prior CRITICAL cleared).
- Stuck-spawn e2e asserts exact `SPAWN_TIMEOUTS` values surfaced inside actionable errors (10000/30000/15000/30000/15000ms) — the TimeoutRunner double rejects with the REAL `SpawnTimeoutError`, so wrapper/handler code genuinely executes.
- Midpoint/targetable tests assert concrete coordinates and flag values; concurrent-capture asserts distinct bytes, exactly-one-read-per-path, and cleanup.
Prior-round WARNING (misleading `emulatorCreate` smoke-test name) is resolved: replaced by dedicated rejection and appears-in-list behavioral tests.

---

### Quality Metrics
**Linter**: ➖ Not available
**Type Checker**: ✅ No errors (`tsc --noEmit` clean under strict config incl. `noUncheckedIndexedAccess`)

### Correctness (Static Evidence)
| Requirement | Status | Notes |
|------------|--------|-------|
| C1 ui-tree real-shape parsing | ✅ Implemented | `toUiElement` parses string center `"[x,y]"`, object `{x,y}`/bounds objects, string bounds via exported `parseBounds`; maps `resource-id`→`resourceId`, `content-desc`→`contentDesc`, `off-screen`→`offScreen` (camelCase still accepted) |
| No Silent Fallback | ✅ Implemented | `(0,0)` fallback ONLY when center unparseable AND bounds absent/unusable-all-zero; emits `targetable:false` exactly then — both branches now runtime-proven |
| detectDiffShape relaxation | ✅ Implemented | `added`/`modified` arrays → diff; `bounds`/`center` presence → full (sparse real elements tolerated); else unknown |
| C2 logcat dump-and-tail | ✅ Implemented | `adb -s S logcat -d [-t N] -v time [P:*] [--pid P]`; native filterspec + in-process fixed regex; headers dropped under filter; `truncated` flagged; newest-first |
| C3/W5 emulator lifecycle | ✅ Implemented | `emulator list --long` parse; start marker `/started as '(emulator-\d+)'/` + pre/post device-list diff fallback; poll THAT serial; unknown-AVD pre-check now runtime-proven |
| W1 device props | ✅ Implemented | `AdbWrapper.getprop(serial, prop)`; `getDeviceInfo` sources model/sdk via getprop, screen via `wm size/density` best-effort |
| W2 spawn timeouts | ✅ Implemented | `SPAWN_TIMEOUTS` tiers (15s/30s/120s), `SpawnTimeoutError{argv,timeoutMs}` race+kill in `BunCommandRunner.run`, wired into every exec; end-to-end surfacing proven ×5 through handlers |
| W3 temp PNG hygiene | ✅ Implemented | unique names; try/finally rm(force) host-side; device-side unique path + shell rm; concurrency-safe ownership proven |
| cli-output-fixtures | ✅ Implemented | 6 recorded envelopes pinned v1.0.15985488 with provenance; pin enforced AT LOAD by production loader; recorder script + README re-record procedure |

### Coherence (Design)
| Decision | Followed? | Notes |
|----------|-----------|-------|
| D1 per-spawn timeouts | ✅ Yes | Values match the design table; key-name cosmetics differ from sketch — no behavioral deviation |
| D2 fixture recording plan | ✅ Yes | 6 envelopes match designed naming set; manual recording, committed output, no CI recording |
| D3 dual-shape parsing | ✅ Yes | Tolerant normalization + relaxed diff detection exactly as specified |
| D4 bounded logcat | ✅ Yes | `-d -t N -v time [--pid] [P:*]` + fixed regex |
| D5 emulator lifecycle | ✅ Yes | Marker parse → poll THAT serial; refuses success without correlation |
| D6 device props | ✅ Yes | getprop + best-effort wm; sparse serialization omits unavailable fields |
| D7 temp hygiene | ✅ Yes | Helper naming family matches; try/finally cleanup on both sides |
| File Changes plan | ✅ Yes | Fix round confined to test/ + helpers as declared; src byte-identical |

### Issues Found
**CRITICAL**: None
**WARNING**: None
**SUGGESTION**:
1. The two disjunctive stuck-spawn scenarios are proven end-to-end through one named entry point each (`list_devices`, `emulator_list`); adding twin variants for `get_device_info`/`emulator_start` would be cheap belt-and-suspenders since they share identical guarded-spawn wiring.
2. Add coverage reporting so changed-file coverage can be evidenced in future verify rounds instead of being skipped.
3. The working tree mixes unrelated in-flight work (device-streaming/grpc) into the run; per-change isolation would tighten hygiene but does not affect these results.

### Verdict
PASS — All 28/28 requirements and 60/60 scenarios have passing covering tests on a fully green tree (313 pass / 0 fail, typecheck exit 0); Strict-TDD evidence audited 6/6 with mutation-proven RED/GREEN cycles and zero assertion-quality violations.
