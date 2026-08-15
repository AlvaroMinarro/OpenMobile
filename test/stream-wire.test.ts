import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseDeviceMeta,
  parseFrameMeta,
  splitAnnexB,
  serializeTouchEvent,
  serializeKeycodeEvent,
  serializeTextEvent,
} from "../src/stream/wire";
import {
  META_FLAG_SESSION,
  TOUCH_ACTION_DOWN,
  TOUCH_MESSAGE_LEN,
  KEYCODE_MESSAGE_LEN,
  TYPE_INJECT_KEYCODE,
  TYPE_INJECT_TEXT,
} from "../src/stream/types";

const FIX = join(import.meta.dir, "fixtures");

function fixture(name: string): Buffer {
  return readFileSync(join(FIX, name));
}

describe("stream wire — parsed from LIVE-recorded fixtures (emulator-5554, v4.1)", () => {
  it("parses the 64B+4B+12B session header from stream-meta.bin", () => {
    const meta = fixture("stream-meta.bin");
    // [0..64) name, [64..68) codec, [68..72) flags, [72..76) w, [76..80) h
    const parsed = parseDeviceMeta(meta.subarray(0, 64 + 4 + 12));
    expect(parsed.deviceName).toBe("sdk_gphone64_x86_64");
    expect(parsed.codecId).toBe("h264");
    expect(parsed.flags).toBe(META_FLAG_SESSION);
    expect(parsed.width).toBe(430);
    expect(parsed.height).toBe(960);
  });

  it("classifies the recorded CONFIG frame-meta (bit62 set, key unset)", () => {
    const meta = fixture("stream-meta.bin");
    const frameMeta = parseFrameMeta(meta.subarray(80, 92));
    // Recorded: 0x40000000_00000020 → CONFIG bit62 with len 32
    expect(frameMeta.isConfig).toBe(true);
    expect(frameMeta.isKey).toBe(false);
    expect(frameMeta.len).toBe(32);
    expect(typeof frameMeta.pts).toBe("bigint");
  });
});

describe("stream wire — Annex-B AU splitting (synthetic + recorded)", () => {
  it("splits the recorded stream-a-frames.bin into config + IDR AUs", () => {
    const buf = fixture("stream-a-frames.bin");
    // Mirror the production read-loop: [12B frame-meta][AU] pairs.
    const aus: Uint8Array[] = [];
    let off = 0;
    while (off + 12 <= buf.length) {
      const fm = parseFrameMeta(buf.subarray(off, off + 12));
      const end = off + 12 + fm.len;
      expect(end).toBeLessThanOrEqual(buf.length);
      aus.push(...splitAnnexB(buf.subarray(off + 12, end)));
      off = end;
    }
    expect(aus.length).toBeGreaterThanOrEqual(2);
    // The CONFIG frame splits into separate SPS (67) and PPS (68) AUs.
    const first = Buffer.from(aus[0]!);
    expect(first.subarray(0, 4).toString("hex")).toBe("00000001");
    const spsAu = aus.find((au) => au.length >= 5 && au[4] === 0x67);
    const ppsAu = aus.find((au) => au.length >= 5 && au[4] === 0x68);
    expect(spsAu).toBeDefined();
    expect(Buffer.from(spsAu!).toString("hex")).toContain("6742c029");
    expect(ppsAu).toBeDefined();
    // A keyframe (IDR NAL 0x65) must be present in the recorded frames.
    const idr = aus.find((au) => au.length >= 5 && au[4] === 0x65);
    expect(idr).toBeDefined();
  });

  it("splits a synthetic multi-AU buffer with 4-byte and 3-byte start codes", () => {
    // NOTE: au1 ends with 0x00, so when concatenated with au2's 3-byte start
    // code the bytes collide into a 4-byte prefix — the trailing zero is
    // absorbed by the NEXT code (Annex-B), and the AU slice changes
    // accordingly. Use a NAL that does NOT end in 0 to assert plain slicing.
    const au1 = Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]);
    const au2 = Uint8Array.from([0x00, 0x00, 0x01, 0x65, 0x88]);
    const au3 = Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0x61, 0x01, 0x02, 0x03]);
    const buf = Uint8Array.from([...au1, ...au2, ...au3]);
    const aus = splitAnnexB(buf);
    expect(aus).toHaveLength(3);
    expect(Array.from(aus[0]!)).toEqual(Array.from(au1));
    expect(Array.from(aus[1]!)).toEqual(Array.from(au2));
    expect(Array.from(aus[2]!)).toEqual(Array.from(au3));
  });

  it("absorbs a NAL's trailing zeros into the next start code (no phantom split)", () => {
    // Keyframe NAL ending with 0x00 (trailing_zero_8bits) followed by a
    // 3-byte start code — Annex-B semantics absorb that zero into the
    // 4-byte prefix, so NO phantom split may appear.
    const tail = Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x00]);
    const next = Uint8Array.from([0x00, 0x00, 0x01, 0x61]);
    const aus = splitAnnexB(Uint8Array.from([...tail, ...next]));
    expect(aus).toHaveLength(2);
    // AU1 keeps its NAL bytes up to (not including) the absorbed zero.
    expect(Array.from(aus[0]!)).toEqual([0, 0, 0, 1, 0x65, 0x88]);
    // AU2 is a 4-byte-prefixed slice: [0,0,0,0,1,0x61] → 00 00 00 01 61.
    expect(Array.from(aus[1]!)).toEqual([0, 0, 0, 1, 0x61]);
  });

  it("returns the single AU slice for a stream with no trailing bytes", () => {
    const au = Uint8Array.from([0, 0, 0, 1, 0x65, 0x88]);
    const aus = splitAnnexB(au);
    expect(aus).toHaveLength(1);
    expect(Array.from(aus[0]!)).toEqual(Array.from(au));
  });
});

describe("stream wire — control serialization (design §control socket)", () => {
  const control = fixture("stream-control.bin");

  it("serializes a touch DOWN event exactly like the recorded 32B control bytes", () => {
    const bytes = serializeTouchEvent(0, 215, 480); // down
    expect(bytes.length).toBe(TOUCH_MESSAGE_LEN);
    expect(bytes.toString("hex")).toBe(control.toString("hex"));
  });

  it("serializes a keycode event (14 bytes, big-endian keycode/repeat/metastate)", () => {
    const bytes = serializeKeycodeEvent(0 /* ACTION_DOWN */, 4 /* BACK */, 0, 0);
    expect(bytes.length).toBe(KEYCODE_MESSAGE_LEN);
    expect(bytes[0]).toBe(TYPE_INJECT_KEYCODE);
    expect(bytes[1]).toBe(0);
    expect(bytes.readInt32BE(2)).toBe(4);
    expect(bytes.readInt32BE(6)).toBe(0);
    expect(bytes.readInt32BE(10)).toBe(0);
  });

  it("serializes a text event with a 4-byte big-endian length and UTF-8 payload", () => {
    const bytes = serializeTextEvent("hi");
    expect(bytes[0]).toBe(TYPE_INJECT_TEXT);
    expect(bytes.readUInt32BE(1)).toBe(2);
    expect(bytes.subarray(5).toString("utf8")).toBe("hi");
  });
});