/**
 * Wire-level and session types for the streaming core.
 *
 * PR1 (native gRPC control): the legacy byte-layout world (device/session
 * meta, frame meta, access-unit framing, control-socket message encodings)
 * is DELETED together with the in-guest encoder transport. What survives is
 * the transport-neutral contract surface: the WS control JSON contract, the
 * fan-out registry, the lifecycle snapshot, the logcat live-stream knobs,
 * and the WS close codes. PR2 adds the JSEP signaling types here (task 2.4).
 */

// ─── Fan-out ────────────────────────────────────────────────────────────

/** Maximum concurrent video viewers (design D4; ours — the emulator has none). */
export const MAX_VIEWERS = 8;

/**
 * A registered video viewer: one JSEP signaling socket (or test double).
 * The socket carries JSON JSEP frames ONLY (spec: the WS MUST NOT carry
 * binary video frames) — the handshake/offer/ice/state shapes below.
 */
export interface StreamViewer {
  readonly id: string;
  /** Deliver a server→client JSEP signaling message (JSON text frame). */
  sendMessage(msg: RtcServerMessage): Promise<void> | void;
  /** True when the viewer's socket is still open. */
  get open(): boolean;
  /** Close the viewer socket (used on teardown/cap-reject/device loss). */
  close(): void;
}

/** Viewer registry with the cap enforced at add-time. */
export interface FanoutRegistry {
  /** Current connected viewer count. */
  readonly count: number;
  /**
   * Register a viewer. Returns false (and closes the viewer) when the cap
   * is reached; otherwise the viewer receives broadcasts until removed.
   */
  add(viewer: StreamViewer): boolean;
  /** Remove a viewer by id; returns false when unknown. */
  remove(id: string): boolean;
  /** Deliver a signaling message to every registered viewer (advisory). */
  broadcast(msg: RtcServerMessage): void;
  /** Close and clear all viewers (session teardown / device loss). */
  closeAll(): void;
}

// ─── JSEP signaling contract (design §Interfaces, task 2.4) ─────────────

/** RTCIceCandidateInit as it rides the WS (relayed verbatim). */
export interface RtcIceCandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

/** RTC signaling states (design §WS Contract). */
export type RtcStreamState = "connecting" | "streaming" | "error";

/**
 * Additive /v1/state `stream.rtc` object (task 2.7): the RTC video surface.
 * `guid` is the first active viewer's RtcId; `fps` is the configured -rtcfps
 * value; `reason` explains non-supported/non-active states.
 */
export interface RtcStateView {
  supported: boolean;
  active: boolean;
  viewers: number;
  guid?: string;
  fps?: number;
  reason?: string;
}

/** Server→client JSEP signaling frames (JSON text, never binary). */
export type RtcServerMessage =
  | { type: "handshake"; rtcId: string; fps: number; codecs: string[] }
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: RtcIceCandidateInit }
  | { type: "state"; state: RtcStreamState; reason?: string };

/** Client→server JSEP signaling frames (the answer/ice/state subset). */
export type RtcClientMessage =
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: RtcIceCandidateInit }
  | { type: "state"; state: "streaming" };

/**
 * Parse + validate ONE client signaling frame (spec: Malformed signaling).
 * Unknown or malformed input MUST produce a typed error — the bridge sends a
 * JSON error body and closes; it NEVER hangs or silently drops the frame.
 * The client may report only `state:"streaming"` (peer connected) — error
 * states are server-driven.
 */
export type ParseClientJsepResult =
  | { ok: true; msg: RtcClientMessage }
  | { ok: false; code: "BAD_MESSAGE"; message: string };

