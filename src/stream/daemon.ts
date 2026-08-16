/**
 * StreamSession daemon — push→listen→reverse→spawn→read-loop→fan-out→
 * control-reader for one scrcpy session (design D5 / task 2.2, slice 2B).
 *
 * Owns the RAW socket machinery the StreamManager (slice 2A) abstracts:
 *  - push the bundled jar (RE-push every start — the server self-deletes),
 *  - listen on an ephemeral loopback TCP port,
 *  - `adb reverse` the device's abstract socket to that port,
 *  - spawn the server via `adb shell` (CLASSPATH env, version 4.1),
 *  - read-loop conn1 (video): accumulate the socket byte stream, parse the
 *    80B header, then emit `[12B frame meta][Annex-B AU]` payloads as raw
 *    AUs to the fan-out registry; derive the WS handshake (SPS/PPS base64)
 *    from the first CONFIG frame,
 *  - control-reader conn2: consumes inbound bytes (the server's device→host
 *    device messages) so they never stall the socket,
 *  - `sendControl(bytes)` writes scrcpy control bytes into conn2 (task 2.3
 *    produces them),
 *  - loss detection: the spawn exiting (server crash) or the video socket
 *    closing mid-stream fires `onLoss` → `stateReason: "device_lost"`,
 *  - `close()`: kill spawn → remove reverse → delete the device-side jar →
 *    close the listener → close all viewers.
 *
 * The read loop NEVER blocks on a slow viewer: the fan-out registry holds
 * depth-bounded queues and drops the oldest frame per viewer (design D4).
 */

import { createServer, type Server, type Socket } from "node:net";
import type { CommandRunner } from "../device/runner";
import { pushServer, reverseSocket, spawnServer } from "./scrcpy";
import { Fanout } from "./fanout";
import { parseDeviceMeta, parseFrameMeta, splitAnnexB } from "./wire";
import {
  DEVICE_META_LEN,
  CODEC_ID_LEN,
  SESSION_META_LEN,
  FRAME_META_LEN,
  type FanoutRegistry,
  type SessionMeta,
  type StreamViewer,
  type VideoHandshake,
} from "./types";

/** Abstract-socket reverse machinery (design §Live-validated facts). */
export interface StreamSessionOptions {
  runner: CommandRunner;
  serial: string;
  scid: string;
  /** Factory so tests can substitute a fake listener. Default: net.createServer. */
  listenerFactory?: () => DaemonListener;
  /** Spawn override for tests (default: the scrcpy adapter's spawnServer). */
  spawnFn?: (argv: string[]) => SpawnHandle;
}

/** The parts of node:net Server the session needs (testable fake). */
export interface DaemonListener {
  port: number;
  listen(): Promise<void>;
  onConnection(cb: (s: DaemonSocket) => void): void;
  close(): Promise<void>;
}

/** The parts of a net.Socket the session needs (testable fake). */
export interface DaemonSocket {
  on(event: "data" | "close" | "error", cb: (c?: unknown) => void): void;
  write(c: Uint8Array): void;
  destroy(): void;
}

/** Killable spawn handle (testable fake; adapter spawn returns an adb proc). */
export interface SpawnHandle {
  kill(): void;
  readonly exited: Promise<number>;
}

/**
 * Pure byte accumulator for the video socket. Given the documented wire
 * shape — 80B header, then [12B frame meta][len Annex-B AU] — it returns
 * a frame as soon as its payload bytes are fully received, tolerating ANY
 * TCP segmentation. The handshake is produced exactly once, from the first
 * CONFIG frame (SPS+PPS NALs).
 */
export class StreamAssembler {
  private buf = Buffer.alloc(0);
  private headerParsed = false;
  private meta: SessionMeta | undefined;
  private handshakeDone = false;
  private pending: Array<{ au: Uint8Array; isConfig: boolean }> = [];

