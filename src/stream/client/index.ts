/**
 * Public browser client for the device-streaming WS contract (task 3.4, D7).
 *
 * ```ts
 * const client = createStreamClient({
 *   url: "ws://127.0.0.1:8765/v1/stream/video",
 *   canvas,
 *   onStatus: (s) => { /* connecting → handshake → streaming | error | closed *\/ },
 * });
 * client.open();
 * client.sendInput({ type: "inject", event: "tap", x, y });
 * ```
 *
 * Wire contract (README §Streaming WebSockets): the video socket delivers a
 * JSON handshake first, then ONE binary Annex-B access unit per message,
 * then JSON state messages; the control socket accepts JSON inject events
 * and acks/errors. Control URL is derived from the video URL
 * (`/video` → `/control`).
 *
 * Browser-only: no Bun/node APIs. Sockets, the VideoDecoder and the support
 * probe are injectable so the suite runs headless under bun — the real
 * WebCodecs path is validated on the demo page (examples/stream.html).
 */

import { AnnexBSplitter, classifyNal } from "./annexb";
import { DecoderSession, type CanvasLike, type DecoderLike } from "./decoder";
import { isStreamSupported } from "./support";
import type {
  ControlAckMessage,
  ControlErrorMessage,
  ControlEvent,
  StreamStateMessage,
  VideoHandshake,
} from "../types";

export { isStreamSupported } from "./support";
export type { CanvasLike, DecodedNal, DecoderLike } from "./decoder";

/** Client lifecycle phases, mirroring the server's state contract. */
export type StreamClientStatus =
  | { phase: "connecting" }
  | { phase: "handshake" }
  | { phase: "streaming" }
  | { phase: "error"; message: string }
  | { phase: "closed"; code?: number };

/** Server contract messages the client can surface (README §WS Contract). */
export type StreamClientMessage = ControlAckMessage | ControlErrorMessage | StreamStateMessage;

/**
 * Structural WebSocket surface (DOM-agnostic). Handler properties are
 * `unknown` so platform sockets (browser/Bun) and test doubles both fit;
 * the platform invokes them with its own event objects.
 */
