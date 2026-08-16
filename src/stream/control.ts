/**
 * Control bridge — JSON control events → scrcpy control bytes (design D3).
 *
 * The /v1/stream/control WS route (slice 2B) receives JSON like
 * `{type:"inject", event:"tap", x,y}` and injects scrcpy bytes into the
 * device's CONTROL socket. This module owns:
 *  - `parseControlJson`: validate the documented WS contract shapes,
 *  - `encodeControlEvent`: convert a typed event into the scrcpy byte
 *    messages the socket expects (touch DOWN/UP, keycode DOWN/UP, text),
 *  - typed errors so the WS layer can map them onto error frames,
 *  - `sendControlEvent`: the bridge entrypoint that returns a typed
 *    "stream-off" result when no stream is active, so the caller decides
 *    whether to fall back to the /v1/input REST routes.
 *
 * Position space is the VIDEO size (430x960 with max_size=960), NOT the
 * device size — the surface maps device→video before sending (design
 * §Live-validated facts).
 */

import type { ControlEvent } from "./types";
import {
  serializeKeycodeEvent,
  serializeTextEvent,
  serializeTouchEvent,
} from "./wire";
import {
  TOUCH_ACTION_DOWN,
  TOUCH_ACTION_MOVE,
  TOUCH_ACTION_UP,
} from "./types";

/** Video space the control coordinates live in (from the stream handshake). */
export interface VideoSize {
  width: number;
  height: number;
}

/** Typed control error codes (mapped onto WS error frames by the route). */
export type ControlErrorCode =
  | "OUT_OF_RANGE"
  | "UNSUPPORTED_CHAR"
  | "UNSUPPORTED_EVENT"
  | "INVALID_JSON"
  | "STREAM_OFF";

export class ControlError extends Error {
  readonly code: ControlErrorCode;
  readonly details?: unknown;

  constructor(code: ControlErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ControlError";
    this.code = code;
    this.details = details;
  }
}

/** ASCII+space only — scrcpy's text injector cannot send arbitrary UTF-8. */
const INJECTABLE_ASCII = /^[\x20-\x7E]*$/;

function assertInBounds(video: VideoSize, ...pts: Array<{ x: number; y: number }>): void {
  for (const p of pts) {
    if (
      !Number.isInteger(p.x) ||
      !Number.isInteger(p.y) ||
      p.x < 0 ||
      p.y < 0 ||
      p.x >= video.width ||
      p.y >= video.height
    ) {
      throw new ControlError("OUT_OF_RANGE", `coordinates out of video space (0..${video.width - 1}, 0..${video.height - 1})`, p);
    }
  }
}

/**
 * Encode a typed control event into the scrcpy control messages.
 * Returns one-or-more byte buffers to write to the CONTROL socket, in order.
 */
export function encodeControlEvent(event: ControlEvent, video: VideoSize): Buffer[] {
  const w = video.width;
  const h = video.height;

  switch (event.event) {
    case "tap": {
      assertInBounds(video, { x: event.x, y: event.y });
      const down = serializeTouchEvent(TOUCH_ACTION_DOWN, event.x, event.y, { screenWidth: w, screenHeight: h });
      const up = serializeTouchEvent(TOUCH_ACTION_UP, event.x, event.y, { screenWidth: w, screenHeight: h });
      return [down, up];
    }

    case "swipe": {
      assertInBounds(
        video,
        { x: event.x1, y: event.y1 },
        { x: event.x2, y: event.y2 },
      );
      // Split the gesture into DOWN → MOVE steps → UP (design §control socket).
      const steps = Math.max(1, Math.min(20, Math.round((event.durationMs ?? 100) / 16)));
      const msgs: Buffer[] = [serializeTouchEvent(TOUCH_ACTION_DOWN, event.x1, event.y1, { screenWidth: w, screenHeight: h })];
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const x = Math.round(event.x1 + (event.x2 - event.x1) * t);
        const y = Math.round(event.y1 + (event.y2 - event.y1) * t);
        msgs.push(serializeTouchEvent(TOUCH_ACTION_MOVE, x, y, { screenWidth: w, screenHeight: h }));
      }
      msgs.push(serializeTouchEvent(TOUCH_ACTION_UP, event.x2, event.y2, { screenWidth: w, screenHeight: h }));
      return msgs;
    }

    case "text": {
      if (!INJECTABLE_ASCII.test(event.text)) {
        throw new ControlError("UNSUPPORTED_CHAR", "scrcpy text injector supports ASCII+space only");
      }
      return [serializeTextEvent(event.text)];
    }

    case "key": {
      if (!Number.isInteger(event.keycode) || event.keycode < 0) {
        throw new ControlError("OUT_OF_RANGE", "keycode must be a non-negative integer", event.keycode);
      }
      const down = serializeKeycodeEvent(TOUCH_ACTION_DOWN, event.keycode);
      const up = serializeKeycodeEvent(TOUCH_ACTION_UP, event.keycode);
      return [down, up];
    }

    default:
      throw new ControlError("UNSUPPORTED_EVENT", `unsupported control event: ${(event as { event?: string }).event}`);
  }
}