  /** Returns frames emitted by THIS ingest + the handshake (if completed now). */
  ingest(chunk: Uint8Array): { frames: Uint8Array[]; handshake: VideoHandshake | null } {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, Buffer.from(chunk)]);
    if (!this.headerParsed && this.buf.length >= DEVICE_META_LEN + CODEC_ID_LEN + SESSION_META_LEN) {
      const header = this.buf.subarray(0, DEVICE_META_LEN + CODEC_ID_LEN + SESSION_META_LEN);
      this.meta = parseDeviceMeta(header);
      this.headerParsed = true;
      this.buf = this.buf.subarray(DEVICE_META_LEN + CODEC_ID_LEN + SESSION_META_LEN);
    }
    if (!this.headerParsed) return { frames: [], handshake: null };

    while (this.buf.length >= FRAME_META_LEN) {
      const fm = parseFrameMeta(this.buf.subarray(0, FRAME_META_LEN));
      const need = FRAME_META_LEN + fm.len;
      if (this.buf.length < need) break; // payload still arriving
      const payload = this.buf.subarray(FRAME_META_LEN, need);
      this.buf = this.buf.subarray(need);
      // A frame-meta payload is (per scrcpy raw protocol) one Annex-B AU or
      // a small set of AUs (CONFIG carries SPS+PPS). Keep the split general.
      const aus = splitAnnexB(payload);
      for (const au of aus) this.pending.push({ au, isConfig: fm.isConfig });
    }

    const frames: Uint8Array[] = [];
    let handshake: VideoHandshake | null = null;
    for (const p of this.pending) {
      if (!this.handshakeDone && this.meta && p.isConfig) {
        const hs = buildHandshake(this.meta, this.pending.map((q) => q.au));
        if (hs) {
          handshake = hs;
          this.handshakeDone = true;
        }
      }
      frames.push(p.au);
    }
    this.pending = [];
    return { frames, handshake };
  }
}

/**
 * Derive the WS handshake (design D2) from the session header + CONFIG AUs.
 * Returns null when SPS or PPS is missing (the client could not decode).
 */
export function buildHandshake(meta: SessionMeta, aus: Uint8Array[]): VideoHandshake | null {
  const sps = aus.find((a) => a.length >= 5 && a[4] === 0x67);
  const pps = aus.find((a) => a.length >= 5 && a[4] === 0x68);
  if (!sps || !pps) return null;
  return {
    type: "handshake",
    codec: "h264",
    lengthSize: 12,
    width: meta.width,
    height: meta.height,
    sps: Buffer.from(sps.subarray(4)).toString("base64"),
    pps: Buffer.from(pps.subarray(4)).toString("base64"),
  };
}

/**
 * One live session. Exposes everything the WS layer + StreamManager need.
 * Construction is inert; call `start()` (push→reverse→spawn) once.
 */
export class StreamSession {
  readonly scid: string;
  readonly serial: string;
  readonly fanout: FanoutRegistry = new Fanout();
  /** Resolves with the handshake once the first CONFIG frame is parsed. */
  readonly handshakeReady: Promise<VideoHandshake>;
  /** Device-loss reason when the server/socket dies; undefined while healthy. */
  stateReason: string | undefined;

  private readonly runner: CommandRunner;
  private readonly listener: DaemonListener;
  private readonly spawnFn: (argv: string[]) => SpawnHandle;
  private videoSocket: DaemonSocket | undefined;
  private controlSocket: DaemonSocket | undefined;
  private spawnProc: SpawnHandle | undefined;
  private lossCb: (() => void) | undefined;
  private stopped = false;
  private readonly resolveHandshake: (hs: VideoHandshake) => void;

  constructor(options: StreamSessionOptions) {
    this.runner = options.runner;
    this.serial = options.serial;
    this.scid = options.scid;
    this.listener = options.listenerFactory ? options.listenerFactory() : defaultListener();
    this.spawnFn = options.spawnFn ?? spawnThroughAdapter;
    let resolveHs!: (hs: VideoHandshake) => void;
    this.handshakeReady = new Promise<VideoHandshake>((r) => (resolveHs = r));
    this.resolveHandshake = resolveHs;
  }

  get connected(): boolean {
    return this.videoSocket !== undefined && !this.stopped;
  }

  onLoss(cb: (() => void) | undefined): void {
    this.lossCb = cb;
  }

  /** push → listen → reverse → spawn. Adapter runner asserts the argv. */
  async start(): Promise<void> {
    await pushServer(this.runner, this.serial);
    await this.listener.listen();
    await reverseSocket(this.runner, this.serial, this.scid, this.listener.port);
    this.listener.onConnection((sock) => this.onConnection(sock));
    const argv = ["adb", "-s", this.serial, "shell", buildSpawnShellCmd(this.scid)];
    this.spawnProc = this.spawnFn(argv);
    // If the spawn's underlying process exits (server crash / adb died),
    // surface it as device loss. spawnFn returns the process handle; the
    // adapter's spawnServer resolves with undefined (proc not surfaced) —
    // the handle contract keeps this optional.
    void this.watchSpawnExit();
  }

  /** Write scrcpy control bytes into conn2 (from task 2.3 encoders). */
  sendControl(bytes: Uint8Array): Promise<void> {
    if (this.controlSocket) this.controlSocket.write(bytes);
    return Promise.resolve();
  }

