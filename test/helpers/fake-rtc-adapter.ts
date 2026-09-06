import type { RtcAdapter } from "../../src/stream/rtc/adapter";
import type { JsepPayload } from "../../src/stream/types";

/**
 * In-memory RtcAdapter double (session/gateway tests). Mirrors the emulator's
 * blocking JSEP stream semantics: the test plays the emulator side with
 * push(), inspects sendJsepMessage payloads via sendsFor(), and teardown is
 * observable through cancelled/stopped.
 */
export class FakeRtcAdapter implements RtcAdapter {
  started = 0;
  sends: Array<{ guid: string; payload: string }> = [];
  cancelled: string[] = [];
  stopped = 0;
  failStart: Error | undefined;
  private queues = new Map<string, JsepPayload[]>();
  private waiters = new Map<string, Array<(p: JsepPayload | null) => void>>();
  private ended = new Set<string>();

  async start(): Promise<string> {
    if (this.failStart) throw this.failStart;
    this.started += 1;
    const guid = `guid-${this.started}`;
    this.queues.set(guid, []);
    return guid;
  }

  async sendJsep(guid: string, payload: string): Promise<void> {
    this.sends.push({ guid, payload });
  }

  receive(guid: string): AsyncIterable<JsepPayload> {
    const self = this;
    const iterate = async function* () {
      for (;;) {
        const queue = self.queues.get(guid) ?? [];
        const next = queue.shift();
        self.queues.set(guid, queue);
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (self.ended.has(guid)) return;
        const waiters = self.waiters.get(guid) ?? [];
        self.waiters.set(guid, waiters);
        const resume = await new Promise<JsepPayload | null>((resolve) => waiters.push(resolve));
        if (resume === null) return;
      }
    };
    return { [Symbol.asyncIterator]: () => iterate() };
  }

  /** Emulator side: push a JSEP payload into the stream for guid. */
  push(guid: string, payload: JsepPayload): void {
    const queue = this.queues.get(guid) ?? [];
    queue.push(payload);
    this.queues.set(guid, queue);
    const waiting = this.waiters.get(guid) ?? [];
    const next = waiting.shift();
    if (next) next(payload);
  }

  cancelReceive(guid: string): void {
    this.cancelled.push(guid);
    this.ended.add(guid);
    for (const w of this.waiters.get(guid) ?? []) w(null);
    this.waiters.set(guid, []);
  }

  stop(): void {
    this.stopped += 1;
  }

  /** Decoded payloads the adapter sent for one guid. */
  sendsFor(guid: string): unknown[] {
    return this.sends.filter((s) => s.guid === guid).map((s) => JSON.parse(s.payload));
  }
}
