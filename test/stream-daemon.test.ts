import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryRunner } from "./helpers/memoryRunner";
import {
  StreamAssembler,
  StreamSession,
  buildHandshake,
  type DaemonListener,
  type DaemonSocket,
  type SpawnHandle,
} from "../src/stream/daemon";
import { buildSpawnCmd } from "../src/stream/scrcpy";
import { parseDeviceMeta, splitAnnexB } from "../src/stream/wire";
import type { StreamViewer, VideoHandshake } from "../src/stream/types";

const SERIAL = "emulator-5554";
const SCID = "deadbeef";
const FIX = join(import.meta.dir, "fixtures");

/**
 * Rebuild the EXACT byte stream a live video socket carries: 64B device meta
 * + 4B codec + 12B session meta, then [12B frame meta][Annex-B AU] pairs —
 * mirroring record-stream-fixture.ts (stream-meta.bin holds the 80B header +
 * the first 12B CONFIG frame-meta; stream-a-frames.bin holds the frame pairs).
 */
function wireStream(): Buffer {
  const meta = readFileSync(join(FIX, "stream-meta.bin"));
  const frames = readFileSync(join(FIX, "stream-a-frames.bin"));
  // stream-meta.bin: 80B header + the 12B CONFIG frame-meta; frames.bin
  // starts with the SAME 12B frame-meta + the AU. Use only the 80B header.
  return Buffer.concat([meta.subarray(0, 80), frames]);
}

/** Minimal viewer double (same shape as the fanout tests). */
class FakeViewer implements StreamViewer {
  readonly id: string;
  frames: Uint8Array[] = [];
  open = true;
  closed = 0;
  constructor(id: string) {
    this.id = id;
  }
  async sendHandshake(): Promise<void> {}
  async sendFrame(f: Uint8Array): Promise<void> {
    this.frames.push(f);
  }
  async sendState(): Promise<void> {}
  close(): void {
    this.open = false;
    this.closed++;
  }
}

class FakeSocket implements DaemonSocket {
  destroyed = false;
  private dataCbs: Array<(c: Uint8Array) => void> = [];
  private closeCbs: Array<() => void> = [];
  private errorCbs: Array<(e: unknown) => void> = [];
  on(event: "data" | "close" | "error", cb: (...args: unknown[]) => void): void {
    if (event === "data") this.dataCbs.push(cb as (c: Uint8Array) => void);
    if (event === "close") this.closeCbs.push(cb as () => void);
    if (event === "error") this.errorCbs.push(cb as (e: unknown) => void);
  }
  write(_c: Uint8Array): void {
    // recorded by tests that override it
  }
  destroy(): void {
    this.destroyed = true;
  }
  emitData(c: Uint8Array): void {
    for (const cb of this.dataCbs) cb(c);
  }
  emitClose(): void {
    for (const cb of this.closeCbs) cb();
  }
  emitError(e: unknown): void {
    for (const cb of this.errorCbs) cb(e);
  }
}

