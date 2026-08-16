/**
 * Browser client tests (Phase 3, D7) — strict TDD.
 *
 * The Annex-B splitter is a pure function tested against the LIVE-recorded
 * stream fixtures (test/fixtures/stream-a-frames.bin — 12B frame-meta + AU
 * pairs, exactly what the video WS delivers) plus synthetic chunk-boundary
 * and NAL-classification cases. Decoder wiring, support detection and the
 * client itself are exercised with minimal doubles so the suite runs headless
 * under bun — the real WebCodecs path is validated on the demo page
 * (examples/stream.html) in a browser.
 *
 * Client source MUST stay browser-only: no Bun/node APIs.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrameMeta } from "../src/stream/wire";
import { AnnexBSplitter, classifyNal } from "../src/stream/client/annexb";
import { DecoderSession, type EncodedChunkLike, type VideoDecoderConfigLike } from "../src/stream/client/decoder";
import { isStreamSupported } from "../src/stream/client/support";
import type { VideoHandshake } from "../src/stream/types";

const FIX = join(import.meta.dir, "fixtures");

function fixture(name: string): Buffer {
  return readFileSync(join(FIX, name));
}

/** Feed a full fixture (frame-meta + AU pairs — the video WS stream shape). */
function feedFixtureAu(splitter: AnnexBSplitter, raw: Uint8Array): Uint8Array[] {
  const all: Uint8Array[] = [];
  let off = 0;
  while (off + 12 <= raw.length) {
    const fm = parseFrameMeta(raw.subarray(off, off + 12));
    const end = off + 12 + fm.len;
    splitter.push(raw.subarray(off + 12, end));
    all.push(...splitter.drain(true)); // one WS message per AU → segment-end flush
    off = end;
  }
  return all;
}

// ─── 3.1 client Annex-B splitter ─────────────────────────────────────────

describe("client AnnexB splitter (task 3.1)", () => {
  it("splits the recorded stream-a-frames.bin into NALs and classifies SPS/PPS/IDR/slice", () => {
    const splitter = new AnnexBSplitter();
    const nals = feedFixtureAu(splitter, fixture("stream-a-frames.bin"));
    const types = nals.map((n) => classifyNal(n));
    expect(types.length).toBeGreaterThanOrEqual(3);
    expect(types).toContain("sps");
    expect(types).toContain("pps");
    expect(types).toContain("idr");
    expect(types).toContain("slice");
  });

  it("emits each NAL with payload bytes after the start code", () => {
    const splitter = new AnnexBSplitter();
    splitter.push(Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xc0, 0x29]));
    const nals = splitter.drain(true);
    expect(nals).toHaveLength(1);
    // Payload EXCLUDES the start code; NAL header (0x67) is the first byte.
    expect(Array.from(nals[0]!)).toEqual([0x67, 0x42, 0xc0, 0x29]);
  });

  it("keeps a 4-byte start code across a chunk boundary and a NAL's trailing zero merges into the next code", () => {
    const splitter = new AnnexBSplitter();
    splitter.push(Uint8Array.from([0x00, 0x00, 0x00])); // 4-byte-code prefix (partial)
    // Completes the 4-byte code, then NAL1 (trailing zero merges into code2).
    splitter.push(Uint8Array.from([0x01, 0x65, 0x88, 0x00, 0x00, 0x00, 0x01, 0x61]));
    // NAL1 complete (code2 seen) — emitted without flush; NAL2 tail waits.
    const first = splitter.drain();
    expect(first).toHaveLength(1);
    expect(Array.from(first[0]!)).toEqual([0x65, 0x88]);
    // NAL2 is incomplete until more payload arrives → not emitted no-flush.
    expect(splitter.drain()).toHaveLength(0);
    splitter.push(Uint8Array.from([0xde, 0xad]));
    const tail = splitter.drain(true);
    expect(tail).toHaveLength(1);
    expect(Array.from(tail[0]!)).toEqual([0x61, 0xde, 0xad]);
  });

  it("buffers an incomplete NAL across pushes and flushes it at segment end", () => {
    const splitter = new AnnexBSplitter();
    splitter.push(Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]));
    expect(splitter.drain()).toHaveLength(0);
    splitter.push(Uint8Array.from([0xc0]));
    expect(splitter.drain()).toHaveLength(0); // no following code → still pending
    const done = splitter.drain(true); // WS message end → the NAL is complete
    expect(done).toHaveLength(1);
    expect(Array.from(done[0]!)).toEqual([0x67, 0x42, 0xc0]);
  });

  it("classifies a NAL with forbidden_zero_bit set as a slice (safe fallback)", () => {
    expect(classifyNal(Uint8Array.from([0x80, 0x00]))).toBe("slice");
  });

  it("does not re-emit buffered NALs on a second flush", () => {
    const splitter = new AnnexBSplitter();
    splitter.push(Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88]));
    expect(splitter.drain(true)).toHaveLength(1);
    expect(splitter.drain(true)).toHaveLength(0); // consumed — nothing left
  });
});

