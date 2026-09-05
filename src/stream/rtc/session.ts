/**
 * RtcSession — the per-viewer RTC stream broker (tasks 2.2/2.3, design D2).
 *
 * ONE session per bridge×serial (the StreamManager adapter session). Every
 * attached viewer gets its OWN RtcService v1 stream: `attach` runs
 * requestRtcStream → sends the handshake (first frame, always before any
 * offer) → pumps the blocking receive stream into that viewer. Viewer
 * answers/ICE ride sendJsepMessage back.
 *
 * probe-b2 (design §JSEP ordering): the emulator DROPS ICE candidates that
 * arrive before the answer ("The remote description was null"). The session
 * therefore buffers a viewer's candidates until its answer is sent, then
 * flushes them in order — and the adapter serializes sends underneath.
 *
 * Watchdog (task 2.3): while any viewer is attached, a getStatus probe is
 * polled; a failing probe = emulator loss → onLoss fires (the gateway tears
 * the manager session down, closing every viewer socket with 4409) and the
 * session self-tears-down (bye + receive cancellation).
 */

import {
  type JsepPayload,
  type RtcIceCandidateInit,
  type RtcServerMessage,
  type StreamViewer,
} from "../types";
import type { RtcAdapter } from "./adapter";

/** Close-code mapped session failure (spec: Error States). */
export type RtcSessionErrorCode = "PERMISSION_DENIED" | "NO_DEVICE" | "STREAM_FAILED";

export class RtcSessionError extends Error {
  readonly code: RtcSessionErrorCode;
  readonly wsCloseCode: number;

  constructor(code: RtcSessionErrorCode, message: string, wsCloseCode: number) {
    super(message);
    this.name = "RtcSessionError";
    this.code = code;
    this.wsCloseCode = wsCloseCode;
  }
}

export interface RtcSessionDeps {
  /** Serial this session streams (AdapterSession contract with the manager). */
  serial: string;
  /** The v1 adapter (GrpcRtcAdapter in prod; a double in tests). */
  adapter: RtcAdapter;
  /** Configured -rtcfps value reported in the handshake and /v1/state. */
  fps: number;
  /** Codecs reported in the handshake. Default ["VP8"] (mandatory, design). */
  codecs?: string[];
  /** getStatus watchdog probe (task 2.3). Absent ⇒ no watchdog. */
  probe?: () => Promise<void>;
  /** Watchdog poll interval ms. Default 3000. */
  watchdogMs?: number;
  /** Fires ONCE on emulator loss (the gateway tears the whole stack down). */
  onLoss?: () => void;
}

/** Per-viewer stream state. */
interface ViewerStream {
  viewer: StreamViewer;
  guid: string;
  /** Client answer relayed yet? (candidates buffer until it has.) */
  answered: boolean;
  /** Candidate payload strings buffered before the answer (probe-b2). */
  pending: string[];
  /** The emulator hung up (bye) — the stream is over, never re-teardown. */
  ended: boolean;
}

export class RtcSession {
  readonly serial: string;
  private readonly adapter: RtcAdapter;
  private readonly fps: number;
  private readonly codecs: string[];
  private readonly probe: (() => Promise<void>) | undefined;
  private readonly watchdogMs: number;
  private streams = new Map<string, ViewerStream>();
  private closed = false;
  private watchdogTimer: ReturnType<typeof setInterval> | undefined;
  private lossHandler: (() => void) | undefined;
  private lossFired = false;
  /** Fires once per stream: the emulator side hung up (bye). */
  onStreamEnded?: (viewerId: string) => void;

  constructor(deps: RtcSessionDeps) {
    this.serial = deps.serial;
    this.adapter = deps.adapter;
    this.fps = deps.fps;
    this.codecs = deps.codecs ?? ["VP8"];
    this.probe = deps.probe;
    this.watchdogMs = deps.watchdogMs ?? 3000;
    if (deps.onLoss) this.lossHandler = deps.onLoss;
  }

  /** AdapterSession contract: register the loss callback (fires on loss). */
  onLoss(cb: (() => void) | undefined): void {
    this.lossHandler = cb ?? undefined;
  }

  get active(): boolean {
    return !this.closed && this.streams.size > 0;
  }

  get viewers(): number {
    return this.streams.size;
  }

