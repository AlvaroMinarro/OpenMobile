/**
 * Fan-out viewer registry (design D4): per-viewer FIFO queues with drop-oldest
 * backpressure, a hard viewer cap, and teardown cleanup.
 *
 * The video read loop NEVER blocks on a slow viewer: each viewer gets its own
 * depth-bounded queue; when the queue is full the OLDEST undelivered frame is
 * dropped (spec: Slow viewer). When the cap is reached, new viewers are
 * rejected and closed with a JSON error (spec: Viewer cap reached).
 */

import {
  MAX_VIEWERS,
  VIEWER_QUEUE_DEPTH,
  type FanoutRegistry,
  type StreamStateMessage,
  type StreamViewer,
} from "./types";

export class Fanout implements FanoutRegistry {
  private readonly viewers = new Map<string, StreamViewer>();
  /** Depth-bounded FIFO per viewer (drop-oldest when full). */
  private readonly queues = new Map<string, Uint8Array[]>();
  /** Drain workers per viewer — one at a time, so writes stay ordered. */
  private readonly draining = new Set<string>();

  get count(): number {
    return this.viewers.size;
  }

  add(viewer: StreamViewer): boolean {
    if (this.viewers.size >= MAX_VIEWERS) {
      viewer.close();
      return false;
    }
    this.viewers.set(viewer.id, viewer);
    this.queues.set(viewer.id, []);
    return true;
  }

  remove(id: string): boolean {
    this.queues.delete(id);
    return this.viewers.delete(id);
  }

  broadcast(frame: Uint8Array): void {
    for (const [id, viewer] of [...this.viewers]) {
      if (!viewer.open) {
        this.remove(id);
        continue;
      }
      const queue = this.queues.get(id);
      if (!queue) continue;
      if (queue.length >= VIEWER_QUEUE_DEPTH) queue.shift(); // drop oldest
      queue.push(frame);
      // Kick the drainer (no-op while one is already running).
      void this.drain(id);
    }
  }

  /** Deliver queued frames in order; stops as soon as the viewer closes. */
  private async drain(id: string): Promise<void> {
    if (this.draining.has(id)) return;
    this.draining.add(id);
    try {
      const viewer = this.viewers.get(id);
      const queue = this.queues.get(id);
      if (!viewer || !queue) return;
      while (queue.length > 0 && viewer.open) {
        await viewer.sendFrame(queue.shift()!);
      }
    } finally {
      this.draining.delete(id);
    }
  }

  /**
   * Deliver a state message to every registered viewer. Advisory (design D2):
   * a viewer that fails to accept it is reaped — the session teardown closes
   * the socket anyway.
   */
  broadcastState(state: StreamStateMessage): void {
    for (const [id, viewer] of [...this.viewers]) {
      if (!viewer.open) {
        this.remove(id);
        continue;
      }
      try {
        void viewer.sendState(state);
      } catch {
        // viewer write failure — closeAll() on teardown handles it
      }
    }
  }

  closeAll(): void {
    for (const viewer of this.viewers.values()) viewer.close();
    this.viewers.clear();
    this.queues.clear();
    this.draining.clear();
  }
}