# Design: Device Streaming

## Technical Approach
Live-validated scrcpy v4.1 raw-stream wiring on the existing loopback bridge: bundle the pinned `scrcpy-server-v4.1` jar, `adb reverse` a device abstract socket to a local TCP port, spawn the server via `app_process`, parse the raw H.264/control wire protocol, re-frame as Annex-B AUs over `WS /v1/stream/video`, and inject taps/keycodes/text/swipes over `WS /v1/stream/control`. Fixture-first parser tests (fix-cli-real-output precedent) with REAL captures from `emulator-5554` (Pixel_9_Pro, API 36).

## LIVE-VALIDATED WIRE FACTS (2026-08-16, emulator-5554)
scrcpy is NOT installed on this host → bundled jar REQUIRED. Push `adb -s S push assets/scrcpy-server.jar /data/local/tmp/scrcpy-server.jar` (733,706B; sha256 `deacb99…` pinned). Spawn (works): `adb -s S shell "CLASSPATH=/data/local/tmp/scrcpy-server.jar /system/bin/app_process / com.genymobile.scrcpy.Server 4.1 scid=<hex8> log_level=info video=true audio=false control=true send_dummy_byte=true send_device_meta=true send_stream_meta=true send_frame_meta=true tunnel_forward=false max_size=960 video_bit_rate=8000000 max_fps=30"` — the `CLASSPATH=…` prefix, version string "4.1", and `tunnel_forward=false` (device connects OUT; daemon listens) are all required.

Video socket (all big-endian): `[0..64)` device-name ASCII null-padded → `[64..68)` codec id `0x68323634`("h264") → `[68..80)` session meta `flags u32`(0x80000000=session, bit0=clientResized)+`w u32`+`h u32` (live 430x960 for max_size=960) → 12-byte frame-meta `ptsAndFlags u64`(bit62=CONFIG, bit61=KEY, low61=PTS)+`len u32` + `len` bytes **Annex-B** AU (`00 00 00 01`+NAL). Live: SPS `67 42 c0 29` (32B config), IDR `65 b8 00 04` (19,907B), slices `61 e0 00 20/40`.

