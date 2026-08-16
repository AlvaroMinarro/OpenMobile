import { describe, expect, it } from "bun:test";
import { Fanout } from "../src/stream/fanout";
import { MAX_VIEWERS, VIEWER_QUEUE_DEPTH, type StreamViewer } from "../src/stream/types";

/** Minimal viewer double: records what it received. */
class FakeViewer implements StreamViewer {
  readonly id: string;
  frames: Uint8Array[] = [];
  states: unknown[] = [];
  handshakes: unknown[] = [];
  open = true;
  closed = 0;

  constructor(id: string) {
    this.id = id;
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

/** Frame with a distinguishable payload byte. */
function cf(tag: number): Uint8Array {
  return Uint8Array.from([0, 0, 0, 1, tag]);
}

describe("stream fan-out — viewer registry (design D4)", () => {
  it("registers viewers up to the cap and rejects beyond it (Viewer cap reached)", () => {
    const fan = new Fanout();
    for (let i = 0; i < MAX_VIEWERS; i++) {
      expect(fan.add(new FakeViewer(`v${i}`))).toBe(true);
    }
    expect(fan.count).toBe(MAX_VIEWERS);
    const rejected = new FakeViewer("overflow");
    expect(fan.add(rejected)).toBe(false);
    expect(fan.count).toBe(MAX_VIEWERS);
    expect(rejected.closed).toBe(1); // cap-rejected sockets are closed
  });

  it("drops the OLDEST queued frame per viewer when the queue is full (Slow viewer)", async () => {
    const fan = new Fanout();
    const releases: Array<() => void> = [];
    const deliveries: number[] = [];
    const slow = new FakeViewer("slow");
    slow.sendFrame = async (f: Uint8Array) => {
      await new Promise<void>((r) => releases.push(r));
      deliveries.push(f[4]!);
    };
    fan.add(slow);
    // Broadcast more than the queue depth while the drain is gated on frame 0.
    for (let i = 0; i < VIEWER_QUEUE_DEPTH + 2; i++) {
      fan.broadcast(cf(i));
    }
    // Release gates one at a time, letting the drain produce the next gate.
    for (let i = 0; i <= VIEWER_QUEUE_DEPTH; i++) {
      if (releases.length === 0) break;
      releases.shift()!();
      await new Promise((r) => setTimeout(r, 1));
    }
    // Frame 0 was in-flight; with depth 4 and 6 broadcasts, frame 1 is the
    // OLDEST buffered frame → dropped; newest frames 2..5 delivered in order.
    expect(deliveries).toEqual([0, 2, 3, 4, 5]);
  });

  it("removes a viewer on explicit remove() and stops delivering", () => {
    const fan = new Fanout();
    const v = new FakeViewer("bye");
    fan.add(v);
    expect(fan.remove(v.id)).toBe(true);
    expect(fan.remove(v.id)).toBe(false);
    fan.broadcast(cf(9));
    expect(v.frames).toHaveLength(0);
    expect(fan.count).toBe(0);
  });

  it("keeps delivering to remaining viewers after one is removed", () => {
    const fan = new Fanout();
    const a = new FakeViewer("a");
    const b = new FakeViewer("b");
    fan.add(a);
    fan.add(b);
    fan.remove(a.id);
    fan.broadcast(cf(3));
    expect(a.frames).toHaveLength(0);
    expect(b.frames).toHaveLength(1);
    expect(b.frames[0]![4]).toBe(3);
  });

  it("closeAll() closes every viewer and empties the registry (teardown)", () => {
    const fan = new Fanout();
    const a = new FakeViewer("a");
    const b = new FakeViewer("b");
    fan.add(a);
    fan.add(b);
    fan.closeAll();
    expect(fan.count).toBe(0);
    expect(a.open).toBe(false);
    expect(b.open).toBe(false);
  });

  it("broadcastState delivers the state message to EVERY open viewer", () => {
    const fan = new Fanout();
    const a = new FakeViewer("a");
    const b = new FakeViewer("b");
    fan.add(a);
    fan.add(b);
    fan.broadcastState({ type: "state", state: "streaming" });
    expect(a.states).toContainEqual({ type: "state", state: "streaming" });
    expect(b.states).toContainEqual({ type: "state", state: "streaming" });
  });

  it("broadcastState removes closed viewers and skips them (no ghost delivery)", () => {
    const fan = new Fanout();
    const alive = new FakeViewer("alive");
    const dead = new FakeViewer("dead");
    fan.add(alive);
    fan.add(dead);
    dead.close();
    fan.broadcastState({ type: "state", state: "error", reason: "device_lost" });
    expect(alive.states).toHaveLength(1);
    expect(dead.states).toHaveLength(0);
    expect(fan.count).toBe(1); // the closed viewer was reaped
  });
});