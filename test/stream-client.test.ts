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