  /** First active stream's guid (the /v1/state `stream.rtc.guid` surface). */
  get guid(): string | undefined {
    return this.streams.values().next().value?.guid;
  }

  /**
   * Attach a viewer: requestRtcStream → handshake (FIRST frame) → receive
   * pump. Throws RtcSessionError mapped onto the spec close codes when the
   * RtcStream cannot start (4404) or is permission-blocked (4401).
   */
  async attach(viewer: StreamViewer): Promise<void> {
    if (this.closed) {
      throw new RtcSessionError("STREAM_FAILED", "the rtc session is closed", 4404);
    }
    let guid: string;
    try {
      guid = await this.adapter.start();
    } catch (e) {
      throw this.mapStartError(e);
    }
    const entry: ViewerStream = { viewer, guid, answered: false, pending: [], ended: false };
    this.streams.set(viewer.id, entry);
    try {
      const handshake: RtcServerMessage = {
        type: "handshake",
        rtcId: guid,
        fps: this.fps,
        codecs: [...this.codecs],
      };
      await viewer.sendMessage(handshake);
    } catch (e) {
      this.streams.delete(viewer.id);
      this.teardownStream(guid, entry);
      throw new RtcSessionError(
        "STREAM_FAILED",
        `handshake delivery failed: ${e instanceof Error ? e.message : String(e)}`,
        4404,
      );
    }
    this.armWatchdog();
    void this.receiveLoop(entry);
  }

  /**
   * Client answer for one viewer's stream. Flushes any candidates buffered
   * BEFORE it (probe-b2: the emulator drops candidates without a remote
   * description), then passes later candidates straight through.
   */
  async relayAnswer(viewerId: string, sdp: string): Promise<void> {
    const entry = this.streams.get(viewerId);
    if (!entry || entry.ended) return;
    try {
      await this.adapter.sendJsep(entry.guid, JSON.stringify({ type: "answer", sdp }));
      entry.answered = true;
      const pending = entry.pending;
      entry.pending = [];
      for (const payload of pending) {
        await this.adapter.sendJsep(entry.guid, payload);
      }
    } catch {
      // Send failed (device gone mid-relay): the stream is unusable.
      this.failStream(viewerId);
    }
  }

  /** Client ICE candidate — buffered until the answer is sent (probe-b2). */
  async relayIce(viewerId: string, candidate: RtcIceCandidateInit): Promise<void> {
    const entry = this.streams.get(viewerId);
    if (!entry || entry.ended) return;
    const payload = JSON.stringify(candidate);
    if (!entry.answered) {
      entry.pending.push(payload);
      return;
    }
    try {
      await this.adapter.sendJsep(entry.guid, payload);
    } catch {
      this.failStream(viewerId);
    }
  }

  /** Client reports its peer connected → echo the state:streaming frame. */
  noteStreaming(viewerId: string): void {
    const entry = this.streams.get(viewerId);
    if (!entry || entry.ended) return;
    try {
      void entry.viewer.sendMessage({ type: "state", state: "streaming" });
    } catch {
      // viewer write failure — teardown closes the socket anyway
    }
  }

  /**
   * The viewer's socket closed (or the gateway released it): bye:true + the
   * receive stream cancelled for THAT guid only; other viewers keep flowing.
   */
  detach(viewerId: string): void {
    const entry = this.streams.get(viewerId);
    if (!entry) return;
    this.streams.delete(viewerId);
    this.teardownStream(entry.guid, entry);
    if (this.streams.size === 0) this.disarmWatchdog();
  }

  /**
   * Full teardown (manager stop / loss): bye for every open stream and the
   * viewers are closed — that close is the 4409 DEVICE_LOST path when the
   * session ends under still-attached viewers (emulator loss); on a normal
   * last-viewer teardown the sockets are already gone, so it is a no-op.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.disarmWatchdog();
    for (const [viewerId, entry] of [...this.streams]) {
      this.streams.delete(viewerId);
      const wasOpen = !entry.ended;
      this.teardownStream(entry.guid, entry);
      if (wasOpen) {
        try {
          entry.viewer.close();
        } catch {
          // best effort — the socket layer reaps dead sockets
        }
      }
    }
    this.adapter.stop();
  }

  /** Force one watchdog poll now (tests drive this; prod runs the interval). */
  async poke(): Promise<void> {
    if (!this.active || !this.probe) return;
    try {
      await this.probe();
    } catch {
      this.reportLoss();
    }
  }