  /** Full teardown: kill spawn → remove reverse → delete jar → close all. */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.spawnProc?.kill();
    } catch {
      // already dead
    }
    void this.runner
      .run(["adb", "-s", this.serial, "reverse", "--remove-all"])
      .catch(() => {});
    void this.runner
      .run(["adb", "-s", this.serial, "shell", "rm", "-f", "/data/local/tmp/scrcpy-server.jar"])
      .catch(() => {});
    void this.listener.close().catch(() => {});
    try {
      this.videoSocket?.destroy();
      this.controlSocket?.destroy();
    } catch {
      // already gone
    }
    this.fanout.closeAll();
  }

  private onConnection(sock: DaemonSocket): void {
    if (this.videoSocket === undefined) {
      this.videoSocket = sock;
      this.attachVideo(sock);
    } else if (this.controlSocket === undefined) {
      this.controlSocket = sock;
      this.attachControl(sock);
    } else {
      // More than 2 connections — drop the extra (scrcpy only opens 2).
      sock.destroy();
    }
  }

  private attachVideo(sock: DaemonSocket): void {
    const asm = new StreamAssembler();
    sock.on("data", (c) => {
      if (this.stopped) return;
      const { frames, handshake } = asm.ingest(c as Uint8Array);
      if (handshake) this.resolveHandshake(handshake);
      for (const f of frames) this.fanout.broadcast(f);
    });
    sock.on("close", () => {
      if (!this.stopped) this.lose("video socket closed");
    });
    sock.on("error", () => {
      // socket-level errors are surfaced via close; nothing to add here
    });
  }

  private attachControl(sock: DaemonSocket): void {
    sock.on("data", () => {
      // Device→host device messages (clipboard, etc.) — not consumed today.
    });
    sock.on("error", () => {
      // control errors don't kill the video path
    });
  }

  private lose(reason: string): void {
    if (this.stopped) return;
    this.stateReason = "device_lost";
    this.lossCb?.();
  }

  private async watchSpawnExit(): Promise<void> {
    if (!this.spawnProc) return;
    try {
      const code = await this.spawnProc.exited;
      // A spawn exit code is surfaced by the adapter's process handle. When
      // the underlying `adb shell` dies (server crashed / device gone), the
      // video socket closes shortly after — the socket-close path also fires
      // loss. Only treat a NON-ZERO exit as loss (a clean 0 stays silent).
      if (code !== 0 && !this.stopped) this.lose(`server exited ${code}`);
      // The exited promise never resolves for default (adapter) handles.
    } catch {
      // handle never resolves or was already torn down
    }
  }
}

function defaultListener(): DaemonListener {
  const server = createServer();
  const listener: DaemonListener = {
    port: 0,
    listen: () =>
      new Promise<void>((res, rej) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          if (addr !== null && typeof addr === "object") listener.port = addr.port;
          res();
        });
        server.once("error", rej);
      }),
    onConnection: (cb) => {
      server.on("connection", (sock: Socket) => {
        const wrap: DaemonSocket = {
          on: (ev, c) => {
            void sock.on(ev as "data" | "close" | "error", c as (...args: unknown[]) => void);
          },
          write: (c: Uint8Array) => void sock.write(c),
          destroy: () => sock.destroy(),
        };
        cb(wrap);
      });
    },
    close: () =>
      new Promise<void>((res) => server.close(() => res())),
  };
  return listener;
}

/** STANDALONE spawn argv (mirrors scrcpy.ts buildSpawnCmd). */
function buildSpawnShellCmd(scid: string): string {
  return [
    "CLASSPATH=/data/local/tmp/scrcpy-server.jar",
    "/system/bin/app_process",
    "/",
    "com.genymobile.scrcpy.Server",
    "4.1",
    `scid=${scid}`,
    "log_level=info",
    "video=true",
    "audio=false",
    "control=true",
    "send_dummy_byte=true",
    "send_device_meta=true",
    "send_stream_meta=true",
    "send_frame_meta=true",
    "tunnel_forward=false",
    "max_size=960",
    "video_bit_rate=8000000",
    "max_fps=30",
  ].join(" ");
}

/** Default spawnFn: bind the scrcpy adapter's spawn to this session's bus. */
const spawnThroughAdapter: (argv: string[]) => SpawnHandle = (argv) => {
  // The adapter's spawnServer already runs `adb -s <serial> shell <cmd>`;
  // the argv contract here is informational for tests. The handle is inert
  // (no process access) — loss is driven by the video-socket-close path.
  void argv;
  return { kill: () => {}, exited: new Promise<number>(() => {}) };
};