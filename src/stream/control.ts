/**
 * Control bridge — JSON control events → gRPC unary injection (design D3/D5).
 *
 * The /v1/stream/control WS route and the /v1/input REST routes receive JSON
 * like `{type:"inject", event:"tap", x,y}` and inject through the emulator's
 * EmulatorController gRPC surface (device PHYSICAL pixels — design D5; the
 * scrcpy video-space mapping is gone with the scrcpy transport). This module
 * owns:
 *  - `parseControlJson`: validate the frozen WS contract shapes,
 *  - `grpcControlInjector`: route a parsed event onto the gRPC control
 *    client (tap/swipe → sendTouch, text/key → sendKey; there is NO sendText
 *    RPC — text rides KeyboardEvent{text}, probe D),
 *  - typed errors so the WS layer can map them onto error frames,
 *  - `sendControlEvent`: the bridge entrypoint that returns a typed
 *    "stream-off" result when no injector is active.
 *
 * Coordinates are validated CLIENT-SIDE against the physical display
 * configuration inside `GrpcEmulatorControl` (out-of-range input is silently
 * accepted by the emulator — probe-verified); the resulting OUT_OF_RANGE
 * surfaces here as a ControlError.
 */

import type { ControlEvent } from "./types";
import type { EmulatorControl } from "../device/grpc";
import { GrpcControlError } from "../device/grpc";

/** Typed control error codes (mapped onto WS error frames by the route). */
export type ControlErrorCode =
  | "OUT_OF_RANGE"
  | "UNSUPPORTED_CHAR"
  | "UNSUPPORTED_EVENT"
  | "INVALID_JSON"
  | "STREAM_OFF"
  | "INJECTION_FAILED"
  | "PERMISSION_DENIED"
  | "DEVICE_OFFLINE";

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

// ─── JSON contract parsing (frozen WS contract) ──────────────────────────

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

// ─── gRPC-backed injector (design D3/D5) ─────────────────────────────────

/** One injectable control surface (the bridge's control channel entrypoint). */
export interface ControlInjector {
  /** Inject ONE parsed control event. Throws ControlError on failure. */
  inject(event: ControlEvent): Promise<void>;
}

/** Map a gRPC control failure onto the typed ControlError the WS layer knows. */
function toControlError(e: unknown): ControlError {
  if (e instanceof ControlError) return e;
  if (e instanceof GrpcControlError) {
    return new ControlError(e.code, e.message, e.details);
  }
  const message = e instanceof Error ? e.message : String(e);
  return new ControlError("INJECTION_FAILED", `control injection failed: ${message}`);
}

/**
 * Build the gRPC-backed injector over an EmulatorController client
 * (device physical px; probe-verified 12ms unary round-trips).
 */
export function grpcControlInjector(control: EmulatorControl): ControlInjector {
  return {
    async inject(event: ControlEvent): Promise<void> {
      try {
        switch (event.event) {
          case "tap":
            await control.tap(event.x, event.y);
            return;
          case "swipe":
            await control.swipe(event.x1, event.y1, event.x2, event.y2, event.durationMs);
            return;
          case "text":
            // No sendText RPC exists — text rides sendKey(KeyboardEvent{text})
            // (probe D, design D3). Full UTF-8: no scrcpy ASCII restriction.
            await control.text(event.text);
            return;
          case "key":
            // codeType Usb=0: the WS keycode space is the emulator's raw
            // input code (translated via the emulator's chromium tables).
            await control.keyCode(event.keycode, 0);
            return;
          default:
            throw new ControlError(
              "UNSUPPORTED_EVENT",
              `unsupported control event: ${(event as { event?: string }).event}`,
            );
        }
      } catch (e) {
        throw toControlError(e);
      }
    },
  };
}

// ─── Bridge entrypoint ───────────────────────────────────────────────────

/** Result of sending a control event when NO injector is active. */
export type StreamOffResult =
  | { ok: true }
  | { ok: false; code: "STREAM_OFF"; reason: string };

/**
 * Parse and inject a control event through the ACTIVE injector. When no
 * injector is active, returns the typed STREAM_OFF result — the caller
 * (WS route or fallback) decides whether to use /v1/input REST.
 */
export async function sendControlEvent(
  injector: ControlInjector | null | undefined,
  raw: string,
): Promise<StreamOffResult> {
  const parsed = parseControlJson(raw);
  if (!parsed.ok) throw new ControlError(parsed.code, parsed.message);
  if (!injector) {
    return { ok: false, code: "STREAM_OFF", reason: "no active stream; use /v1/input REST fallback" };
  }
  await injector.inject(parsed.event);
  return { ok: true };
}
