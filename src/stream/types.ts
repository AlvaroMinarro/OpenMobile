/**
 * Wire-level and session types for the device-streaming core (design D1-D7).
 *
 * The byte layouts here are pinned to the bundled scrcpy-server v4.1 jar —
 * see assets/README.md. All multi-byte integers are BIG-ENDIAN on the wire.
 */

// ─── scrcpy video socket (connection #1) ────────────────────────────────

/** 64 bytes, ASCII, null-padded (send_device_meta=true). */
export const DEVICE_META_LEN = 64;

/** 4-byte codec id, ASCII ("h264" = 0x68323634). */
export const CODEC_ID_LEN = 4;

/** 12-byte session meta: flags u32 + width u32 + height u32. */
export const SESSION_META_LEN = 12;

/** Session meta flag: this is a session header, not a frame. */
export const META_FLAG_SESSION = 0x8000_0000;

/** 12-byte frame meta header: ptsAndFlags u64 + len u32. */
export const FRAME_META_LEN = 12;

/**
 * Max bytes a single frame may declare (frame-meta `len`). Real frames at
 * 8 Mbps/30fps are ~35 KB — 16 MiB is ~450× headroom, so the bound only
 * trips on corruption or a hostile peer. Guards the assembler against
 * `len=0xFFFFFFFF` → unbounded Buffer.concat accumulation → OOM (the bridge
 * daemon runs REST + streaming; one OOM kills everything).
 */
export const MAX_FRAME = 16 * 1024 * 1024;

/**
 * Hard cap on the StreamAssembler accumulator: one legal frame (< MAX_FRAME)
 * plus one in-flight data burst, before concat. ~32 MiB bounds memory even
 * when a hostile peer sends oversized chunks with legal declared lengths.
 */
export const MAX_ACCUMULATED = MAX_FRAME * 2 + FRAME_META_LEN;

/** Frame-meta flag bits inside ptsAndFlags (upper 2 bits). */
export const FLAG_CONFIG = 1n << 62n; // bit62 — SPS/PPS AU
export const FLAG_KEY = 1n << 61n; // bit61 — keyframe (IDR)
export const PTS_MASK = (1n << 61n) - 1n; // low 61 bits

/** scrcpy stream-format version negotiated by the server (design D1 pin). */
export const SCRCPY_VERSION = "4.1";

/** Device-side jar path the adapter pushes to (design §Live-validated facts). */
export const JAR_DEVICE_PATH = "/data/local/tmp/scrcpy-server.jar";

// ─── Control socket (connection #2) message types (scrcpy v4.1) ─────────

export const TYPE_INJECT_KEYCODE = 0;
export const TYPE_INJECT_TEXT = 1;
export const TYPE_INJECT_TOUCH_EVENT = 2;

export const TOUCH_ACTION_DOWN = 0;
export const TOUCH_ACTION_UP = 1;
export const TOUCH_ACTION_MOVE = 2;

/** Total encoded length of a touch event. */
export const TOUCH_MESSAGE_LEN = 32;
/** Total encoded length of a keycode event. */
export const KEYCODE_MESSAGE_LEN = 14;

// ─── Parsed session / frame / control shapes ────────────────────────────

/** Parsed 64B device meta + 12B session meta. */
export interface SessionMeta {
  /** ASCII device name from the 64B header (null-padded). */
  deviceName: string;
  /** 4-char codec id, e.g. "h264". */
  codecId: string;
  /** Raw session flags (META_FLAG_SESSION for a session header). */
  flags: number;
  /** Video width in scrcpy frames (e.g. 430 with max_size=960). */
  width: number;
  /** Video height in scrcpy frames. */
  height: number;
}

/** Parsed 12B frame meta: pts + len + frame-kind flags. */
export interface FrameMeta {
  /** Presentation timestamp in µs (low 61 bits of ptsAndFlags). */
  pts: bigint;
  /** True when the payload is a CONFIG AU (SPS/PPS) — bit 62. */
  isConfig: boolean;
  /** True when the payload starts with a keyframe (IDR) — bit 61. */
  isKey: boolean;
  /** Payload length in bytes (Annex-B AU). */
  len: number;
}

// ─── Fan-out ────────────────────────────────────────────────────────────

/** Maximum concurrent video viewers (design D4). */
export const MAX_VIEWERS = 8;

/** Per-viewer drop-oldest queue depth (design D4). */
export const VIEWER_QUEUE_DEPTH = 4;

/** A registered video viewer: a WebSocket (or test double) that receives AUs. */
export interface StreamViewer {
  readonly id: string;
  /** Deliver a JSON handshake; resolves once accepted. */
  sendHandshake(handshake: VideoHandshake): Promise<void> | void;
  /** Deliver one Annex-B AU as a binary message; resolves when written. */
  sendFrame(frame: Uint8Array): Promise<void> | void;
  /** Deliver a JSON state message (buffering/streaming/error). */
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
  /** Close and clear all viewers (session teardown). */
  closeAll(): void;
}

// ─── WS /v1/stream/video contract (design D2) ───────────────────────────

export interface VideoHandshake {
  type: "handshake";
  codec: "h264";
  /** Frame-meta length the server uses (pinned to the bundled jar). */
  lengthSize: 12;
  width: number;
  height: number;
  /** base64 SPS NAL (after the start code). */
  sps: string;
  /** base64 PPS NAL (after the start code). */
  pps: string;
}

export type StreamState = "buffering" | "streaming" | "error";

export interface StreamStateMessage {
  type: "state";
  state: StreamState;
  reason?: string;
}

// ─── WS /v1/stream/control contract (design D3) ─────────────────────────

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

// ─── WS /v1/stream close codes (design §WS Contract) ────────────────────

export const WS_CLOSE_CODES = {
  /** Streaming unsupported: kill-switch off, gateway absent, degraded env. */
  UNSUPPORTED: 4403,
  /** No usable device (push/reverse/spawn failed — device gone at start). */
  NO_DEVICE: 4404,
  /** Viewer cap reached (design D4). */
  VIEWER_CAP: 4429,
  /** Device lost mid-stream (spec: Device lost mid-stream). */
  DEVICE_LOST: 4409,
} as const;