Control socket (conn #2), big-endian: `TYPE_INJECT_TOUCH_EVENT=2` 32B: `[0]type [1]action(0=DOWN,1=UP,2=MOVE) [2..10)ptrId i64(-1) [10..14)x [14..18)y [18..20)scrW u16 [20..22)scrH u16 [22..24)pressure u16(0xffff=1.0) [24..28)actionButton [28..32)buttons`. `TYPE_INJECT_KEYCODE=0` 14B: `[0]type [1]action [2..6)keycode i32 [6..10)repeat [10..14)metastate` (BACK=4, HOME=3). `TYPE_INJECT_TEXT=1`: `[0]type [1..5)len u32 [5..)UTF-8` (ASCII+space only). **Position space = video size (430x960), NOT device size**; PositionMapper maps video→device, so surface maps device→video `x*430/1280, y*960/2856`.

`adb reverse localabstract:scrcpy_<scid> tcp:<port>`; daemon LISTENS, device CONNECTS (conn1=video, conn2=control). Server `CleanUp` self-deletes the jar once streaming starts → **RE-PUSH jar before EVERY stream start**. Rotation changes session w/h → daemon re-sends handshake.

## Architecture Decisions

| # | Decision | Alternatives | Rationale |
|---|----------|--------------|-----------|
| D1 | Bundle pinned jar under `assets/` | system scrcpy; runtime fetch | scrcpy absent; version-locked wire must match jar; no runtime network |
| D2 | `WS /v1/stream/video`: JSON handshake `{codec,lengthSize:12,sps,pps,width,height}` then one Annex-B AU per binary msg | 4-byte length prefix re-framing | scrcpy already frames via 12B meta; AUs are WebCodecs-ready |
| D3 | `WS /v1/stream/control` JSON, serialized to scrcpy bytes server-side | raw binary over WS | versionable surface; byte packing stays private |
| D4 | Drop-oldest fan-out: per-viewer queue (4), cap 8 viewers | blocking backpressure | never block encoder; loopback viewers |
| D5 | Start on first viewer, teardown on last + device-loss watchdog; re-push+spawn on restart | idle timer | no dangling process; spec lifecycle |
| D6 | `/v1/state` + `stream {supported,active,reason,viewers}` additive; `OPENMOBILE_STREAM=off` | flag | fallback untouched; REST frozen |
| D7 | Browser helper `src/stream/client/` export `./stream-client`: WS, AnnexB splitter, WebCodecs VideoDecoder, canvas | MSE/WASM | Chrome/Edge/Safari; Firefox → `stream.supported:false` → polling |

## Data Flow
```
Bun.serve (8765) ──WS /v1/stream/video──→ viewers (per-viewer queue, drop-oldest)
        ▲                                       ▲
        │ handshake + Annex-B AUs               │ JSON inject
scrcpy adapter ──TCP localhost ── conn1=video, conn2=control
   │ push jar (re-push per start), app_process spawn
   ▼
adb reverse localabstract:scrcpy_<scid> ── device server
```
`StreamSession` owns push → reverse → listen → spawn → read-loop (parse meta, split AUs, fan-out) → control reader → teardown.

## File Changes
| File | Action | Description |
|------|--------|-------------|
| `assets/scrcpy-server.jar` + `assets/README.md` | Create | pinned v4.1 jar, sha256, provenance, re-pin procedure |
| `src/stream/{types,scrcpy,wire,fanout,daemon,control,state}.ts` | Create | types; push/spawn/reverse/teardown; wire parse+serialize+annex-b; viewer registry (drop-oldest, cap 8); session manager; control bridge; state |
| `src/stream/client/{index,annexb,renderer}.ts` | Create | `./stream-client` export: openVideoStream/sendControl; AU splitter; WebCodecs renderer |
| `src/bridge/server.ts` | Modify | WS upgrade routes `/v1/stream/video`+`/v1/stream/control`; `stream` in state; REST frozen |
| `src/bridge/main.ts` | Modify | wire `StreamManager`, `OPENMOBILE_STREAM`, pass to handler |
| `test/{stream-wire,stream-control,stream-fanout,stream-bridge}.test.ts` | Create | parser/control/fanout/bridge-WS tests |
| `test/fixtures/{stream-meta.bin,stream-a-frames.bin}` | Create | recorded REAL captures |
| `scripts/record-stream-fixture.ts` | Create | re-record procedure |
| `package.json` | Modify | exports `./stream-client`, files include `assets/` |

## WS Contract (surface implements against this)
- `WS /v1/stream/video`: server→client `[JSON]{type:"handshake",codec:"h264",lengthSize:12,width,height,sps,pps}` (base64) → binary per AU → `[JSON]{type:"state",state:"buffering"|"streaming"|"error",reason?}`.
- `WS /v1/stream/control`: client→server `{type:"inject",event:"tap",x,y}` | `{event:"swipe",x1,y1,x2,y2,durationMs?}` | `{event:"text",text}` | `{event:"key",keycode}`; server→client `{type:"ack"}` | `{type:"error",code,message}`.
- Close codes: 4403 unsupported, 4404 no device, 4429 viewer cap, 4409 offline. REST errors keep `{error:{code,message}}`.

## Testing Strategy
| Layer | What | How |
|-------|------|-----|
| Unit | wire parse + annex-b split + control serialize | recorded fixtures + synthetic buffers; RED on pre-fix parser |
| Unit | fanout drop-oldest/cap/cleanup | mocked sockets |
| Integration | bridge WS routes, state object, control reject, env off | in-memory Bun.serve + MemoryRunner adb |
| Live (manual apply) | real push/spawn/stream/control on emulator-5554 | demo page + screencap diff before/after control tap (proven in design) |

## Migration / Rollout
No migration. `OPENMOBILE_STREAM=off` disables; revert commits roll back (state additive, REST frozen).

## Open Questions
None blocking. Rotation re-handshake + Firefox fallback verified in apply (spec'd, not blocking).