// ─── 3.2 decoder wiring (mock VideoDecoder + canvas) ──────────────────────

/** Minimal VideoFrame double the decoder's onoutput can emit. */
class FrameDouble {
  closed = false;
  readonly format = "NV12";
  readonly timestamp = 0;
  readonly codedWidth: number;
  readonly codedHeight: number;

  constructor(codedWidth: number, codedHeight: number) {
    this.codedWidth = codedWidth;
    this.codedHeight = codedHeight;
  }

  close(): void {
    this.closed = true;
  }

  static of(w: number, h: number): FrameDouble {
    return new FrameDouble(w, h);
  }
}

/**
 * Minimal VideoDecoder double: records configs/chunks and can emit frames
 * through the same onoutput channel the real decoder uses.
 */
class FakeDecoder {
  state: "unconfigured" | "configured" | "closed" = "unconfigured";
  configs: VideoDecoderConfigLike[] = [];
  chunks: EncodedChunkLike[] = [];
  onoutput: ((frame: unknown) => void) | null = null;
  onerror: ((e?: { message?: string }) => void) | null = null;

  configure(config: VideoDecoderConfigLike): void {
    this.configs.push(config);
    this.state = "configured";
  }

  decode(chunk: EncodedChunkLike): void {
    this.chunks.push(chunk);
  }

  async flush(): Promise<void> {}

  close(): void {
    this.state = "closed";
  }

  /** Simulate the platform emitting a decoded frame. */
  emit(frame: unknown): void {
    this.onoutput?.(frame);
  }
}

/** Minimal canvas double: records drawImage calls on the 2d context. */
class FakeCanvas {
  width = 430;
  height = 960;
  drawCalls: unknown[][] = [];

  getContext(kind: string): unknown {
    if (kind !== "2d") return null;
    return {
      drawImage: (image: unknown, dx: number, dy: number, dw: number, dh: number) => {
        this.drawCalls.push([image, dx, dy, dw, dh]);
      },
    };
  }
}

/** The LIVE handshake (validated on emulator-5554, design §Live-validated facts). */
const HS: VideoHandshake = {
  type: "handshake",
  codec: "h264",
  lengthSize: 12,
  width: 430,
  height: 960,
  sps: "Z0LAKY1oGweeuQgICAg8IhGo", // SPS NAL (after start code): 67 42 c0 29 …
  pps: "aM4BqDXI", // PPS NAL (after start code): 68 ce 01 …
};

function hsFrom(sps: Uint8Array, pps: Uint8Array): VideoHandshake {
  return { ...HS, sps: toB64(sps), pps: toB64(pps) };
}

function toB64(bytes: Uint8Array): string {
  // Node-side helper ONLY for building the test literal (client stays pure).
  return Buffer.from(bytes).toString("base64");
}

