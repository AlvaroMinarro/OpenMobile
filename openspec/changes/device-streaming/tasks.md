# Tasks: Device Streaming

**Tracker**: `feature/device-streaming` (FROM `feature/android-device-bridge`). Strict TDD (`bun test`); fixture-first (fix-cli-real-output precedent); live capture on emulator-5554.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1,100–1,400 (14 files; binary jar excluded) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 core → PR 2 bridge → PR 3 client |
| Delivery strategy | auto-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | PR | Base | Deliverable |
|------|----|------|-------------|
| 1 | PR 1 | `feature/device-streaming` | assets+fixtures+record script; `src/stream/{types,wire,scrcpy,fanout}`; tests |
| 2 | PR 2 | PR 1 branch | `src/stream/{daemon,control,state}`; bridge routes; tests |
| 3 | PR 3 | PR 2 branch | `src/stream/client/*`; tests; docs; exports |

## Phase 1: Stream Core — PR 1 (D1, D2, D4)

- [x] 1.1 Commit `assets/scrcpy-server.jar` (sha256 `deacb99…` pinned, Apache-2.0) + `assets/README.md` (provenance, re-pin); extend `test/fixtures.test.ts` to assert jar sha256
- [x] 1.2 Create `scripts/record-stream-fixture.ts` (adapt `scripts/record-fixtures.ts`) + package.json script; LIVE-record `test/fixtures/{stream-meta.bin,stream-a-frames.bin,stream-control.bin}` + README (re-record procedure, emulator-5554)
- [x] 1.3 `src/stream/types.ts`: 64B device-meta / 12B frame-meta / control structs, session & viewer types, WS contract types
- [x] 1.4 RED `test/stream-wire.test.ts` from fixtures: meta (name/codec `0x68323634`/flags/w/h 430x960), CONFIG bit62/KEY bit61/PTS, len, Annex-B AU split, control bytes — MUST fail pre-fix
- [x] 1.5 GREEN `src/stream/wire.ts`: `parseDeviceMeta`/`parseFrameMeta`/`splitAnnexB`/`serializeControl` (touch 32B, keycode 14B, text len-prefixed; big-endian; coords = video size)
- [x] 1.6 `src/stream/scrcpy.ts`: `pushServer` (RE-push every start — server CleanUp self-deletes), `reverseSocket` (`localabstract:scrcpy_<scid>`), `spawnServer` (CLASSPATH env, version `4.1`, `tunnel_forward=false`), teardown; RED via MemoryRunner argv assertions first
- [x] 1.7 RED `test/stream-fanout.test.ts` (mocked sockets): drop-oldest ≤4/viewer (spec: Slow viewer), cap 8 reject (Viewer cap reached), cleanup on close
- [x] 1.8 GREEN `src/stream/fanout.ts` viewer registry (lifecycle of the registry; full session lifecycle → 2.2 `StreamManager`)
- [x] 1.9 `bun test` + typecheck green; commit `feat(stream): scrcpy wire core with live fixtures`

## Phase 2: Bridge Integration — PR 2 (D3, D5, D6)

- [x] 2.1 RED `test/stream-bridge.test.ts` (in-memory Bun.serve + MemoryRunner adb): handshake→AUs (spec: Stream connects), close codes 4403/4404/4429/4409 (Device unusable, Viewer cap), control ack (Tap during stream) + unknown-type error, `state.stream` (Active stream reports, Degraded), env-off reject (Env kill-switch), REST frozen (Fallback contract, Stills still captured) — slice 2B
- [x] 2.2 GREEN `src/stream/daemon.ts`: `StreamSession` (push→reverse→listen→spawn→read-loop→fan-out→control-reader) + `StreamManager` start-on-first-viewer / teardown-on-last (D5); device-loss watchdog → `stream.active:false` + reconnect session (Device lost mid-stream, Restart after disconnect)
  - [x] 2.2a `src/stream/manager.ts` (StreamManager) — lifecycle + watchdog + kill-switch (slice 2A); StreamSession/daemon = slice 2B
- [x] 2.3 GREEN `src/stream/control.ts`: JSON inject→scrcpy bytes; video-space range validation (Out-of-range coordinates); unsupported-char error (Unsupported character while streaming); control closed when no stream (Control without stream)
- [x] 2.4 GREEN additive `stream {supported,active,reason,viewers}` on /v1/state via `BridgeDeps.streamStatusProvider` (Unsupported environment when jar missing; implemented inline in server.ts, no separate state.ts)
- [x] 2.5 Modify `src/bridge/server.ts`: WS upgrade routes `/v1/stream/video`+`/v1/stream/control` (secret gate / CORS / error shape consistent); `src/bridge/main.ts`: wire `StreamManager` + `OPENMOBILE_STREAM`
  - [x] 2.5a `BridgeDeps.streamStatusProvider` + additive `stream` in handleState (slice 2A); WS routes + main.ts wiring = slice 2B
- [x] 2.6 `package.json` files += `assets/`; commit `feat(bridge): stream WS routes + additive state`
- [x] 2.7 Live-verify emulator-5554 (push→spawn→WS→control tap, screencap diff pre/post — design §Live-validated facts); record result in PR body

## Phase 3: Browser Client — PR 3 (D7)

- [ ] 3.1 `src/stream/client/annexb.ts`: AU splitter with offset accumulation, `chunkStart/chunkOffset` surface
- [ ] 3.2 `src/stream/client/renderer.ts`: WebCodecs `VideoDecoder`→canvas; SPS/PPS from handshake; config+first frame concat buffering
- [ ] 3.3 `src/stream/client/index.ts`: `openVideoStream`/`sendControl`, `stream.supported` detection (Firefox → `false` → polling), dispatch API; package.json exports `./stream-client`
- [ ] 3.4 RED→GREEN `test/stream-client.test.ts` (mocked WS/decoder): splitter unit, handshake ordering, error paths, fallback flag
- [ ] 3.5 Docs: README streaming section (WS contract, env var, demo page); commit `feat(stream-client): WebCodecs browser helper`