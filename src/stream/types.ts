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

/** Maximum concurrent video viewers (design D4). */
export const MAX_VIEWERS = 8;

/** Per-viewer drop-oldest queue depth (design D4). */
export const VIEWER_QUEUE_DEPTH = 4;

/** A registered video viewer: a WebSocket (or test double). */
export interface StreamViewer {
  readonly id: string;
  /** Deliver the stream handshake (first frame on the socket). */
  sendHandshake(handshake: unknown): Promise<void> | void;
  /** Deliver a stream payload; resolves when written. */
  sendFrame(frame: Uint8Array): Promise<void> | void;
  /** Deliver a JSON state message (streaming/error). */
  sendState(state: StreamStateMessage): Promise<void> | void;
  /** True when the viewer's socket is still open. */
  get open(): boolean;
  /** Close the viewer socket (used on teardown/cap-reject). */
  close(): void;
}

/** Viewer registry with per-viewer drop-oldest queues + cap enforcement. */
export interface FanoutRegistry {
  /** Current connected viewer count. */
  readonly count: number;
  /**
   * Register a viewer. Returns false (and closes the viewer) when the cap
   * is reached; otherwise delivers future frames without blocking.
   */
  add(viewer: StreamViewer): boolean;
  /** Remove a viewer by id; returns false when unknown. */
  remove(id: string): boolean;
  /** Queue the frame for every registered viewer (drop-oldest per viewer). */
  broadcast(frame: Uint8Array): void;
  /** Deliver a state message to every registered viewer (streaming/error). */
  broadcastState(state: StreamStateMessage): void;
  /** Close and clear all viewers (session teardown). */
  closeAll(): void;
}

// ─── WS state messages ──────────────────────────────────────────────────

export type StreamState = "buffering" | "streaming" | "error";

export interface StreamStateMessage {
  type: "state";
  state: StreamState;
  reason?: string;
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
  /** Streaming unsupported: kill-switch off, gateway absent, degraded env. */
  UNSUPPORTED: 4403,
  /** No usable device (stream cannot start — device gone at start). */
  NO_DEVICE: 4404,
  /** PERMISSION_DENIED: token/allowlist blocks the requested surface. */
  PERMISSION_DENIED: 4401,
  /** Viewer cap reached (design D4). */
  VIEWER_CAP: 4429,
  /** Device lost mid-stream (spec: Device lost mid-stream). */
  DEVICE_LOST: 4409,
} as const;