export function parseClientJsep(raw: string): ParseClientJsepResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "BAD_MESSAGE", message: "signaling frame is not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "BAD_MESSAGE", message: "signaling frame must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  switch (obj.type) {
    case "answer":
      if (typeof obj.sdp === "string" && obj.sdp.length > 0) {
        return { ok: true, msg: { type: "answer", sdp: obj.sdp } };
      }
      return { ok: false, code: "BAD_MESSAGE", message: "answer requires a non-empty sdp string" };
    case "ice": {
      const candidate = obj.candidate;
      if (
        candidate !== null && typeof candidate === "object" && !Array.isArray(candidate) &&
        typeof (candidate as Record<string, unknown>).candidate === "string"
      ) {
        // Verbatim relay: the candidate dictionary passes through untouched.
        return { ok: true, msg: { type: "ice", candidate: candidate as RtcIceCandidateInit } };
      }
      return { ok: false, code: "BAD_MESSAGE", message: "ice requires an RTCIceCandidateInit dictionary" };
    }
    case "state":
      if (obj.state === "streaming") {
        return { ok: true, msg: { type: "state", state: "streaming" } };
      }
      return { ok: false, code: "BAD_MESSAGE", message: "state must be 'streaming' (client→server)" };
    default:
      return { ok: false, code: "BAD_MESSAGE", message: `unknown signaling type: ${String(obj.type)}` };
  }
}

/**
 * The JSEP dictionary inside a gRPC JsepMsg.message (probe B, verbatim
 * relay): {"start":{}}, {"sdp","type"}, {"candidate","sdpMid","sdpMLineIndex"},
 * {"bye":true}. The adapter decodes this once; contents are relayed verbatim.
 */
export type JsepPayload =
  | { start: Record<string, unknown> }
  | { type: string; sdp: string }
  | (RtcIceCandidateInit & Record<string, unknown>)
  | { bye: true };

/** Decode one gRPC JsepMsg.message; null when it is not a known payload. */
export function parseJsepPayload(raw: string): JsepPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj["start"] === "object" && obj["start"] !== null) return obj as JsepPayload;
  if (obj["bye"] === true) return { bye: true };
  if (typeof obj["sdp"] === "string" && typeof obj["type"] === "string") {
    return obj as JsepPayload;
  }
  if (typeof obj["candidate"] === "string") return obj as JsepPayload;
  return null;
}

// ─── WS /v1/stream/control contract (frozen, design D3) ─────────────────

export type ControlEvent =
  | { type: "inject"; event: "tap"; x: number; y: number }
  | { type: "inject"; event: "swipe"; x1: number; y1: number; x2: number; y2: number; durationMs?: number }
  | { type: "inject"; event: "text"; text: string }
  | { type: "inject"; event: "key"; keycode: number };

export type ControlAckMessage = { type: "ack" };
export type ControlErrorMessage = { type: "error"; code: string; message: string };

// ─── Stream lifecycle / state (design D5, D6) ───────────────────────────

export interface StreamSnapshot {
  supported: boolean;
  active: boolean;
  reason?: string;
  viewers: number;
}

// ─── Logcat live stream (bridge-surface-v2, design D5) ──────────────────

/** Requested-backlog ceiling: clamp(backlog ?? default, 0, cap) per filter frame. */
export const LOGCAT_BACKLOG_CAP = 1000;

/** Default replay depth when the filter frame omits `backlog`. */
export const LOGCAT_BACKLOG_DEFAULT = 100;

/**
 * Per-subscriber drop-oldest queue depth (Fanout drain precedent): a stalled
 * reader discards its OLDEST undelivered lines so newest ones keep flowing
 * without unbounded memory growth.
 */
export const LOGCAT_QUEUE_DEPTH = 256;

/**
 * Hard cap on concurrent logcat subscribers per bridge daemon (design D5,
 * MAX_VIEWERS alignment): the next subscribe attempt is closed 4429
 * VIEWER_CAP instead of multiplying long-lived adb children unboundedly.
 */
export const LOGCAT_SUBSCRIBER_CAP = 8;

// ─── WS /v1/stream close codes (design §WS Contract + Error States) ─────

export const WS_CLOSE_CODES = {
  /** Malformed/unknown signaling frame (JSON error body then close). */
  BAD_MESSAGE: 4400,
  /** PERMISSION_DENIED: token/allowlist blocks the requested surface. */
  PERMISSION_DENIED: 4401,
  /** No usable device (stream cannot start — device gone at start). */
  NO_DEVICE: 4404,
  /** Device lost mid-stream (spec: Device lost mid-stream). */
  DEVICE_LOST: 4409,
  /** Streaming unsupported: kill-switch off, gateway absent, degraded env. */
  UNSUPPORTED: 4403,
  /** Viewer cap reached (design D4). */
  VIEWER_CAP: 4429,
} as const;
