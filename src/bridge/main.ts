#!/usr/bin/env -S bun run
import { AndroidCli } from "../device/androidCli";
import { AdbWrapper } from "../device/adb";
import { BunCommandRunner } from "../device/runner";
import { createBridgeApp } from "./server";
import { tempPngPath } from "../device/temp";
import { resolveGrpcControl } from "../tools/context";
import type { BridgeApp, BridgeDeps } from "./server";
import { StreamGateway } from "../stream/gateway";
import { RtcSession } from "../stream/rtc/session";
import { GrpcRtcAdapter } from "../stream/rtc/adapter";
import {
  GrpcRtcClient,
  defaultRunDir,
  resolveRtcCapability,
} from "../device/grpc";
import { parseAuthConfig } from "./auth";

/**
 * Localhost `/v1` bridge daemon entrypoint (package.json `exports./bridge`).
 *
 * Loopback (127.0.0.1) is the trust boundary, so NO credentials are required
 * by default. An `OPENMOBILE_BRIDGE_SECRET` env var opts in: when set and
 * non-empty, every REST route and WS upgrade must pass the single auth seam
 * (`src/bridge/auth.ts`) — Bearer seed/issued-token or legacy
 * `X-OpenMobile-Secret`; browsers carry tokens as the
 * `openmobile.bearer.<token>` WS subprotocol. Tokens are minted via
 * `POST /v1/auth/token`.
 *
 * Env knobs:
 *   OPENMOBILE_BRIDGE_PORT            (default 8765)
 *   OPENMOBILE_BRIDGE_SECRET          (optional; default off — auth seed)
 *   OPENMOBILE_BRIDGE_TOKEN_TTL       (default 3600s; minted-token TTL)
 *   OPENMOBILE_BRIDGE_TOKEN_TTL_MAX   (default 86400s; server-enforced cap)
 *   OPENMOBILE_BRIDGE_ALLOWED_ORIGINS (csv; while auth is on ONLY these
 *                                     Origins get ACAO reflection)
 *   OPENMOBILE_STREAM                 (`on` default; `off` disables streaming —
 *                                     the WS routes reject with 4403 and
 *                                     /v1/state reports stream.supported:false)
 *   OPENMOBILE_RTC_FPS                (configured -rtcfps: 30 default, 60 fast;
 *                                     reported in the handshake + stream.rtc.fps)
 */
const DEFAULT_PORT = 8765;
const HOSTNAME = "127.0.0.1";
/** Bridge protocol/daemon version surfaced in `GET /v1/state` (tracked with the package). */
const BRIDGE_VERSION = "0.1.0";

/** OPENMOBILE_STREAM semantics: anything except "off" enables streaming. */
export function streamEnabled(env: Record<string, string>): boolean {
  return env["OPENMOBILE_STREAM"] !== "off";
}

/**
 * Selection-override holder (Phase 3, design D7): daemon-memory state backing
 * `POST /v1/device/select`. One instance per wiring — `createBridgeDeps`
 * builds a fresh one, so a bridge restart clears the override and selection
 * follows the standard tiers again (device-discovery delta). Nothing here
 * touches disk or env: there is deliberately NO persistence path.
 */
export function createSelectionOverride(): NonNullable<BridgeDeps["selectionOverride"]> {
  let serial: string | null = null;
  return {
    current: () => serial,
    set: (next: string) => {
      serial = next;
    },
  };
}

/**
 * Configured `-rtcfps` (Codec and FPS Negotiation requirement): 30 is the
 * emulator default; 60 is the fast option. Anything else falls back to 30 —
 * the value is only ever REPORTED here (handshake + /v1/state), the flag
 * itself is applied at launch (androidCli, ≥36.6 gate).
 */
export function parseRtcFps(raw: string | undefined): number {
  return raw === "60" ? 60 : 30;
}

/**
 * Build the RtcSession for one resolved endpoint (task 2.8): the gRPC v1
 * adapter over GrpcRtcClient, the getStatus watchdog probe on the same
 * endpoint, and VP8 as the mandatory codec.
 */
function createRtcSession(
  endpoint: { addr: string; token: string },
  serial: string,
  fps: number,
): RtcSession {
  const client = new GrpcRtcClient(endpoint.addr, endpoint.token);
  return new RtcSession({
    serial,
    adapter: new GrpcRtcAdapter(client),
    fps,
    codecs: ["VP8"],
    probe: () => client.probe(),
  });
}