export interface VideoSocketLike {
  binaryType: string;
  onopen: unknown;
  onmessage: unknown;
  onclose: unknown;
  onerror: unknown;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** Dependency injection seam (tests substitute sockets/decoder/support). */
export interface StreamClientDeps {
  createVideoSocket?: (url: string) => VideoSocketLike;
  createControlSocket?: (url: string) => VideoSocketLike;
  decoder?: DecoderLike;
  /** Support probe override (default: real isStreamSupported()). */
  support?: () => boolean;
}

export interface StreamClientOptions {
  /** Video WS URL, e.g. `ws://127.0.0.1:8765/v1/stream/video`. */
  url: string;
  /** Caller-owned canvas the decoded frames are drawn onto. */
  canvas: CanvasLike;
  onStatus: (status: StreamClientStatus) => void;
  deps?: StreamClientDeps;
}

export interface StreamClient {
  /** Connect both sockets and start decoding. Safe to call once. */
  open(): Promise<void>;
  /** Close both sockets + the decoder. Idempotent. */
  close(): void;
  /**
   * Inject an input event over the control socket (README §WS Contract).
   * Returns false when the control socket is not open (no active stream —
   * the caller should fall back to REST /v1/input/*).
   */
  sendInput(event: ControlEvent): boolean;
  /** Optional listener for server contract messages (state / ack / error). */
  onMessage?: (msg: StreamClientMessage) => void;
  /** Video size from the handshake (set once configured). */
  readonly videoSize: { width: number; height: number } | null;
}

/** Structural adaptation of the platform WebSocket — one cast at the edge. */
const defaultSocketFactory = (url: string): VideoSocketLike =>
  new WebSocket(url) as unknown as VideoSocketLike;

/** Normalize WS binary payloads (binaryType=arraybuffer). */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

export function createStreamClient(opts: StreamClientOptions): StreamClient {
  const deps = opts.deps ?? {};
  const videoUrl = opts.url;
  const controlUrl = videoUrl.replace(/\/video$/, "/control");
  const videoSock = (deps.createVideoSocket ?? defaultSocketFactory)(videoUrl);
  const controlSock = (deps.createControlSocket ?? defaultSocketFactory)(controlUrl);
  const splitter = new AnnexBSplitter();
  const status = (s: StreamClientStatus): void => opts.onStatus(s);

  let session: DecoderSession | null = null;
  let controlOpen = false;
  let closed = false;
  let started = false;
  let onMessage: StreamClient["onMessage"];
  const size = { current: null as { width: number; height: number } | null };

  /** JSON messages on the video socket: handshake or state. */
  const onVideoJson = (raw: string): void => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw) as unknown;
    } catch {
      return; // malformed message — never crash the page
    }
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    if (m.type === "handshake") {
      const hs = m as unknown as VideoHandshake;
      if (hs.codec !== "h264") {
        status({ phase: "error", message: `unsupported codec: ${String(hs.codec)}` });
        return;
      }
      size.current = { width: hs.width, height: hs.height };
      void session
        ?.configure(hs)
        .then(() => status({ phase: "handshake" }))
        .catch((e: unknown) =>
          status({ phase: "error", message: e instanceof Error ? e.message : "decoder configure failed" }),
        );
      return;
    }
    if (m.type === "state") {
      const st = m as unknown as StreamStateMessage;
      onMessage?.(st);
      if (st.state === "error") {
        status({ phase: "error", message: st.reason ?? "stream error" });
      }
    }
  };

  /** Binary messages on the video socket: one Annex-B AU per message. */
  const onVideoBinary = (data: unknown): void => {
    const bytes = toBytes(data);
    if (!bytes) return;
    splitter.push(bytes);
    for (const nal of splitter.drain(true)) {
      session?.decode({ type: classifyNal(nal), data: nal });
    }
  };

  /** JSON messages on the control socket: acks + errors. */
  const onControlJson = (raw: string): void => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    onMessage?.(msg as StreamClientMessage);
  };

  const api: StreamClient = {
    open(): Promise<void> {
      if (closed || started) return Promise.resolve();
      started = true;
      // Fail fast BEFORE touching sockets: the caller falls back to polling.
      const supported = deps.support ? deps.support() : isStreamSupported();
      if (!supported) {
        status({
          phase: "error",
          message: "WebCodecs H.264 decode unsupported in this browser — use the polling fallback",
        });
        return Promise.resolve();
      }
      status({ phase: "connecting" });
      try {
        const decoder =
          deps.decoder ??
          new (globalThis as { VideoDecoder?: new (init: object) => DecoderLike }).VideoDecoder!({
            output: () => {},
            error: () => {},
          });
        session = new DecoderSession({
          decoder,
          canvas: opts.canvas,
          onFirstFrame: () => status({ phase: "streaming" }),
          onError: (message) => status({ phase: "error", message }),
        });
      } catch {
        status({ phase: "error", message: "VideoDecoder unavailable — use the polling fallback" });
        return Promise.resolve();
      }
      videoSock.binaryType = "arraybuffer";
      videoSock.onopen = () => {
        // Video socket open — the server sends the handshake as message #1.
      };
      videoSock.onmessage = (ev: { data: unknown }) => {
        const d = (ev as { data: unknown }).data;
        if (typeof d === "string") onVideoJson(d);
        else onVideoBinary(d);
      };
      videoSock.onclose = (ev?: { code?: number }) => {
        if (!closed) {
          status({ phase: "closed", ...(ev?.code !== undefined ? { code: ev.code } : {}) });
        }
        controlOpen = false;
      };
      videoSock.onerror = () => {
        if (!closed) status({ phase: "error", message: "video socket error" });
      };
      controlSock.onopen = () => {
        controlOpen = true;
      };
      controlSock.onmessage = (ev: { data: unknown }) => {
        const d = (ev as { data: unknown }).data;
        if (typeof d === "string") onControlJson(d);
      };
      controlSock.onclose = () => {
        controlOpen = false;
      };
      controlSock.onerror = () => {
        controlOpen = false;
      };
      return Promise.resolve();
    },

    close(): void {
      if (closed) return;
      closed = true;
      controlSock.close();
      videoSock.close();
      void session?.close().catch(() => {});
      status({ phase: "closed" });
    },

    sendInput(event: ControlEvent): boolean {
      if (closed || !controlOpen) return false;
      controlSock.send(JSON.stringify(event));
      return true;
    },

    get videoSize(): { width: number; height: number } | null {
      return size.current;
    },

    get onMessage(): StreamClient["onMessage"] {
      return onMessage;
    },

    set onMessage(fn: StreamClient["onMessage"]) {
      onMessage = fn;
    },
  };

  return api;
}