import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ControlError,
  encodeControlEvent,
  parseControlJson,
  type VideoSize,
} from "../src/stream/control";
import { TOUCH_ACTION_DOWN, TOUCH_ACTION_UP } from "../src/stream/types";

const FIX = join(import.meta.dir, "fixtures");
const VIDEO: VideoSize = { width: 430, height: 960 };

function recorded(name: string): Buffer {
  return readFileSync(join(FIX, name));
}

/** Assert the thrown error is a ControlError with the expected code. */
function expectCode(fn: () => unknown, code: ControlError["code"]): void {
  try {
    fn();
    throw new Error(`expected ControlError(${code}) to be thrown`);
  } catch (e) {
    expect(e).toBeInstanceOf(ControlError);
    expect((e as ControlError).code).toBe(code);
  }
}

describe("stream control encoder — JSON inject → scrcpy control bytes (design D3)", () => {
  it("encodes a tap as DOWN+UP touch events; the DOWN bytes match the recorded 32B fixture", () => {
    const msgs = encodeControlEvent({ type: "inject", event: "tap", x: 215, y: 480 }, VIDEO);
    expect(msgs).toHaveLength(2);
    const down = msgs[0]!;
    expect(down.length).toBe(32);
    // Byte-for-byte equality with the LIVE-recorded tap (design §control socket).
    expect(down.toString("hex")).toBe(recorded("stream-control.bin").toString("hex"));
    expect(msgs[0]![1]).toBe(TOUCH_ACTION_DOWN);
    expect(msgs[1]![1]).toBe(TOUCH_ACTION_UP);
  });

  it("encodes a swipe as DOWN → MOVE steps → UP, all inside the video bounds", () => {
    const msgs = encodeControlEvent(
      { type: "inject", event: "swipe", x1: 10, y1: 20, x2: 100, y2: 200, durationMs: 100 },
      VIDEO,
    );
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    expect(msgs[0]![1]).toBe(TOUCH_ACTION_DOWN);
    expect(msgs[msgs.length - 1]![1]).toBe(TOUCH_ACTION_UP);
    for (const m of msgs) {
      expect(m.length).toBe(32); // every message is a full touch event
      const x = m.readInt32BE(10);
      const y = m.readInt32BE(14);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(VIDEO.width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(VIDEO.height);
    }
    // Middle messages are MOVE action 2.
    expect(msgs[1]![1]).toBe(2);
  });

  it("encodes text as one TYPE_INJECT_TEXT message (4-byte length + UTF-8 payload)", () => {
    const msgs = encodeControlEvent({ type: "inject", event: "text", text: "hello world" }, VIDEO);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]![0]).toBe(1); // TYPE_INJECT_TEXT
    expect(msgs[0]!.readUInt32BE(1)).toBe(11);
    expect(msgs[0]!.subarray(5).toString("utf8")).toBe("hello world");
  });

  it("encodes a key press as DOWN+UP keycode events (BACK=4)", () => {
    const msgs = encodeControlEvent({ type: "inject", event: "key", keycode: 4 }, VIDEO);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]![0]).toBe(0); // TYPE_INJECT_KEYCODE
    expect(msgs[0]!.readInt32BE(2)).toBe(4);
    expect(msgs[1]![1]).toBe(1); // ACTION_UP
  });

  it("rejects coordinates outside the video-space bounds (Out-of-range coordinates)", () => {
    // x === width is already out of range; negative too.
    expectCode(() => encodeControlEvent({ type: "inject", event: "tap", x: 430, y: 100 }, VIDEO), "OUT_OF_RANGE");
    expectCode(() => encodeControlEvent({ type: "inject", event: "tap", x: -1, y: 100 }, VIDEO), "OUT_OF_RANGE");
    expectCode(
      () => encodeControlEvent({ type: "inject", event: "swipe", x1: 0, y1: 0, x2: 100, y2: 2000 }, VIDEO),
      "OUT_OF_RANGE",
    );
  });

  it("rejects characters the control socket cannot inject (Unsupported character while streaming)", () => {
    expectCode(() => encodeControlEvent({ type: "inject", event: "text", text: "hola ñ" }, VIDEO), "UNSUPPORTED_CHAR");
    expectCode(() => encodeControlEvent({ type: "inject", event: "text", text: "tab\there" }, VIDEO), "UNSUPPORTED_CHAR");
  });
});

describe("parseControlJson — WS /v1/stream/control contract shapes", () => {
  it("accepts the documented inject shapes (tap, swipe, text, key)", () => {
    const tap = parseControlJson(JSON.stringify({ type: "inject", event: "tap", x: 215, y: 480 }));
    expect(tap.ok).toBe(true);
    if (tap.ok) expect(tap.event).toEqual({ type: "inject", event: "tap", x: 215, y: 480 });

    const swipe = parseControlJson(
      JSON.stringify({ type: "inject", event: "swipe", x1: 0, y1: 0, x2: 1, y2: 1, durationMs: 80 }),
    );
    expect(swipe.ok).toBe(true);
    if (swipe.ok) expect(swipe.event).toEqual({ type: "inject", event: "swipe", x1: 0, y1: 0, x2: 1, y2: 1, durationMs: 80 });

    const text = parseControlJson(JSON.stringify({ type: "inject", event: "text", text: "hi" }));
    expect(text.ok).toBe(true);

    const key = parseControlJson(JSON.stringify({ type: "inject", event: "key", keycode: 3 }));
    expect(key.ok).toBe(true);
    if (key.ok) expect(key.event).toEqual({ type: "inject", event: "key", keycode: 3 });
  });

  it("rejects unknown types / unknown events / malformed payloads (Unknown inject type)", () => {
    expect(parseControlJson("not json").ok).toBe(false);
    expect(parseControlJson(JSON.stringify({ type: "other", x: 1 })).ok).toBe(false);
    expect(parseControlJson(JSON.stringify({ type: "inject", event: "poke" })).ok).toBe(false);
    expect(parseControlJson(JSON.stringify({ type: "inject", event: "tap" })).ok).toBe(false); // missing x/y
    expect(parseControlJson(JSON.stringify({ type: "inject", event: "key" })).ok).toBe(false); // missing keycode
    expect(parseControlJson(JSON.stringify({ type: "inject", event: "text" })).ok).toBe(false); // missing text
  });
});