class FakeListener implements DaemonListener {
  port = 47832;
  closed = false;
  conns: FakeSocket[] = [];
  private connCbs: Array<(s: DaemonSocket) => void> = [];
  listen(): Promise<void> {
    return Promise.resolve();
  }
  onConnection(cb: (s: DaemonSocket) => void): void {
    this.connCbs.push(cb);
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  /** Emulate the device connecting out: conn1=video, conn2=control. */
  connect(): FakeSocket {
    const s = new FakeSocket();
    this.conns.push(s);
    for (const cb of this.connCbs) cb(s);
    return s;
  }
}

class FakeSpawn implements SpawnHandle {
  killed = false;
  private readonly exitCode?: number;
  constructor(exitCode?: number) {
    this.exitCode = exitCode;
  }
  kill(): void {
    this.killed = true;
  }
  get exited(): Promise<number> {
    return this.exitCode === undefined ? new Promise(() => {}) : Promise.resolve(this.exitCode);
  }
}

describe("StreamAssembler — video socket byte accumulation (daemon read-loop core)", () => {
  it("parses the 80B header then emits every Annex-B AU + builds the handshake from the CONFIG frame", () => {
    const asm = new StreamAssembler();
    const wire = wireStream();
    const { handshake, frames } = asm.ingest(wire);
    expect(handshake).toBeDefined();
    expect(handshake!.codec).toBe("h264");
    expect(handshake!.lengthSize).toBe(12);
    expect(handshake!.width).toBe(430);
    expect(handshake!.height).toBe(960);
    // Recorded SPS/PPS NALs (after the start code), base64 — assert the
    // exact bytes (fixture provenance: emulator-5554, v4.1).
    expect(handshake!.sps).toBe("Z0LAKY1oGweeuQgICAg8IhGo");
    expect(handshake!.pps).toBe("aM4BqDXI");
    // 2 (SPS+PPS) + 1 IDR + 10 slices = 13 AUs, every one Annex-B prefixed.
    expect(frames.length).toBe(13);
    for (const au of frames) {
      expect(Buffer.from(au.subarray(0, 4)).toString("hex")).toBe("00000001");
    }
    expect(Buffer.from(frames[0]!).toString("hex")).toContain("6742c029"); // SPS
    expect(Buffer.from(frames[1]!).toString("hex")).toContain("68ce01a8"); // PPS
  });

  it("tolerates TCP segmentation: 7-byte chunks yield the SAME frames + handshake", () => {
    const wire = wireStream();
    const whole = new StreamAssembler();
    const wholeRes = whole.ingest(wire);

    const chunked = new StreamAssembler();
    let got: Uint8Array[] = [];
    let handshake: VideoHandshake | undefined;
    for (let i = 0; i < wire.length; i += 7) {
      const r = chunked.ingest(wire.subarray(i, i + 7));
      got = got.concat(r.frames);
      if (r.handshake) handshake = r.handshake;
    }
    expect(handshake ?? null).toEqual(wholeRes.handshake);
    expect(got).toHaveLength(wholeRes.frames.length);
    // Byte-identical AUs in order (a frame split across segments must not
    // be emitted garbage).
    got.forEach((au, i) => {
      expect(Buffer.from(au).toString("hex")).toBe(
        Buffer.from(wholeRes.frames[i]!).toString("hex"),
      );
    });
  });

  it("emits frames as soon as their payload is complete, one frame at a time", () => {
    const asm = new StreamAssembler();
    const wire = wireStream();
    const first = asm.ingest(wire.subarray(0, 64 + 4 + 12 + 12 + 8)); // header + fm + 8B of the SPS AU
    expect(first.frames).toHaveLength(0); // config payload incomplete
    const rest = asm.ingest(wire.subarray(64 + 4 + 12 + 12 + 8));
    expect(rest.frames.length).toBeGreaterThanOrEqual(1);
  });

  it("yields no handshake when the stream carries only slices (no CONFIG frame yet)", () => {
    const asm = new StreamAssembler();
    const wire = wireStream();
    // Skip the CONFIG frame: header + IDR + slices only.
    const configLen = wire.readUInt32BE(80 + 8);
    const noConfig = Buffer.concat([wire.subarray(0, 80), wire.subarray(80 + 12 + configLen)]);
    const { handshake, frames } = asm.ingest(noConfig);
    expect(handshake).toBeNull();
    expect(frames.length).toBeGreaterThanOrEqual(1); // IDR + slices still flow
  });
});

describe("buildHandshake — SPS/PPS extraction (design D2)", () => {
  it("extracts both NALs from the recorded CONFIG AU (SPS then PPS)", () => {
    const meta = parseDeviceMeta(readFileSync(join(FIX, "stream-meta.bin")).subarray(0, 80));
    const frames = readFileSync(join(FIX, "stream-a-frames.bin"));
    const len = frames.readUInt32BE(8);
    const configPayload = frames.subarray(12, 12 + len);
    const aus = splitAnnexB(configPayload);
    expect(aus).toHaveLength(2);
    const hs = buildHandshake(meta, aus);
    expect(hs).not.toBeNull();
    expect(hs!.sps).toBe("Z0LAKY1oGweeuQgICAg8IhGo");
    expect(hs!.pps).toBe("aM4BqDXI");
    expect(hs!.width).toBe(430);
    expect(hs!.height).toBe(960);
  });

  it("returns null when either NAL is missing (no SPS = not decodable)", () => {
    const meta = parseDeviceMeta(readFileSync(join(FIX, "stream-meta.bin")).subarray(0, 80));
    const spsOnly = Uint8Array.from([0, 0, 0, 1, 0x67, 0x42, 0xc0]);
    expect(buildHandshake(meta, [spsOnly])).toBeNull();
    const ppsOnly = Uint8Array.from([0, 0, 0, 1, 0x68, 0xce, 0x01]);
    expect(buildHandshake(meta, [ppsOnly])).toBeNull();
  });
});

describe("StreamSession — push→listen→reverse→spawn→read-loop→fan-out (design D5)", () => {
  function makeSession(opts: {
    runner: MemoryRunner;
    spawn?: (argv: string[]) => FakeSpawn;
    exitCode?: number;
  }): { session: StreamSession; listener: FakeListener; spawned: string[] } {
    const spawned: string[] = [];
    const listener = new FakeListener();
    const spawn = opts.spawn ?? ((argv: string[]) => {
      spawned.push(argv.join(" "));
      return new FakeSpawn(opts.exitCode);
    });
    const session = new StreamSession({
      runner: opts.runner,
      serial: SERIAL,
      scid: SCID,
      listenerFactory: () => listener,
      spawnFn: spawn as (argv: string[]) => SpawnHandle,
    });
    return { session, listener, spawned };
  }

  it("runs push → reverse (scid socket) → spawn in order with the EXACT adb argv", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", SERIAL, "push", expectJarPath(), "/data/local/tmp/scrcpy-server.jar"], { stdout: "1 file pushed" });
    runner.expect(["adb", "-s", SERIAL, "reverse", `localabstract:scrcpy_${SCID}`, "tcp:47832"], { stdout: "" });
    const { session, spawned } = makeSession({ runner });
    await session.start();
    runner.assertSatisfied();
    expect(runner.calls[0]).toEqual(["adb", "-s", SERIAL, "push", expectJarPath(), "/data/local/tmp/scrcpy-server.jar"]);
    expect(runner.calls[1]).toEqual(["adb", "-s", SERIAL, "reverse", `localabstract:scrcpy_${SCID}`, "tcp:47832"]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toBe(`adb -s ${SERIAL} shell ${buildSpawnCmd(SCID)}`);
  });

  it("read-loop: conn1 bytes → handshakeReady + every AU broadcast to the fanout", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", SERIAL, "push", expectJarPath(), "/data/local/tmp/scrcpy-server.jar"], {});
    runner.expect(["adb", "-s", SERIAL, "reverse", `localabstract:scrcpy_${SCID}`, "tcp:47832"], {});
    const { session, listener } = makeSession({ runner });
    await session.start();
    const viewer = new FakeViewer("v1");
    session.fanout.add(viewer);
    const sock = listener.connect(); // conn1 = video
    // Feed the stream across multiple data events with small gaps so the
    // fanout drain keeps up (drop-oldest is a live-stream property, not a
    // replay property — an all-at-once burst legitimately drops old frames).
    const wire = wireStream();
    for (let i = 0; i < wire.length; i += 1024) {
      sock.emitData(wire.subarray(i, i + 1024));
      await new Promise((r) => setTimeout(r, 1));
    }
    const hs = await session.handshakeReady;
    expect(hs.codec).toBe("h264");
    expect(hs.width).toBe(430);
    await new Promise((r) => setTimeout(r, 5));
    expect(viewer.frames.length).toBeGreaterThanOrEqual(13);
    expect(Buffer.from(viewer.frames[0]!).toString("hex")).toContain("6742c029");
    session.close();
  });

  it("control-reader: conn2 consumes inbound bytes without error", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", SERIAL, "push", expectJarPath(), "/data/local/tmp/scrcpy-server.jar"], {});
    runner.expect(["adb", "-s", SERIAL, "reverse", `localabstract:scrcpy_${SCID}`, "tcp:47832"], {});
    const { session, listener } = makeSession({ runner });
    await session.start();
    const ctrl = listener.connect(); // conn2 = control
    ctrl.emitData(Uint8Array.from([0, 1, 2, 3])); // server never writes, but must not throw
    ctrl.emitClose();
    session.close();
  });

