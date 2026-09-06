/**
 * RtcService v1 adapter (design D2, task 2.1) — the conformance seam between
 * the session world and the emulator's `Rtc` gRPC service.
 *
 * The adapter hides the gRPC transport (GrpcRtcClient) behind the flow the
 * probe B conformance run proved live on 36.5.11:
 *   start()  → requestRtcStream → the per-stream opaque guid (RtcId),
 *   receive  → the BLOCKING receiveJsepMessages server stream, decoded into
 *              the verbatim JSEP payload dictionaries ({"start":{}},
 *              {"sdp","type"}, {"candidate",...}, {"bye":true}),
 *   sendJsep → sendJsepMessage, SERIALIZED: parallel gRPC sends reorder, and
 *              the emulator's JSEP state machine is order-sensitive
 *              (candidates before the answer are dropped — probe-b2), so all
 *              sends funnel through one chained promise per adapter.
 *
 * v2 drift is contained HERE: any future proto change breaks this file (and
 * its conformance tests), not the session/gateway/bridge layers.
 */

import type { GrpcRtcClient } from "../../device/grpc";
import { parseJsepPayload, type JsepPayload } from "../types";

/** The v1 adapter surface the RtcSession consumes (design D2). */
export interface RtcAdapter {
  /** requestRtcStream — issues a NEW per-stream opaque guid (RtcId). */
  start(): Promise<string>;
  /** sendJsepMessage for one guid (serialized across the whole adapter). */
  sendJsep(guid: string, payload: string): Promise<void>;
  /**
   * receiveJsepMessages — the blocking server stream for one guid, yielding
   * the decoded verbatim payload dictionaries. Malformed payloads are skipped.
   */
  receive(guid: string): AsyncIterable<JsepPayload>;
  /** Cancel the receive stream for one guid (viewer teardown / bye). */
  cancelReceive(guid: string): void;
  /** General teardown: cancel every open receive stream. */
  stop(): void;
}

export class GrpcRtcAdapter implements RtcAdapter {
  private readonly client: GrpcRtcClient;
  /**
   * Send serialization chain (probe B): each sendJsep is appended here so
   * concurrent callers still reach the emulator in issue order.
   */
  private sendChain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(client: GrpcRtcClient) {
    this.client = client;
  }

  async start(): Promise<string> {
    return this.client.requestRtcStream();
  }

  sendJsep(guid: string, payload: string): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.stopped) return; // teardown already won — drop, don't error late
      await this.client.sendJsepMessage(guid, payload);
    };
    const chained = this.sendChain.then(run, run);
    this.sendChain = chained.catch(() => {}); // keep the chain alive on failure
    return chained;
  }

  receive(guid: string): AsyncIterable<JsepPayload> {
    const self = this;
    const iterate = async function* (): AsyncGenerator<JsepPayload> {
      for await (const wire of self.client.receiveJsepMessages(guid)) {
        const payload = parseJsepPayload(wire.message);
        if (payload === null) continue; // malformed — skip, never crash the relay
        yield payload;
      }
    };
    return {
      [Symbol.asyncIterator]: () => iterate(),
    };
  }

  cancelReceive(guid: string): void {
    this.client.cancelReceive(guid);
  }

  stop(): void {
    if (this.stopped) return;
    // Drain queued sends (the teardown byes) BEFORE tearing the channel
    // down: a stop that lands while sends are in flight must still deliver
    // them (probe-b2: the emulator expects bye after the answer). A send to
    // a dead device fails fast and keeps the chain moving.
    this.sendChain = this.sendChain.then(
      () => {
        this.stopped = true;
        this.client.close();
      },
      () => {
        this.stopped = true;
        this.client.close();
      },
    );
  }
}