  /** Emulator loss (task 2.3): teardown + the owner's loss callback. */
  private reportLoss(): void {
    if (this.lossFired) return;
    this.lossFired = true;
    const handler = this.lossHandler;
    this.close();
    handler?.();
  }

  /** Send failed mid-relay → the stream is unusable: end it quietly. */
  private failStream(viewerId: string): void {
    const entry = this.streams.get(viewerId);
    if (!entry) return;
    this.streams.delete(viewerId);
    entry.ended = true;
    this.teardownStream(entry.guid, entry);
    try {
      entry.viewer.close();
    } catch {
      // best effort — the socket layer reaps dead sockets
    }
    if (this.streams.size === 0) this.disarmWatchdog();
  }

  /** bye + receive cancellation for ONE guid (idempotent per stream). */
  private teardownStream(guid: string, entry: ViewerStream): void {
    if (entry.ended) {
      this.adapter.cancelReceive(guid);
      return;
    }
    entry.ended = true;
    void this.adapter.sendJsep(guid, JSON.stringify({ bye: true })).catch(() => {});
    this.adapter.cancelReceive(guid);
  }

  /** The blocking receive pump for one viewer's guid. */
  private async receiveLoop(entry: ViewerStream): Promise<void> {
    try {
      for await (const payload of this.adapter.receive(entry.guid)) {
        if (entry.ended || !this.streams.has(entry.viewer.id)) return;
        this.relayPayload(entry, payload);
      }
    } catch {
      // Stream error: the watchdog decides device loss; end the viewer's
      // stream quietly so no viewer hangs on a dead guid.
    }
    // The receive stream ended without an emulator bye (cancel/error while
    // the session still runs) — only clean up if not already torn down.
    if (!entry.ended && this.streams.get(entry.viewer.id) === entry) {
      entry.ended = true;
      this.streams.delete(entry.viewer.id);
      if (this.streams.size === 0) this.disarmWatchdog();
      this.onStreamEnded?.(entry.viewer.id);
    }
  }

  /** Map one emulator payload onto the viewer's WS shapes (verbatim relay). */
  private relayPayload(entry: ViewerStream, payload: JsepPayload): void {
    if ("bye" in payload) {
      // The emulator hung up this stream: end the viewer (no bye echo).
      entry.ended = true;
      this.streams.delete(entry.viewer.id);
      if (this.streams.size === 0) this.disarmWatchdog();
      try {
        entry.viewer.close();
      } catch {
        // best effort
      }
      this.onStreamEnded?.(entry.viewer.id);
      return;
    }
    if ("start" in payload) return; // negotiation opened — handshake already sent
    const asDict = payload as { type?: unknown; sdp?: unknown };
    if (asDict.type === "offer" && typeof asDict.sdp === "string") {
      try {
        void entry.viewer.sendMessage({ type: "offer", sdp: asDict.sdp });
      } catch {
        // viewer write failure — teardown closes the socket anyway
      }
      return;
    }
    if ("candidate" in payload) {
      try {
        void entry.viewer.sendMessage({ type: "ice", candidate: payload as RtcIceCandidateInit });
      } catch {
        // viewer write failure — teardown closes the socket anyway
      }
    }
    // Unknown dictionaries are ignored — the relay never invents WS shapes.
  }

  /** Map an adapter start failure onto the spec close codes (Error States). */
  private mapStartError(e: unknown): RtcSessionError {
    if (e instanceof RtcSessionError) return e;
    const err = e as { code?: string; message?: string };
    if (err?.code === "PERMISSION_DENIED") {
      return new RtcSessionError(
        "PERMISSION_DENIED",
        err.message ?? "emulator gRPC denied the RtcService call",
        4401,
      );
    }
    if (err?.code === "DEVICE_OFFLINE") {
      return new RtcSessionError("NO_DEVICE", err.message ?? "emulator gRPC unreachable", 4404);
    }
    return new RtcSessionError(
      "STREAM_FAILED",
      `RtcStream failed to start: ${e instanceof Error ? e.message : String(e)}`,
      4404,
    );
  }

  private armWatchdog(): void {
    if (this.watchdogTimer || !this.probe) return;
    this.watchdogTimer = setInterval(() => {
      void this.poke();
    }, this.watchdogMs);
  }

  private disarmWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }
}
