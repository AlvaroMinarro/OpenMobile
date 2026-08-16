/**
 * Recorder for the LIVE scrcpy v4.1 stream fixtures.
 *
 * Runs the real pushed jar against a booted emulator (emulator-5554 default)
 * through the production `BunCommandRunner` and writes to test/fixtures/:
 *
 *   stream-meta.bin     — 64B device meta + 4B codec id + 12B session meta
 *                         + the 12B frame-meta header of the first CONFIG AU
 *   stream-a-frames.bin — Annex-B AUs: config AU (SPS+PPS) + IDR AU, each
 *                         prefixed by its 12B frame-meta (the exact stream
 *                         segment splitAnnexB() consumes)
 *   stream-control.bin  — a TYPE_INJECT_TOUCH_EVENT (32B) tap at video-space
 *                         (215, 480) as serializeControl() must emit
 *
 * Each .bin ships with a `<name>.json` provenance envelope in the
 * fix-cli-real-output style (design D2): { bytes, provenance: { tool,
 * version, capturedAt, context, details } } so parser tests know WHEN, HOW,
 * and from WHICH device each byte was captured.
 *
 * Manual, one-off: run `bun run record-stream-fixture` on a machine with adb
 * and a booted emulator; recording is NEVER part of CI.
 *
 * Re-record procedure (also in test/fixtures/README.md):
 *  1. Boot an emulator (interactive home screen) and wait for boot completion.
 *  2. If the bundled jar changed, re-pin it first (assets/README.md) — the
 *     wire layout is version-specific.
 *  3. `bun run record-stream-fixture` — overwrites the three binary fixtures
 *     + provenance JSONs.
 *  4. Review the diff: a wire-shape change MUST land with matching parser
 *     changes in src/stream/wire.ts in the SAME commit.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Socket } from "node:net";
import { BunCommandRunner } from "../src/device/runner";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "..", "test", "fixtures");
const JAR_LOCAL = join(HERE, "..", "assets", "scrcpy-server.jar");
const JAR_DEV = "/data/local/tmp/scrcpy-server.jar";

/** Version of the scrcpy server these fixtures describe (design D1 pin). */
export const SCRCPY_VERSION = "4.1";

/** Tap coordinates for stream-control.bin — video space (430x960). */
const TAP_VIDEO = { x: 215, y: 480 };

/** Video size of the recording run (max_size=960 on the Pixel 9 Pro AVD). */
const VIDEO_SIZE = { width: 430, height: 960 } as const;

type StreamContext = "session-meta" | "video-frames" | "control-tap";

interface StreamProvenance {
  tool: "scrcpy";
  version: string;
  capturedAt: string;
  context: StreamContext;
  details: {
    serial: string;
    device?: string;
    jarSha256: string;
    spawnCmd: string;
    videoSize: { width: number; height: number };
  };
}

interface TraceEnvelope {
  bytes: number;
  provenance: StreamProvenance;
}

const runner = new BunCommandRunner();

