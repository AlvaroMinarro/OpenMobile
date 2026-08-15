# CLI Output Fixtures Specification

## Purpose

Record real `android` CLI v1.0.15985488 (and adb) output into `test/fixtures/` and require parser regression tests to consume those fixtures — so parsers are validated against the shapes the CLI actually emits, not hand-crafted doubles.

## Requirements

### Requirement: Recorded Real-Output Fixtures

The project MUST maintain recorded fixtures under `test/fixtures/` capturing real `android` CLI v1.0.15985488 and adb output, and MUST pin each fixture to a documented CLI version.

#### Scenario: Fixtures present

- GIVEN this change is implemented
- WHEN the test suite runs against `test/fixtures/`
- THEN the fixture set includes real recorded layout, layout --diff, emulator list, and logcat samples

#### Scenario: Provenance

- GIVEN a fixture file
- WHEN it is inspected
- THEN it documents the CLI/adb version (v1.0.15985488) and capture context

#### Scenario: Re-record procedure

- GIVEN the CLI version changes
- WHEN fixtures are re-recorded from the live CLI
- THEN the version pin is updated and the capture procedure is documented

### Requirement: Fixture Coverage of Critical Shapes

The fixture set MUST cover every shape that previously caused a parser mismatch: layout JSON with a string center `"[x,y]"` and hyphenated keys (`resource-id`, and `off-screen` WHEN the recorded screen emits off-screen nodes — the boot-screen fixture records NO off-screen elements because the real CLI omits the key for fully-visible trees), layout --diff `{added, modified}` shapes, `android emulator list` output, and logcat samples. The parser and its unit tests MUST accept the hyphenated `off-screen` key regardless of whether the current fixture contains it.

#### Scenario: Layout element shape

- GIVEN the recorded layout fixture
- WHEN a parser test consumes it
- THEN it contains at least one element with center as string `"[x,y]"` and a hyphenated `resource-id` key
- AND the parser maps the hyphenated `off-screen` key when present (covered by unit test, since the boot-screen fixture omits it)

#### Scenario: Diff shapes

- GIVEN the recorded layout --diff fixture
- WHEN a diff test consumes it
- THEN it contains `added` and/or `modified` arrays in the CLI's real shape

#### Scenario: Emulator list markers

- GIVEN the recorded `emulator list` fixture
- WHEN a running-detection test consumes it
- THEN it reflects the real output that previously misreported running status

#### Scenario: Logcat samples

- GIVEN the recorded logcat fixture
- WHEN a logcat test consumes it
- THEN it matches the `-d -t N` dump shape the read tool now emits

### Requirement: Fixture-Backed Parser Tests

Parser tests for CLI layout, diff-shape detection, emulator running-detection, and logcat filtering MUST consume the recorded fixtures for the shapes the CLI emits; hand-crafted doubles MUST NOT be the only coverage for those shapes.

#### Scenario: Layout parse regression

- GIVEN the recorded layout fixture
- WHEN the layout parser is tested against it
- THEN elements parse with real (non-zero) coordinates and correct off-screen flags
- AND the test fails against the pre-fix parser

#### Scenario: Emulator running regression

- GIVEN the recorded `emulator list` fixture
- WHEN the running-detection parser is tested against it
- THEN running status matches the real CLI-reported state
- AND the test fails against the pre-fix parser

#### Scenario: Diff regression

- GIVEN the recorded layout --diff fixture
- WHEN the diff parser is tested against it
- THEN `added`/`modified` elements carry real coordinates

#### Scenario: Logcat regression

- GIVEN the recorded logcat fixture
- WHEN the logcat filter/tail logic is tested
- THEN it processes the dump shape and returns bounded lines without blocking

## Non-Goals

- No golden/full-snapshot comparison of whole JSON outputs
- No fixtures for shapes the CLI does not emit (signals and MCP wrapper remain double-tested)
