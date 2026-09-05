/**
 * Fan-out viewer registry (design D4 retarget, task 2.5): a hard viewer cap
 * (MAX_VIEWERS=8 — ours, not the emulator's) and teardown cleanup.
 *
 * The JSEP video path carries JSON signaling frames only (spec: the WS MUST
 * NOT carry binary video frames), and per-viewer offer/answer relaying is
 * the RtcSession's job — so the registry has NO frame queues: `broadcast` is
 * an advisory direct send (a failed write is reaped), never backpressured.
 */

import { MAX_VIEWERS, type FanoutRegistry, type RtcServerMessage, type StreamViewer } from "./types";

export class Fanout implements FanoutRegistry {
  private readonly viewers = new Map<string, StreamViewer>();

  get count(): number {
    return this.viewers.size;
  }

  add(viewer: StreamViewer): boolean {
    if (this.viewers.size >= MAX_VIEWERS) {
      viewer.close();
      return false;
    }
    this.viewers.set(viewer.id, viewer);
    return true;
  }

  remove(id: string): boolean {
    return this.viewers.delete(id);
  }

  broadcast(msg: RtcServerMessage): void {
    for (const [id, viewer] of [...this.viewers]) {
      if (!viewer.open) {
        this.remove(id);
        continue;
      }
      try {
        void viewer.sendMessage(msg);
      } catch {
        // viewer write failure — closeAll() on teardown closes the socket
      }
    }
  }

  closeAll(): void {
    for (const viewer of this.viewers.values()) viewer.close();
    this.viewers.clear();
  }
}
