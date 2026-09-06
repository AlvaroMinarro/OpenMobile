# Vendored emulator gRPC protos (pinned 36.5.11)

Copied verbatim from the installed emulator SDK on 2026-08-16 —
`$ANDROID_SDK_ROOT/emulator/lib/*.proto` (source of truth for the EXACT
installed version; server reflection is blocked by the default allowlist, so
clients MUST use local copies — design D3).

| File | Source | Notes |
|------|--------|-------|
| `emulator_controller.proto` | SDK `emulator/lib/` | EmulatorController service: `sendTouch` / `sendKey` / `getDisplayConfigurations` etc. Loaded by PR1 |
| `rtc_service.proto` | SDK `emulator/lib/` | RtcService **v1** — `requestRtcStream` / `sendJsepMessage` / `receiveJsepMessages`. Loaded by PR2 |
| `rtc_service_v2.proto` | SDK `emulator/lib/` | RtcService **v2** (experimental). Vendored for conformance pinning; not loaded yet (PR2+; needs `any.proto` below) |
| `ice_config.proto` | SDK `emulator/lib/` | ICE server config for RTC negotiation. Loaded by PR2 |
| `google/protobuf/{empty,any}.proto` | Vendored minimal STUBS (canonical field numbers) | proto-loader import deps only; the wire never serializes these directly |

## Pin

- **Emulator version**: `36.5.11.0` (build 15261927) — `emulator -version`.
- **Source**: `/home/alvaro/Android/Sdk/emulator/lib/` (the running SDK this
  repo targets).
- The `RtcService` protos are marked `experimental, use at your own risk` —
  behavior is pinned in conformance tests (PR2), not by these files alone.

## Re-pin procedure

1. Upgrade the emulator SDK; compare `emulator -version` against this pin.
2. Diff `$ANDROID_SDK_ROOT/emulator/lib/{emulator_controller,rtc_service,rtc_service_v2,ice_config}.proto`
   against `protos/`. Wire-shape changes MUST land with matching client code
   (src/device/grpc.ts, src/stream/rtc/) in the SAME commit.
3. Re-verify `bun test` — the in-process fake gRPC server mirrors the proto
   surface and will flag drift.