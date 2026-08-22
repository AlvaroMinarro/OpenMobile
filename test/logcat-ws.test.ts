/**
 * WS /v1/logcat/ws end-to-end contract (bridge-surface-v2 task 4.10,
 * local-bridge delta: Logcat WebSocket Route).
 *
 * REAL Bun.serve + REAL WebSocket client over a FAKE logcatFollow spawn
 * double (tasks.md Unit-3 harness: no real adb required). Pins:
 *  - Subscribe and receive: one filter frame ⇒ up to N recent matching
 *    lines, then the live marker, then unprompted live delivery,
 *  - Auth gate applies: upgrade refused without a valid credential while
 *    auth is enabled; a valid subprotocol entry upgrades per SPIKE-1/D1,
 *  - streaming-not-deployed precedent: absent adb.logcatFollow ⇒ 404.
 */
import { describe, expect, it } from "bun:test";
import { createBridgeApp, type BridgeDeps } from "../src/bridge/server";
import type { LogcatFollowHandle, LogcatFollowOptions } from "../src/device/adb";
import type { AVD, Device } from "../src/device/types";

// ─── Fake logcatFollow spawn doubles ─────────────────────────────────────

interface FakeLogcatSpawn {
  serial: string;
  opts: LogcatFollowOptions;
  stopped: boolean;
  emit(line: string): void;
}

function makeDeps(withFollow: boolean): {
  deps: BridgeDeps;
  spawns: FakeLogcatSpawn[];
} {
  const spawns: FakeLogcatSpawn[] = [];
  const devices: Device[] = [{ serial: "emulator-5554", state: "device" }];
  const deps: BridgeDeps = {
    bridge: { version: "test", pid: 1234 },
    adb: {
      devices: async () => devices,
      inputTap: async () => {},
      inputSwipe: async () => {},
      inputText: async () => {},
      ...(withFollow
        ? {
            logcatFollow(
              serial: string,
              opts: LogcatFollowOptions,
              onLine: (line: string) => void,
            ): LogcatFollowHandle {
              const rec: FakeLogcatSpawn = { serial, opts, stopped: false, emit: onLine };
              spawns.push(rec);
              return {
                stop: async () => {
                  rec.stopped = true;
                },
              };
            },
          }
        : {}),
    },
    cli: { emulatorList: async () => [] as AVD[], capture: async () => {} },
    env: {},
    readFile: async () => new Uint8Array(),
    tempPngPath: () => "/tmp/om-logcat-ws-test.png",
  };
  return { deps, spawns };
}

let seq = 0;
function logLine(tag = "App", priority = "E", message?: string): string {
  seq += 1;
  const ms = String(seq % 1000).padStart(3, "0");
  return `08-22 14:03:11.${ms} ${priority}/${tag}( 1234): ${message ?? `msg ${seq}`}`;
}
const HEADER = "--------- beginning of main";

/** Open a platform WebSocket; resolves on open, rejects on error/close. */
function opened(ws: WebSocket): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("close", () => reject(new Error("ws closed during open")), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws failed to open")), { once: true });
  });
}

function makeServer(deps: BridgeDeps, opts?: { secret?: string }) {
  const app = createBridgeApp(deps, opts);
  const server = Bun.serve<Record<string, unknown>>({
    port: 0,
    fetch: app.fetch,
    websocket: app.websocket,
  });
  return {
    http: (path: string, init?: RequestInit) =>
      server.fetch(new Request(`http://127.0.0.1:${server.port}${path}`, init)),
    wsUrl: (path: string) => `ws://127.0.0.1:${server.port}${path}`,
    stop: () => server.stop(),
  };
}

/**
 * Eager JSON-frame collector: buffering starts the moment it is created (BEFORE
 * any send/emit), so server-pushed frames can never fall into a listener gap.
 * `take()` resolves from the buffer first, then from live arrivals.
 */
