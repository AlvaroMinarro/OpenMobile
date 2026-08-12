#!/usr/bin/env -S bun run
import { AndroidCli } from "../device/androidCli";
import { AdbWrapper } from "../device/adb";
import { BunCommandRunner } from "../device/runner";
import { createBridgeHandler } from "./server";
import type { BridgeDeps } from "./server";

/**
 * Localhost `/v1` bridge daemon entrypoint (package.json `exports./bridge`).
 *
 * Loopback (127.0.0.1) is the trust boundary, so NO shared-secret header is
 * required by default. An `OPENMOBILE_BRIDGE_SECRET` env var can opt in: when
 * set and non-empty, every request must carry it in `X-OpenMobile-Secret`.
 *
 * Env knobs:
 *   OPENMOBILE_BRIDGE_PORT  (default 8765)
 *   OPENMOBILE_BRIDGE_SECRET (optional; default off)
 */
const DEFAULT_PORT = 8765;
const HOSTNAME = "127.0.0.1";
/** Bridge protocol/daemon version surfaced in `GET /v1/state` (tracked with the package). */
const BRIDGE_VERSION = "0.1.0";

export function createBridgeDeps(env: Record<string, string> = process.env as Record<string, string>): BridgeDeps {
  const runner = new BunCommandRunner(env);
  const adb = new AdbWrapper(runner);
  const cli = new AndroidCli(runner);
  return {
    bridge: { version: BRIDGE_VERSION, pid: process.pid },
    adb,
    cli,
    env,
    readFile: async (path: string) => new Uint8Array(await Bun.file(path).arrayBuffer()),
  };
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
  return createBridgeHandler(deps, { secret: secret || undefined });
}

/** Bind the handler to loopback. Exported for tests; also run via `import.meta.main`. */
export function startBridge(
  env: Record<string, string> = process.env as Record<string, string>,
): { server: Bun.Server<undefined>; port: number } {
  const port = resolvePort(env["OPENMOBILE_BRIDGE_PORT"]);
  const server = Bun.serve({ hostname: HOSTNAME, port, fetch: bridgeHandler(env) });
  return { server, port };
}

if (import.meta.main) {
  const { server, port } = startBridge();
  console.log(`[openmobile-bridge] /v1 listening on http://127.0.0.1:${port} (loopback)`);
}