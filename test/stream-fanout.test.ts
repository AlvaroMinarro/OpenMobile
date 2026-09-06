import { describe, expect, it } from "bun:test";
import { Fanout } from "../src/stream/fanout";
import { MAX_VIEWERS, type RtcServerMessage, type StreamViewer } from "../src/stream/types";

/**
 * Fanout — the JSEP-era viewer registry (task 2.5 retarget). The binary
 * frame world (per-viewer AU queues, drop-oldest backpressure) is GONE with
 * the in-guest encoder: a video socket carries JSON JSEP signaling only
 * (spec: the WS MUST NOT carry binary video frames). What the registry keeps
 * is the cap (design D4, MAX_VIEWERS=8 — ours, not the emulator's), open-
 * viewer reaping, and the teardown close-all.
 */

class FakeViewer implements StreamViewer {
  readonly id: string;
  messages: RtcServerMessage[] = [];
  open = true;
  closeCount = 0;

  constructor(id: string) {
    this.id = id;
  }

  async sendMessage(msg: RtcServerMessage): Promise<void> {
    this.messages.push(msg);
  }

  close(): void {
    this.open = false;
    this.closeCount += 1;
  }
}

describe("stream fanout — JSEP viewer registry (design D4 retarget)", () => {
  it("registers viewers up to the cap and rejects beyond it (Viewer cap reached)", () => {
    const fan = new Fanout();
    for (let i = 0; i < MAX_VIEWERS; i++) {
      expect(fan.add(new FakeViewer(`v${i}`))).toBe(true);
    }
    expect(fan.count).toBe(MAX_VIEWERS);
    const rejected = new FakeViewer("overflow");
    expect(fan.add(rejected)).toBe(false);
    expect(fan.count).toBe(MAX_VIEWERS);
    expect(rejected.closeCount).toBe(1); // cap-rejected sockets are closed
  });

  it("broadcasts a signaling message to every registered viewer", () => {
    const fan = new Fanout();
    const a = new FakeViewer("a");
    const b = new FakeViewer("b");
    fan.add(a);
    fan.add(b);
    fan.broadcast({ type: "state", state: "error", reason: "device_lost" });
    expect(a.messages).toEqual([{ type: "state", state: "error", reason: "device_lost" }]);
    expect(b.messages).toEqual([{ type: "state", state: "error", reason: "device_lost" }]);
  });

  it("reaps closed viewers on broadcast and skips them (no ghost delivery)", () => {
    const fan = new Fanout();
    const alive = new FakeViewer("alive");
    const dead = new FakeViewer("dead");
    fan.add(alive);
    fan.add(dead);
    dead.close();
    fan.broadcast({ type: "state", state: "streaming" });
    expect(alive.messages).toHaveLength(1);
    expect(dead.messages).toHaveLength(0);
    expect(fan.count).toBe(1); // the closed viewer was reaped
  });

  it("remove() detaches a viewer and stops delivery", () => {
    const fan = new Fanout();
    const v = new FakeViewer("bye");
    fan.add(v);
    expect(fan.remove(v.id)).toBe(true);
    expect(fan.remove(v.id)).toBe(false);
    fan.broadcast({ type: "state", state: "streaming" });
    expect(v.messages).toHaveLength(0);
    expect(fan.count).toBe(0);
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
    expect(a.closeCount).toBe(1);
    expect(b.closeCount).toBe(1);
  });
});
