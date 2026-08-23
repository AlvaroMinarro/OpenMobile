# Delta for Device Discovery

> Base: `openspec/specs/device-discovery/spec.md`. Adds a runtime HTTP selection
> override tier between the explicit per-request parameter and the environment
> tier, plus a stale-selection rule. Only the Device Selection requirement is
> modified; all other requirements stand unchanged.

## MODIFIED Requirements

### Requirement: Device Selection

Device selection MUST follow, in order: the explicit per-request `device` parameter (CLI `--device` argument or route `device` parameter), the bridge runtime selection override (`POST /v1/device/select`, see `local-bridge`), the `ANDROID_DEVICE` environment variable, then single-device auto-detection. With multiple attached devices and no applicable tier, tools MUST fail listing all available serials. A selected serial that is no longer attached MUST produce an actionable error naming that serial — never silent fallback to another attached device. The override persists for the daemon process lifetime only.
(Previously: three tiers only — explicit argument, env var, auto-detect; no runtime override tier and no stale-selection rule.)

#### Scenario: Explicit flag wins

- GIVEN two devices attached and `--device emulator-5554`
- WHEN a tool is invoked
- THEN it targets `emulator-5554`

#### Scenario: Ambiguous selection

- GIVEN two devices attached and no flag or env var
- WHEN a tool is invoked
- THEN it returns an error listing both serials

#### Scenario: Single device auto-detect

- GIVEN exactly one device attached
- WHEN a tool is invoked with no explicit selection
- THEN it targets that device

#### Scenario: Override beats environment

- GIVEN `ANDROID_DEVICE=emulator-5554`, devices `emulator-5554` and `emulator-5556` attached, and the runtime override set to `emulator-5556`
- WHEN a bridge-routed operation resolves its target
- THEN it targets `emulator-5556`, because the override outranks the environment tier

#### Scenario: Request parameter beats override

- GIVEN the runtime override set to `emulator-5556` and both devices attached
- WHEN a route is called with explicit `device=emulator-5554`
- THEN it targets `emulator-5554`

#### Scenario: Stale selected serial errors

- GIVEN the runtime override set to `emulator-5556` and that device detaches while `emulator-5554` stays attached
- WHEN a routed operation needing a target executes
- THEN it returns an actionable error naming `emulator-5556` instead of falling back to `emulator-5554`

#### Scenario: Restart clears override

- GIVEN the runtime override set to `emulator-5556`
- WHEN the daemon process restarts
- THEN selection follows the remaining tiers as if no override existed

## Non-Goals

- No persistence of the selection override beyond daemon process lifetime
- No concurrent-selection arbitration beyond the documented precedence order
