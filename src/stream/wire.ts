/**
 * Wire parsing + serialization for the scrcpy v4.1 raw stream protocol
 * (design §Live-validated facts, pinned to assets/scrcpy-server.jar).
 *
 * Video socket (connection #1), all big-endian:
 *   [0..64)   device name (ASCII, null-padded)
 *   [64..68)  codec id (0x68323634 = "h264")
 *   [68..72)  session meta flags u32 (0x80000000 for the session header)
 *   [72..76)  width u32   (live: 430 with max_size=960)
 *   [76..80)  height u32  (live: 960)
 *   then repeated [12B frame meta][len bytes Annex-B AU]:
 *     frame meta: ptsAndFlags u64 (bit62=CONFIG, bit61=KEY, low 61=PTS)
 *                 + len u32
 *
 * Control socket (connection #2), big-endian; position space = VIDEO size:
 *   TYPE_INJECT_TOUCH_EVENT=2 (32B): [0]type [1]action [2..10)ptrId i64
 *     [10..14)x [14..18)y [18..20)scrW u16 [20..22)scrH u16 [22..24)pressure
 *     u16 [24..28)actionButton [28..32)buttons
 *   TYPE_INJECT_KEYCODE=0 (14B): [0]type [1]action [2..6)keycode i32
 *     [6..10)repeat [10..14)metastate
 *   TYPE_INJECT_TEXT=1: [0]type [1..5)len u32 [5..)UTF-8
 */

import {
  DEVICE_META_LEN,
  CODEC_ID_LEN,
  SESSION_META_LEN,
  FRAME_META_LEN,
  FLAG_CONFIG,
  FLAG_KEY,
  PTS_MASK,
  TYPE_INJECT_KEYCODE,
  TYPE_INJECT_TEXT,
  TYPE_INJECT_TOUCH_EVENT,
  TOUCH_ACTION_DOWN,
  KEYCODE_MESSAGE_LEN,
  TOUCH_MESSAGE_LEN,
  type FrameMeta,
  type SessionMeta,
} from "./types";

/** Parse the 80-byte session header (device meta + codec id + session meta). */
export function parseDeviceMeta(buf: Uint8Array): SessionMeta {
  if (buf.length < DEVICE_META_LEN + CODEC_ID_LEN + SESSION_META_LEN) {
    throw new RangeError(
      `session header too short: ${buf.length}B (need ${DEVICE_META_LEN + CODEC_ID_LEN + SESSION_META_LEN}B)`,
    );
  }
  const nameEnd = buf.indexOf(0, 0);
  const deviceName = new TextDecoder().decode(
    buf.subarray(0, nameEnd === -1 ? DEVICE_META_LEN : nameEnd),
  );
  const codecId = new TextDecoder().decode(buf.subarray(64, 68));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    deviceName,
    codecId,
    flags: dv.getUint32(68, false),
    width: dv.getUint32(72, false),
    height: dv.getUint32(76, false),
  };
}

/** Parse a 12-byte frame meta header. */
export function parseFrameMeta(buf: Uint8Array): FrameMeta {
  if (buf.length < FRAME_META_LEN) {
    throw new RangeError(`frame meta too short: ${buf.length}B (need ${FRAME_META_LEN}B)`);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ptsAndFlags = dv.getBigUint64(0, false);
  return {
    pts: ptsAndFlags & PTS_MASK,
    isConfig: (ptsAndFlags & FLAG_CONFIG) !== 0n,
    isKey: (ptsAndFlags & FLAG_KEY) !== 0n,
    len: dv.getUint32(8, false),
  };
}

/**
 * Split a frame payload into Annex-B access units (4-byte and 3-byte start
 * codes). A NAL may legally end with trailing zero bytes; when they precede
 * a start code they merge into it and are NOT split off — scanning looks for
 * `00 00 01` and pulls in a preceding `00` (4-byte code) when present.
 */
export function splitAnnexB(buf: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      // A preceding 0 makes this a 4-byte start code (00 00 00 01); the
      // trailing zeros of the previous NAL are absorbed by the code.
      const codeStart = i > 0 && buf[i - 1] === 0 ? i - 1 : i;
      starts.push(codeStart);
      i += 2; // +1 from the loop = skip past 00 00 01 entirely
    }
  }
  if (starts.length === 0) {
    return buf.length > 0 ? [buf] : [];
  }
  const aus: Uint8Array[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]! : buf.length;
    // Skip a zero-length tail (e.g. stream ended right after a start code).
    if (end > start) aus.push(buf.subarray(start, end));
  }
  return aus;
}

function u16be(b: Uint8Array, off: number): number {
  return (b[off]! << 8) | b[off + 1]!;
}

export type TouchAction = 0 | 1 | 2;

/** Serialize a touch event (32B, design §control socket; coords in VIDEO space). */
export function serializeTouchEvent(
  action: TouchAction,
  x: number,
  y: number,
  opts: { screenWidth?: number; screenHeight?: number } = {},
): Buffer {
  const b = Buffer.alloc(TOUCH_MESSAGE_LEN);
  b[0] = TYPE_INJECT_TOUCH_EVENT;
  b[1] = action;
  b.writeBigInt64BE(-1n, 2); // pointerId -1
  b.writeInt32BE(x, 10);
  b.writeInt32BE(y, 14);
  const w = opts.screenWidth ?? 430;
  const h = opts.screenHeight ?? 960;
  b.writeUInt16BE(w, 18);
  b.writeUInt16BE(h, 20);
  b.writeUInt16BE(0xffff, 22); // pressure 1.0
  b.writeInt32BE(0, 24); // actionButton
  b.writeInt32BE(0, 28); // buttons
  return b;
}

/** Serialize a keycode event (14 bytes). keycode per scrcpy (BACK=4, HOME=3). */
export function serializeKeycodeEvent(
  action: number,
  keycode: number,
  repeat = 0,
  metastate = 0,
): Buffer {
  const b = Buffer.alloc(KEYCODE_MESSAGE_LEN);
  b[0] = TYPE_INJECT_KEYCODE;
  b[1] = action;
  b.writeInt32BE(keycode, 2);
  b.writeInt32BE(repeat, 6);
  b.writeInt32BE(metastate, 10);
  return b;
}

/** Serialize a text event (UTF-8, 4-byte big-endian length). */
export function serializeTextEvent(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  const b = Buffer.alloc(5 + body.length);
  b[0] = TYPE_INJECT_TEXT;
  b.writeUInt32BE(body.length, 1);
  body.copy(b, 5);
  return b;
}