function frameCollector(ws: WebSocket): { take(): Promise<Record<string, unknown>> } {
  const pending: Record<string, unknown>[] = [];
  const waiters: Array<(f: Record<string, unknown>) => void> = [];
  ws.addEventListener("message", (ev) => {
    const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else pending.push(frame);
  });
  return {
    take() {
      const buffered = pending.shift();
      if (buffered) return Promise.resolve(buffered);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("frame wait timed out")), 4000);
        waiters.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      });
    },
  };
}

describe("WS /v1/logcat/ws — E2E contract (task 4.10)", () => {
  it("subscribe-and-receive: ≤10 recent matching lines, live marker, then unprompted live lines", async () => {
    const { deps, spawns } = makeDeps(true);
    const srv = makeServer(deps);
    try {
      const ws = await opened(new WebSocket(srv.wsUrl("/v1/logcat/ws")));
      const frames = frameCollector(ws); // buffering BEFORE the filter frame
      ws.send('{"priority":"E","backlog":10}');

      // Wait until the ONE per-subscriber child exists, then script its stdout.
      for (let i = 0; i < 200 && spawns.length === 0; i++) await Bun.sleep(5);
      expect(spawns).toHaveLength(1);
      expect(spawns[0]!.serial).toBe("emulator-5554");
      expect(spawns[0]!.opts.tail).toBe(13); // backlog 10 + HEADER_SLACK 3

      // Startup window: one buffer header + TWELVE matches (over-backlog).
      spawns[0]!.emit(HEADER);
      for (let i = 0; i < 12; i++) spawns[0]!.emit(logLine("App", "E", `buffered ${i}`));

      const replayTexts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const frame = await frames.take();
        expect(frame.type).toBe("line");
        replayTexts.push(frame.message as string);
      }
      // Most-recent-first-window semantics: chronological within the cut.
      expect(replayTexts[0]).toBe("buffered 0");

      expect((await frames.take()).type).toBe("live"); // boundary AFTER the cut

      // The two surplus buffered matches keep flowing as LIVE lines…
      expect(await frames.take()).toMatchObject({ type: "line", message: "buffered 10" });
      expect(await frames.take()).toMatchObject({ type: "line", message: "buffered 11" });

      // …and genuinely fresh emissions arrive UNPROMPTED (no polling).
      spawns[0]!.emit(logLine("App", "E", "fresh live"));
      expect(await frames.take()).toMatchObject({ type: "line", message: "fresh live" });

      ws.close();
    } finally {
      srv.stop();
    }
  });

  it("auth gate applies: credential-less upgrade refused 401; valid subprotocol upgrades and streams", async () => {
    const { deps, spawns } = makeDeps(true);
    const srv = makeServer(deps, { secret: "s3cret" });
    try {
      // No credential → HTTP 401, NEVER an open socket.
      const denied = await srv.http("/v1/logcat/ws", {
        headers: { connection: "upgrade", upgrade: "websocket" },
      });
      expect(denied.status).toBe(401);

      // Valid subprotocol entry `openmobile.bearer.<seed>` → upgrade ok.
      const ws = await opened(
        new WebSocket(srv.wsUrl("/v1/logcat/ws"), ["openmobile.bearer.s3cret"]),
      );
      const frames = frameCollector(ws); // buffering BEFORE the filter frame
      ws.send('{"backlog":0}');
      for (let i = 0; i < 200 && spawns.length === 0; i++) await Bun.sleep(5);
      spawns[0]!.emit(logLine("App", "E", "authorized stream"));
      expect(await frames.take()).toMatchObject({ type: "live" }); // backlog 0 ⇒ marker first
      expect(await frames.take()).toMatchObject({ type: "line", message: "authorized stream" });
      ws.close();
    } finally {
      srv.stop();
    }
  });

  it("absent adb.logcatFollow ⇒ route 404s (streaming-not-deployed precedent)", async () => {
    const { deps } = makeDeps(false);
    const srv = makeServer(deps);
    try {
      const res = await srv.http("/v1/logcat/ws", {
        headers: { connection: "upgrade", upgrade: "websocket" },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");
    } finally {
      srv.stop();
    }
  });
});
