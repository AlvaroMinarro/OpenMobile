import { describe, expect, it } from "bun:test";
import { MemoryRunner } from "./helpers/memoryRunner";
import { StreamGateway } from "../src/stream/gateway";
import { StreamSession } from "../src/stream/daemon";
import type { DaemonListener, DaemonSocket, SpawnHandle } from "../src/stream/daemon";
import type { StreamViewer, VideoHandshake } from "../src/stream/types";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERIAL = "emulator-5554";
const FIX = join(import.meta.dir, "fixtures");

class FakeSocket implements DaemonSocket {
  destroyed = false;
  private dataCbs: Array<(c: Uint8Array) => void> = [];
  private closeCbs: Array<() => void> = [];
  on(event: "data" | "close" | "error", cb: (...args: unknown[]) => void): void {
    if (event === "data") this.dataCbs.push(cb as (c: Uint8Array) => void);
    if (event === "close") this.closeCbs.push(cb as () => void);
  }
  write(_c: Uint8Array): void {
    // replaced by tests that record writes
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
}

class FakeListener implements DaemonListener {
  port = 47000;
  private connCbs: Array<(s: DaemonSocket) => void> = [];
  listen(): Promise<void> {
    return Promise.resolve();
  }
  onConnection(cb: (s: DaemonSocket) => void): void {
    this.connCbs.push(cb);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  connect(): FakeSocket {
    const s = new FakeSocket();
    for (const cb of this.connCbs) cb(s);
    return s;
  }
}

class FakeSpawn implements SpawnHandle {
  kill(): void {}
  get exited(): Promise<number> {
    return new Promise(() => {});
  }
}

class Recorder implements StreamViewer {
  frames: Uint8Array[] = [];
  handshakes: unknown[] = [];
  states: unknown[] = [];
  open = true;
  closed = 0;
  private readonly _id: string;
  constructor(id: string) {
    this._id = id;
  }
  get id(): string {
    return this._id;
  }
  async sendHandshake(h: unknown): Promise<void> {
    this.handshakes.push(h);
  }
  async sendFrame(f: Uint8Array): Promise<void> {
    this.frames.push(f);
  }
  async sendState(s: unknown): Promise<void> {
    this.states.push(s);
  }
  close(): void {
    this.open = false;
    this.closed++;
  }
}

function wireStream(): Buffer {
  const meta = readFileSync(join(FIX, "stream-meta.bin"));
  const frames = readFileSync(join(FIX, "stream-a-frames.bin"));
  return Buffer.concat([meta.subarray(0, 80), frames]);
}

/** Session factory that uses the fake listener + spawn (no adb socket). */
function sessionFactory(runner: MemoryRunner): { factory: (scid: string) => StreamSession; listener: FakeListener } {
  const listener = new FakeListener();
  return {
    listener,
    factory: (scid: string) =>
      new StreamSession({
        runner,
        serial: SERIAL,
        scid,
        listenerFactory: () => listener,
        spawnFn: () => new FakeSpawn(),
      }),
  };
}

function seedRunner(runner: MemoryRunner): void {
  runner.expect(["adb", "-s", SERIAL, "push", join(import.meta.dir, "..", "assets", "scrcpy-server.jar"), "/data/local/tmp/scrcpy-server.jar"], {});
  runner.expect(["adb", "-s", SERIAL, "reverse", `localabstract:scrcpy_`, "tcp:47000"], {}); // scid is random — match prefix
}

describe("StreamGateway — manager + session glue (design D5/D6)", () => {
  it("starts the stream on first subscribe, delivers the handshake + AUs, and reports active", async () => {
    const runner = new MemoryRunner();
    const SCID = "feed1234";
    runner.expect(["adb", "-s", SERIAL, "push", join(import.meta.dir, "..", "assets", "scrcpy-server.jar"), "/data/local/tmp/scrcpy-server.jar"], {});
    runner.expect(["adb", "-s", SERIAL, "reverse", `localabstract:scrcpy_${SCID}`, "tcp:47000"], {});
    const { factory, listener } = sessionFactory(runner);
    const gw = new StreamGateway(
      { runner, serial: SERIAL, enabled: true, scid: SCID, pollDevices: async () => [{ serial: SERIAL, state: "device" }] },
      factory,
    );
    const v = new Recorder("v1");
    const res = await gw.subscribeVideo(v);
    expect(res.ok).toBe(true);
    // Wait for the session to start (async adapter.start).
    for (let i = 0; i < 50 && !gw.managerRef.snapshot().active; i++) await new Promise((r) => setTimeout(r, 10));
    expect(gw.managerRef.snapshot().active).toBe(true);
    expect(runner.calls[0]).toEqual(["adb", "-s", SERIAL, "push", join(import.meta.dir, "..", "assets", "scrcpy-server.jar"), "/data/local/tmp/scrcpy-server.jar"]);
    expect(runner.calls[1]).toEqual(["adb", "-s", SERIAL, "reverse", `localabstract:scrcpy_${SCID}`, "tcp:47000"]);
    // Wait until the socket-facing viewer is attached to the session fanout
    // (subscribe → attachToSession is async; frames before attach are dropped
    // by design — client joins mid-GOP).
    for (let i = 0; i < 50 && gw.attachedViewers < 1; i++) await new Promise((r) => setTimeout(r, 10));
    expect(gw.attachedViewers).toBe(1);
    // The device connects its video socket → the daemon feeds the fanout.
    const sock = listener.connect();
    sock.emitData(wireStream());
    // Handshake delivered once the CONFIG frame is parsed.
    await new Promise((r) => setTimeout(r, 50));
    expect(v.handshakes).toHaveLength(1);
    const hs = v.handshakes[0] as VideoHandshake;
    expect(hs.width).toBe(430);
    expect(hs.height).toBe(960);
    // Frames broadcast (at least the SPS/PPS + some slices arrive).
    expect(v.frames.length).toBeGreaterThanOrEqual(3);
    // /v1/state snapshot reflects the active stream with the video size.
    const snap = gw.snapshot();
    expect(snap.active).toBe(true);
    expect(snap.supported).toBe(true);
    expect(snap.width).toBe(430);
    expect(snap.height).toBe(960);
    // Control writer is live.
    const ctrl = gw.controlActive();
    expect(ctrl).not.toBeNull();
    const ctrlSock = listener.connect(); // conn2
    const written: Uint8Array[] = [];
    ctrlSock.write = (c: Uint8Array): void => {
      written.push(c);
    };
    await ctrl!.write([Buffer.from([2, 0, 0, 0])]);
    expect(written[0]![0]).toBe(2);
    // Last unsubscribe tears the session down.
    gw.unsubscribeVideo(v.id);
    for (let i = 0; i < 50 && gw.managerRef.snapshot().active; i++) await new Promise((r) => setTimeout(r, 10));
    expect(gw.managerRef.snapshot().active).toBe(false);
    expect(gw.snapshot().viewers).toBe(0);
  });

  it("reports UNSUPPORTED when the kill-switch is off", async () => {
    const runner = new MemoryRunner();
    const gw = new StreamGateway(
      { runner, serial: SERIAL, enabled: false },
      sessionFactory(runner).factory,
    );
    expect(gw.snapshot().supported).toBe(false);
    const res = await gw.subscribeVideo(new Recorder("v2"));
    expect(res).toEqual({ ok: false, code: "UNSUPPORTED", reason: "OPENMOBILE_STREAM=off" });
  });
});