#!/usr/bin/env -S bun run
import { AndroidCli } from "../device/androidCli";
import { AdbWrapper } from "../device/adb";
import { BunCommandRunner } from "../device/runner";
import { createBridgeApp } from "./server";
import { tempPngPath } from "../device/temp";
import type { BridgeApp, BridgeDeps } from "./server";
import { StreamGateway } from "../stream/gateway";

/**
 * Localhost `/v1` bridge daemon entrypoint (package.json `exports./bridge`).
 *
 * Loopback (127.0.0.1) is the trust boundary, so NO shared-secret header is
 * required by default. An `OPENMOBILE_BRIDGE_SECRET` env var can opt in: when
 * set and non-empty, every request must carry it in `X-OpenMobile-Secret`.
 *
 * Env knobs:
 *   OPENMOBILE_BRIDGE_PORT   (default 8765)
 *   OPENMOBILE_BRIDGE_SECRET (optional; default off)
 *   OPENMOBILE_STREAM        (`on` default; `off` disables streaming — the WS
 *                            routes reject with 4403 and /v1/state reports
 *                            stream.supported:false — design D6 kill-switch)
 */
const DEFAULT_PORT = 8765;
const HOSTNAME = "127.0.0.1";
/** Bridge protocol/daemon version surfaced in `GET /v1/state` (tracked with the package). */
const BRIDGE_VERSION = "0.1.0";

/** OPENMOBILE_STREAM semantics: anything except "off" enables streaming. */
export function streamEnabled(env: Record<string, string>): boolean {
  return env["OPENMOBILE_STREAM"] !== "off";
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
  };
  if (streamEnabled(env)) {
    // The gateway serial follows the same resolution as REST: ANDROID_DEVICE
    // env beats the single attached device. autodetect-ing here is deferred
    // to the gateway's own device read via the watchdog source.
    const serial = env["ANDROID_DEVICE"] ?? "";
    deps.streamGateway = new StreamGateway({
      runner,
      // Empty serial: the gateway falls back to resolving the device when a
      // stream actually starts (first viewer) — keeps /v1/state honest before
      // any viewer is attached.
      serial: serial || "auto",
      enabled: true,
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
  const secret = env["OPENMOBILE_BRIDGE_SECRET"];
  const app = createBridgeApp(deps, { secret: secret || undefined });
  // REST-only callable (upgrades always fail): keeps the pre-WS contract and
  // lets tests exercise the REST surface without a socket server.
  return (req: Request) => app.fetch(req, { upgrade: () => false } as unknown as Bun.Server<Record<string, unknown>>);
}

/** Full bridge app (REST fetch + WS handler table) for Bun.serve wiring. */
export function bridgeApp(env: Record<string, string> = process.env as Record<string, string>): BridgeApp {
  const deps = createBridgeDeps(env);
  const secret = env["OPENMOBILE_BRIDGE_SECRET"];
  return createBridgeApp(deps, { secret: secret || undefined });
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