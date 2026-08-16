/**
 * WebCodecs decoder integration for the stream client (task 3.2, D7).
 *
 * Wraps the platform VideoDecoder with the narrow surface the client needs:
 *  - configure() derives a WebCodecs VideoDecoderConfig from the server
 *    handshake: the `avc1.PPCCLL` codec string (RFC 6381 — profile/
 *    constraints/level in hex from the SPS), codedWidth/codedHeight, and an
 *    Annex-B parameter blob (start-code + SPS + start-code + PPS) as the
 *    `description`,
 *  - decode() feeds ONE encoded chunk per NAL with a monotonically growing
 *    µs timestamp; every chunk is re-prefixed with the Annex-B start code —
 *    bare NAL payloads would be interpreted as AVCC by the platform and fail,
 *  - output frames are drawn onto the caller-owned canvas (scaled to fit);
 *    every frame the session receives is defensively free()'d after drawing.
 *
 * Browser-only: no Bun/node APIs. The platform VideoDecoder (and the chunk
 * constructor) are injected or resolved structurally so tests can substitute
 * doubles and run headless under bun.
 */

import type { VideoHandshake } from "../types";

/** Minimal structural surface of the platform VideoDecoder we consume. */
export interface DecoderLike {
  readonly state: "unconfigured" | "configured" | "closed";
  configure(config: VideoDecoderConfigLike): void;
  decode(chunk: EncodedChunkLike): void;
  flush(): Promise<void>;
  close(): void;
  onoutput: ((frame: unknown) => void) | null;
  onerror: ((e?: { message?: string }) => void) | null;
}

/** Minimal structural surface of a VideoDecoderConfig. */
export interface VideoDecoderConfigLike {
  codec: string;
  codedWidth?: number;
  codedHeight?: number;
  description?: Uint8Array;
  optimizeForLatency?: boolean;
}

/** Minimal structural surface of an EncodedVideoChunk we feed. */
export interface EncodedChunkLike {
  type: "key" | "delta";
  timestamp: number;
  data: Uint8Array;
}

/** Input shape a chunk factory turns into a platform chunk. */
export interface EncodedChunkInit {
  type: "key" | "delta";
  timestamp: number;
  data: Uint8Array;
}

/** Builds platform chunks (real EncodedVideoChunk in browsers). */
export type ChunkFactory = (init: EncodedChunkInit) => EncodedChunkLike;

/** The NAL kinds the client classifies (see annexb.ts). */
export interface DecodedNal {
  type: "sps" | "pps" | "idr" | "slice" | "unknown";
  /** Payload bytes AFTER the Annex-B start code. */
  data: Uint8Array;
}

/** Structural canvas surface (DOM-agnostic — no lib.dom dependency). */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: string): unknown;
}

/**
 * Default chunk factory: constructs a REAL EncodedVideoChunk when the
 * platform provides one (browsers reject plain objects), else returns the
 * structural chunk (test doubles).
 */
const defaultChunkFactory: ChunkFactory = (init) => {
  const Ctor = (globalThis as { EncodedVideoChunk?: new (i: EncodedChunkInit) => EncodedChunkLike })
    .EncodedVideoChunk;
  if (Ctor) return new Ctor(init);
  return { type: init.type, timestamp: init.timestamp, data: init.data };
};

/** Free a VideoFrame-like defensively: never double-close, never crash. */
const frameFree = (frame: unknown): void => {
  const f = frame as { close?: () => void; closed?: boolean } | null;
  if (f && typeof f.close === "function" && !f.closed) {
    try {
      f.close();
    } catch {
      // closing must never break the decode loop
    }
  }
};

export class DecoderSession {
  private readonly decoder: DecoderLike;
  private readonly canvas: CanvasLike | null;
  private readonly onFirstFrame: (() => void) | null;
  private readonly chunk: ChunkFactory;
  private pts = 0;
  private configured = false;
  private firstDelivered = false;