async function sh(argv: string[]): Promise<string> {
  const { stdout, stderr, exitCode } = await runner.run(argv, { timeoutMs: 120_000 });
  if (exitCode !== 0) throw new Error(`command failed ${argv.join(" ")}: ${stderr || stdout}`);
  return stdout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Fresh session id: signed 32-bit int (parseInt(scid,16) on device). */
function freshScid(): string {
  const raw = randomBytes(4).readUInt32BE(0) & 0x7fffffff;
  return raw.toString(16);
}

/** The app_process spawn shell command (design §Live-validated facts). */
export function buildSpawnCmd(scid: string): string {
  return [
    `CLASSPATH=${JAR_DEV}`,
    "/system/bin/app_process",
    "/",
    "com.genymobile.scrcpy.Server",
    SCRCPY_VERSION,
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

async function sha256Of(path: string): Promise<string> {
  const buf = await Bun.file(path).arrayBuffer();
  return createHash("sha256").update(new Uint8Array(buf)).digest("hex");
}

async function pushJar(serial: string): Promise<void> {
  await sh(["adb", "-s", serial, "push", JAR_LOCAL, JAR_DEV]);
}

/** TYPE_INJECT_TOUCH_EVENT=2 tap, 32B, big-endian (design §control socket). */
function serializeTap(x: number, y: number): Buffer {
  const b = Buffer.alloc(32);
  b[0] = 2; // TYPE_INJECT_TOUCH_EVENT
  b[1] = 0; // ACTION_DOWN
  b.writeBigInt64BE(-1n, 2); // pointerId i64
  b.writeInt32BE(x, 10); // x
  b.writeInt32BE(y, 14); // y
  b.writeUInt16BE(VIDEO_SIZE.width, 18); // screenSize w (video)
  b.writeUInt16BE(VIDEO_SIZE.height, 20); // screenSize h (video)
  b.writeUInt16BE(0xffff, 22); // pressure 1.0
  b.writeInt32BE(0, 24); // actionButton
  b.writeInt32BE(0, 28); // buttons
  return b;
}

/**
 * Start the server, capture the first two abstract-socket connections
 * (conn1 = video, conn2 = control), snapshot session meta + frames, and
 * synthesize the control-tap bytes. The jar self-deletes once streaming
 * starts, so this re-pushes before the spawn (same as the real adapter).
 */
async function recordSession(serial: string): Promise<{
  meta: Buffer;
  aFrames: Buffer;
  control: Buffer;
}> {
  const scid = freshScid();
  const port = 47_000 + Math.floor(Math.random() * 2_000);
  const name = `scrcpy_${scid}`;
  const cmd = buildSpawnCmd(scid);

  await pushJar(serial);
  await sh(["adb", "-s", serial, "reverse", `localabstract:${name}`, `tcp:${port}`]);

  const sockets: Socket[] = [];
  const videoChunks: Buffer[] = [];
  const server = createServer((sock) => {
    sockets.push(sock);
    // Attach immediately: the server streams as soon as it connects, and the
    // session header + CONFIG AU can arrive within the first TCP segment.
    if (sockets.length === 1) {
      sock.on("data", (c: Buffer) => videoChunks.push(c));
    }
  });
  await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));

  const proc = Bun.spawn(["adb", "-s", serial, "shell", cmd], { stdout: "ignore", stderr: "pipe" });
  const stderrP = new Response(proc.stderr).text();

  try {
    // Wait for the server to connect + emit session + frames.
    for (let i = 0; i < 20 && sockets.length < 2; i++) await sleep(500);
    if (sockets.length < 2) {
      throw new Error(
        `expected 2 connections, got ${sockets.length}; server stderr: ${(await stderrP).slice(0, 400) || "(none)"}`,
      );
    }
    const video = sockets[0]!;
    // First IDR is a few frames in; enough to capture config + IDR.
    await sleep(3_000);
  } finally {
    stopProcess(proc);
    server.close();
    await sh(["adb", "-s", serial, "reverse", "--remove-all"]).catch(() => {});
    await sh(["adb", "-s", serial, "shell", "rm", "-f", JAR_DEV]).catch(() => {});
  }

  const videoBuf = Buffer.concat(videoChunks);
  if (videoBuf.length < 92) throw new Error(`video stream too short: ${videoBuf.length}B`);

  // 64B device meta + 4B codec id + 12B session meta + 12B first frame-meta.
  const meta = Buffer.from(videoBuf.subarray(0, 92));

  // Collect self-contained frames from the first frame-meta (offset 80):
  // 12B frame-meta + AU pairs — frame 0 is the CONFIG AU (SPS+PPS).
  const aFrames: Buffer[] = [];
  let off = 80;
  while (off + 12 <= videoBuf.length) {
    const len = videoBuf.readUInt32BE(off + 8);
    const end = off + 12 + len;
    if (end > videoBuf.length) break;
    aFrames.push(Buffer.from(videoBuf.subarray(off, end)));
    off = end;
  }
  if (aFrames.length === 0) throw new Error("no complete frames captured before stream ended");

  return {
    meta,
    aFrames: Buffer.concat(aFrames),
    control: Buffer.from(serializeTap(TAP_VIDEO.x, TAP_VIDEO.y)),
  };
}

function stopProcess(proc: { kill: () => void }): void {
  try {
    proc.kill();
  } catch {
    // already dead
  }
}

async function writeTrace(
  name: string,
  bytes: Buffer,
  provenance: StreamProvenance,
): Promise<void> {
  const env: TraceEnvelope = { bytes: bytes.length, provenance };
  await writeFile(join(FIXTURES_DIR, `${name}.bin`), bytes);
  await writeFile(join(FIXTURES_DIR, `${name}.json`), `${JSON.stringify(env, null, 2)}\n`);
  console.log(`wrote ${name}.bin (${bytes.length}B)`);
}

async function main(): Promise<void> {
  const serial = process.env.ANDROID_DEVICE ?? "emulator-5554";
  console.log(`recording stream fixtures from ${serial} (scrcpy-server v${SCRCPY_VERSION})`);
  await mkdir(FIXTURES_DIR, { recursive: true });

  const rec = await recordSession(serial);
  const [device, jarSha] = await Promise.all([
    sh(["adb", "-s", serial, "shell", "getprop", "ro.product.model"]).then((s) => s.trim()),
    sha256Of(JAR_LOCAL),
  ]);
  const capturedAt = new Date().toISOString();
  const base = {
    tool: "scrcpy" as const,
    version: SCRCPY_VERSION,
    capturedAt,
    details: {
      serial,
      device,
      jarSha256: jarSha,
      spawnCmd: buildSpawnCmd("0x00000000"),
      videoSize: VIDEO_SIZE,
    },
  };

  await writeTrace("stream-meta", rec.meta, { ...base, context: "session-meta" });
  await writeTrace("stream-a-frames", rec.aFrames, { ...base, context: "video-frames" });
  await writeTrace("stream-control", rec.control, { ...base, context: "control-tap" });
  console.log("done");
}

main().catch((err) => {
  console.error("stream fixture recording failed:", err);
  process.exit(1);
});