  it("sendControl writes bytes to the CONTROL socket", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", SERIAL, "push", expectJarPath(), "/data/local/tmp/scrcpy-server.jar"], {});
    runner.expect(["adb", "-s", SERIAL, "reverse", `localabstract:scrcpy_${SCID}`, "tcp:47832"], {});
    const { session, listener } = makeSession({ runner });
    await session.start();
    listener.connect(); // conn1 = video
    const ctrl = listener.connect(); // conn2 = control
    const written: Uint8Array[] = [];
    ctrl.write = (c: Uint8Array): void => {
      written.push(c);
    };
    await session.sendControl(Buffer.from([2, 0, 0, 0]));
    expect(written[0]![0]).toBe(2);
    session.close();
  });

  it("reports device_lost via onLoss when the spawn exits non-zero (server crash)", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", SERIAL, "push", expectJarPath(), "/data/local/tmp/scrcpy-server.jar"], {});
    runner.expect(["adb", "-s", SERIAL, "reverse", `localabstract:scrcpy_${SCID}`, "tcp:47832"], {});
    const { session } = makeSession({ runner, exitCode: 1 });
    const losses: string[] = [];
    session.onLoss(() => losses.push("lost"));
    await session.start();
    await Promise.resolve(); // let the exited-then fire
    await Promise.resolve();
    await Promise.resolve();
    expect(losses).toEqual(["lost"]);
    expect(session.stateReason).toBe("device_lost");
    session.close();
  });

  it("reports device_lost via onLoss when the video socket closes mid-stream", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", SERIAL, "push", expectJarPath(), "/data/local/tmp/scrcpy-server.jar"], {});
    runner.expect(["adb", "-s", SERIAL, "reverse", `localabstract:scrcpy_${SCID}`, "tcp:47832"], {});
    const { session, listener } = makeSession({ runner });
    const losses: string[] = [];
    session.onLoss(() => losses.push("lost"));
    await session.start();
    const sock = listener.connect(); // video
    sock.emitData(wireStream().subarray(0, 60)); // partial header, then:
    sock.emitClose();
    expect(losses).toEqual(["lost"]);
    expect(session.stateReason).toBe("device_lost");
    session.close();
  });

  it("close() kills the spawn, removes reverse + jar, closes the listener and closes all viewers", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", SERIAL, "push", expectJarPath(), "/data/local/tmp/scrcpy-server.jar"], {});
    runner.expect(["adb", "-s", SERIAL, "reverse", `localabstract:scrcpy_${SCID}`, "tcp:47832"], {});
    runner.expect(["adb", "-s", SERIAL, "reverse", "--remove-all"], { stdout: "" });
    runner.expect(["adb", "-s", SERIAL, "shell", "rm", "-f", "/data/local/tmp/scrcpy-server.jar"], { stdout: "" });
    const spawned: Array<FakeSpawn> = [];
    const { session, listener } = makeSession({
      runner,
      spawn: (argv) => {
        spawned.push(new FakeSpawn());
        return spawned[spawned.length - 1]!;
      },
    });
    await session.start();
    const viewer = new FakeViewer("bye");
    session.fanout.add(viewer);
    session.close();
    runner.assertSatisfied();
    expect(spawned[0]!.killed).toBe(true);
    expect(listener.closed).toBe(true);
    expect(viewer.open).toBe(false);
  });
});

function expectJarPath(): string {
  // Mirror src/stream/scrcpy.ts JAR_LOCAL_PATH resolution.
  return join(import.meta.dir, "..", "assets", "scrcpy-server.jar");
}