  constructor(deps: {
    decoder: DecoderLike;
    canvas?: CanvasLike | null;
    /** Fired exactly once, when the first frame is drawn (→ "streaming"). */
    onFirstFrame?: () => void;
    /** Platform chunk builder (default: real EncodedVideoChunk when present). */
    chunkFactory?: ChunkFactory;
    /** Decoder failures are surfaced here; the stream falls back to polling. */
    onError?: (message: string) => void;
  }) {
    this.decoder = deps.decoder;
    this.canvas = deps.canvas ?? null;
    this.onFirstFrame = deps.onFirstFrame ?? null;
    this.chunk = deps.chunkFactory ?? defaultChunkFactory;
    this.decoder.onoutput = (frame) => this.draw(frame);
    this.decoder.onerror = (e) => {
      deps.onError?.(e?.message ?? "decoder error");
    };
  }

  /**
   * Configure the decoder from the server handshake: `avc1.` + the AVC
   * profile hex derived from the SPS, the coded size, and the SPS+PPS byte
   * strings as an Annex-B `description` (start codes included — what the
   * platform expects for avc1).
   */
  async configure(hs: VideoHandshake): Promise<void> {
    const sps = decodeB64(hs.sps);
    const pps = decodeB64(hs.pps);
    const desc = new Uint8Array(4 + sps.length + 4 + pps.length);
    desc.set([0, 0, 0, 1], 0);
    desc.set(sps, 4);
    desc.set([0, 0, 0, 1], 4 + sps.length);
    desc.set(pps, 4 + sps.length + 4);
    this.decoder.configure({
      codec: avc1Codec(sps),
      codedWidth: hs.width,
      codedHeight: hs.height,
      description: desc,
      optimizeForLatency: true,
    });
    this.configured = true;
  }

  /** Feed one NAL as an encoded chunk (key for IDR, delta otherwise). */
  decode(nal: DecodedNal): void {
    if (!this.configured) return; // ignore frames before the handshake config
    this.pts += 1;
    // Re-attach the Annex-B start code: the platform parses chunk data as
    // Annex-B when start codes are present; bare NAL payloads imply AVCC
    // (length-prefixed) and fail to decode.
    const data = new Uint8Array(4 + nal.data.length);
    data.set([0, 0, 0, 1], 0);
    data.set(nal.data, 4);
    this.decoder.decode(
      this.chunk({
        type: nal.type === "idr" ? "key" : "delta",
        timestamp: this.pts * 1000,
        data,
      }),
    );
  }

  /** Flush + close the decoder; further decode() calls are dropped. */
  async close(): Promise<void> {
    if (this.decoder.state === "closed") {
      this.configured = false;
      return;
    }
    if (this.configured) {
      try {
        await this.decoder.flush();
      } catch {
        // flush rejects after a decode error — the decoder is still closed below
      }
    }
    this.decoder.close();
    this.configured = false;
  }

  private draw(frame: unknown): void {
    if (!this.firstDelivered) {
      this.firstDelivered = true;
      try {
        this.onFirstFrame?.();
      } catch {
        // a status listener must never break the decode loop
      }
    }
    // The caller owns the canvas; we only draw + free the frame.
    const raw = this.canvas?.getContext("2d");
    const ctx =
      (typeof raw === "object" && raw !== null ? raw : null) as {
        drawImage?: (image: unknown, dx: number, dy: number, dw: number, dh: number) => unknown;
      } | null;
    if (this.canvas && ctx && typeof ctx.drawImage === "function") {
      try {
        ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
      } catch {
        // a draw failure must never break the decode loop — frame freed below
      }
    }
    frameFree(frame);
  }
}

/**
 * Build a WebCodecs `avc1.` codec string from the SPS payload (RFC 6381):
 * `avc1.PPCCLL` — profile_idc / constraint flags / level_idc in hex from
 * SPS bytes 1..4 (byte 0 is the NAL header 0x67). The SPS supplied by the
 * handshake lives AFTER the start code.
 */
export function avc1Codec(sps: Uint8Array): string {
  const p = sps[1] ?? 0;
  const c = sps[2] ?? 0;
  const l = sps[3] ?? 0;
  return `avc1.${hex2(p)}${hex2(c)}${hex2(l)}`;
}

/** Decode base64 → bytes (browser atob-based, no node Buffer). */
function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}