export function createBridgeDeps(env: Record<string, string> = process.env as Record<string, string>): BridgeDeps {
  const runner = new BunCommandRunner(env);
  const adb = new AdbWrapper(runner);
  const cli = new AndroidCli(runner);
  const deps: BridgeDeps = {
    bridge: { version: BRIDGE_VERSION, pid: process.pid },
    adb,
    cli,
    env,
    readFile: async (path: string) => new Uint8Array(await Bun.file(path).arrayBuffer()),
    tempPngPath,
    // Runtime selection override (design D7): fresh per wiring ⇒ restart clears.
    selectionOverride: createSelectionOverride(),
    // gRPC-first input (input-channel delta): resolve the serial → pid-ini
    // token/port; null (external launch, physical device) ⇒ adb fallback.
    grpcControl: resolveGrpcControl,
  };
  if (streamEnabled(env)) {
    // The gateway serial follows the same resolution as REST: ANDROID_DEVICE
    // env beats the single attached device. autodetect-ing here is deferred
    // to when a stream actually starts (first viewer) — keeps /v1/state
    // honest before any viewer is attached.
    const serial = env["ANDROID_DEVICE"] ?? "";
    const fps = parseRtcFps(env["OPENMOBILE_RTC_FPS"]);
    deps.streamGateway = new StreamGateway({
      // Empty serial: the gateway resolves the device when a stream actually
      // starts (first viewer).
      serial: serial || "auto",
      enabled: true,
      fps,
      // Capability probe (task 2.8): pid-ini endpoint + version gate under
      // the per-instance run dir (env record first, then the default).
      resolveCapability: (target) =>
        resolveRtcCapability(env["OPENMOBILE_AVD_RUN_DIR"] ?? defaultRunDir(), target),
      // RtcSession factory: real gRPC v1 adapter + getStatus watchdog.
      createSession: (endpoint, target) => createRtcSession(endpoint, target, fps),
      // Control injector for the active stream (WS /v1/stream/control).
      controlFor: resolveGrpcControl,
      // "auto" resolution + the manager's adb watchdog share the device poll.
      pollDevices: () => adb.devices(),
    });
  }
  return deps;
}

export function resolvePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `OPENMOBILE_BRIDGE_PORT must be an integer in 0..65535 (0 = ephemeral), got "${raw}"`,
    );
  }
  return port;
}

/** Build the in-memory handler wiring real device core + env config. */
export function bridgeHandler(env: Record<string, string> = process.env as Record<string, string>) {
  const deps = createBridgeDeps(env);
  const app = createBridgeApp(deps, bridgeAuthOptions(env));
  // REST-only callable (upgrades always fail): keeps the pre-WS contract and
  // lets tests exercise the REST surface without a socket server.
  return (req: Request) => app.fetch(req, { upgrade: () => false } as unknown as Bun.Server<Record<string, unknown>>);
}

/** Full bridge app (REST fetch + WS handler table) for Bun.serve wiring. */
export function bridgeApp(env: Record<string, string> = process.env as Record<string, string>): BridgeApp {
  const deps = createBridgeDeps(env);
  return createBridgeApp(deps, bridgeAuthOptions(env));
}

/**
 * Auth wiring from env (design D2/D6): seed unset ⇒ `auth.enabled:false` ⇒
 * byte-identical legacy behavior; the raw legacy `secret` option is kept as a
 * fallback for direct BridgeOptions callers only.
 */
function bridgeAuthOptions(env: Record<string, string>) {
  return {
    auth: parseAuthConfig(env),
    allowedOriginsCsv: env["OPENMOBILE_BRIDGE_ALLOWED_ORIGINS"],
  };
}

/** Bind the handler to loopback. Exported for tests; also run via `import.meta.main`. */
export function startBridge(
  env: Record<string, string> = process.env as Record<string, string>,
): { server: Bun.Server<Record<string, unknown>>; port: number } {
  const port = resolvePort(env["OPENMOBILE_BRIDGE_PORT"]);
  const app = bridgeApp(env);
  const server = Bun.serve<Record<string, unknown>>({
    hostname: HOSTNAME,
    port,
    fetch: app.fetch,
    websocket: app.websocket,
  });
  return { server, port };
}

if (import.meta.main) {
  const { server, port } = startBridge();
  void server;
  console.log(`[openmobile-bridge] /v1 listening on http://127.0.0.1:${port} (loopback)`);
}