// ─── JSON contract parsing ───────────────────────────────────────────────

export type ParseControlResult =
  | { ok: true; event: ControlEvent }
  | { ok: false; code: ControlErrorCode; message: string };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Parse + validate a /v1/stream/control JSON message (design §WS Contract). */
export function parseControlJson(raw: string): ParseControlResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "INVALID_JSON", message: "control message is not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "INVALID_JSON", message: "control message must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "inject") {
    return { ok: false, code: "UNSUPPORTED_EVENT", message: `unknown control type: ${String(obj.type)}` };
  }
  const event = obj.event;
  if (event === "tap") {
    if (isFiniteNumber(obj.x) && isFiniteNumber(obj.y)) {
      return { ok: true, event: { type: "inject", event: "tap", x: obj.x, y: obj.y } };
    }
    return { ok: false, code: "UNSUPPORTED_EVENT", message: "tap requires numeric x and y" };
  }
  if (event === "swipe") {
    if (
      isFiniteNumber(obj.x1) && isFiniteNumber(obj.y1) &&
      isFiniteNumber(obj.x2) && isFiniteNumber(obj.y2)
    ) {
      const durationMs = isFiniteNumber(obj.durationMs) ? obj.durationMs : undefined;
      return {
        ok: true,
        event: durationMs === undefined
          ? { type: "inject", event: "swipe", x1: obj.x1, y1: obj.y1, x2: obj.x2, y2: obj.y2 }
          : { type: "inject", event: "swipe", x1: obj.x1, y1: obj.y1, x2: obj.x2, y2: obj.y2, durationMs },
      };
    }
    return { ok: false, code: "UNSUPPORTED_EVENT", message: "swipe requires numeric x1,y1,x2,y2" };
  }
  if (event === "text") {
    if (typeof obj.text === "string" && obj.text.length > 0) {
      return { ok: true, event: { type: "inject", event: "text", text: obj.text } };
    }
    return { ok: false, code: "UNSUPPORTED_EVENT", message: "text requires a non-empty string" };
  }
  if (event === "key") {
    if (isFiniteNumber(obj.keycode)) {
      return { ok: true, event: { type: "inject", event: "key", keycode: obj.keycode } };
    }
    return { ok: false, code: "UNSUPPORTED_EVENT", message: "key requires a numeric keycode" };
  }
  return { ok: false, code: "UNSUPPORTED_EVENT", message: `unknown control event: ${String(event)}` };
}

// ─── Bridge entrypoint ───────────────────────────────────────────────────

/** Result of sending a control event when NO stream is active. */
export type StreamOffResult =
  | { ok: true; messages: Buffer[] }
  | { ok: false; code: "STREAM_OFF"; reason: string };

/**
 * Send a control event through an ACTIVE stream's control writer.
 * When no stream is active, returns the typed STREAM_OFF result — the
 * caller (WS route or fallback) decides whether to use /v1/input REST.
 */
export async function sendControlEvent(
  activeStream: { video: VideoSize; writer: (bytes: Buffer[]) => Promise<void> } | null | undefined,
  raw: string,
): Promise<StreamOffResult> {
  const parsed = parseControlJson(raw);
  if (!parsed.ok) throw new ControlError(parsed.code, parsed.message);
  if (!activeStream) {
    return { ok: false, code: "STREAM_OFF", reason: "no active stream; use /v1/input REST fallback" };
  }
  const messages = encodeControlEvent(parsed.event, activeStream.video);
  await activeStream.writer(messages);
  return { ok: true, messages };
}