describe("client decoder (task 3.2)", () => {
  it("configures the VideoDecoder from the handshake with an avc1 codec string + Annex-B SPS/PPS description", async () => {
    const decoder = new FakeDecoder();
    const canvas = new FakeCanvas();
    const r = new DecoderSession({ decoder, canvas });
    await r.configure(HS);
    expect(decoder.state).toBe("configured");
    expect(decoder.configs).toHaveLength(1);
    const c = decoder.configs[0]!;
    // WebCodecs rejects non-avc1 codec strings; the client derives the RFC
    // 6381 form `avc1.PPCCLL` (profile/constraints/level in hex) from the SPS.
    expect(c.codec).toBe("avc1.42c029");
    expect(c.codedWidth).toBe(430);
    expect(c.codedHeight).toBe(960);
    expect(c.optimizeForLatency).toBe(true);
    expect(c.description).toBeInstanceOf(Uint8Array);
    // Description = Annex-B parameter blob: start-code + SPS + start-code + PPS.
    const d = c.description as Uint8Array;
    expect(Array.from(d.slice(0, 4))).toEqual([0, 0, 0, 1]);
    expect(d[4]).toBe(0x67); // SPS NAL header
    const spsLen = 18; // "Z0LAKY1oGweeuQgICAg8IhGo" → 18 bytes
    expect(Array.from(d.slice(4 + spsLen, 4 + spsLen + 4))).toEqual([0, 0, 0, 1]);
    expect(d[4 + spsLen + 4]).toBe(0x68); // PPS NAL header
  });

  it("feeds every NAL payload to the decoder in order, key for IDR, Annex-B-prefixed, timestamped", async () => {
    const decoder = new FakeDecoder();
    const r = new DecoderSession({ decoder, canvas: new FakeCanvas() });
    const sps = Uint8Array.from([0x67, 0x42, 0xc0, 0x29]);
    const pps = Uint8Array.from([0x68, 0xc0]);
    await r.configure(hsFrom(sps, pps));
    r.decode({ type: "sps", data: sps });
    r.decode({ type: "pps", data: pps });
    r.decode({ type: "idr", data: Uint8Array.from([0x65, 0x88, 0x01]) });
    r.decode({ type: "slice", data: Uint8Array.from([0x61, 0xe0]) });
    expect(decoder.chunks).toHaveLength(4);
    // Every chunk is the full Annex-B NAL (start code re-attached): bare NAL
    // payloads would be parsed as AVCC by the platform and fail to decode.
    expect(Array.from(decoder.chunks[0]!.data.slice(0, 4))).toEqual([0, 0, 0, 1]);
    expect(Array.from(decoder.chunks[0]!.data.slice(4))).toEqual([0x67, 0x42, 0xc0, 0x29]);
    expect(decoder.chunks[0]!.type).toBe("delta"); // sps → delta
    expect(decoder.chunks[2]!.type).toBe("key"); // idr → key
    expect(decoder.chunks[2]!.timestamp).toBeGreaterThan(decoder.chunks[1]!.timestamp);
    expect(decoder.chunks[3]!.timestamp).toBe(4000); // 1-based µs counter
  });

  it("drops NALs fed before the handshake config (handshake ordering)", async () => {
    const decoder = new FakeDecoder();
    const r = new DecoderSession({ decoder, canvas: new FakeCanvas() });
    r.decode({ type: "slice", data: Uint8Array.from([0x61, 0x01]) });
    expect(decoder.chunks).toHaveLength(0); // unconfigured → dropped silently
    await r.configure(HS);
    r.decode({ type: "slice", data: Uint8Array.from([0x61, 0x02]) });
    expect(decoder.chunks).toHaveLength(1);
  });

  it("draws emitted frames onto the caller canvas and defensively frees them", async () => {
    const decoder = new FakeDecoder();
    const canvas = new FakeCanvas();
    const r = new DecoderSession({ decoder, canvas });
    await r.configure(HS);
    r.decode({ type: "slice", data: Uint8Array.from([0x61, 0x01]) });
    const frame = FrameDouble.of(430, 960);
    decoder.emit(frame); // session's onoutput → draw + free
    expect(canvas.drawCalls).toHaveLength(1);
    expect(canvas.drawCalls[0]![1]).toBe(0); // dx
    expect(canvas.drawCalls[0]![3]).toBe(430); // scaled to canvas width
    expect(frame.closed).toBe(true); // freed after drawing — never leaked
    await r.close();
    expect(decoder.state).toBe("closed");
  });

  it("still frees emitted frames when no canvas is attached and reports first frame", async () => {
    const decoder = new FakeDecoder();
    const seen: string[] = [];
    const r = new DecoderSession({
      decoder,
      onFirstFrame: () => seen.push("first"),
    });
    await r.configure(HS);
    const frame = FrameDouble.of(430, 960);
    decoder.emit(frame);
    expect(seen).toEqual(["first"]);
    expect(frame.closed).toBe(true);
    await r.close();
  });
});

// ─── 3.3 stream support detection ────────────────────────────────────────

describe("client stream support (task 3.3)", () => {
  const g = globalThis as { VideoDecoder?: unknown };

  it("is false when the platform lacks VideoDecoder (Firefox → polling fallback)", () => {
    const saved = g.VideoDecoder;
    delete (g as Record<string, unknown>).VideoDecoder;
    try {
      expect(isStreamSupported()).toBe(false);
    } finally {
      g.VideoDecoder = saved;
    }
  });

  it("is true when VideoDecoder exists and can be constructed", () => {
    const saved = g.VideoDecoder;
    g.VideoDecoder = class {
      close(): void {}
    };
    try {
      expect(isStreamSupported()).toBe(true);
    } finally {
      g.VideoDecoder = saved;
    }
  });

  it("is false when the VideoDecoder constructor throws (blocklisted/unsupported)", () => {
    const saved = g.VideoDecoder;
    g.VideoDecoder = class {
      constructor() {
        throw new Error("VideoDecoder unavailable on this platform");
      }
    };
    try {
      expect(isStreamSupported()).toBe(false);
    } finally {
      g.VideoDecoder = saved;
    }
  });
});