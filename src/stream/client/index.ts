/**
 * Browser RTC stream client (Phase 3 / PR3, task 3.1).
 *
 * The browser is a WebRTC peer (design D1): this client opens the JSON JSEP
 * signaling WebSocket (`/v1/stream/video`), drives the RTCPeerConnection
 * through the emulator's offer (VP8 is mandatory — the emulator's RtcService
 * v1 answer is video-only VP8), and relays answer/ICE/state frames back.
 * Media flows browser↔emulator over loopback UDP; the daemon touches no
 * media bytes (spec: the WS MUST NOT carry binary video frames).
 *
 * Wire contract (src/stream/types.ts, pinned by the Phase-2 daemon):
 *   server → client: handshake first, then offer / ice / state frames.
 *   client → server: answer / ice / state ("streaming").
 *   close codes: 4400 BAD_MESSAGE, 4401 PERMISSION_DENIED, 4403 UNSUPPORTED,
 *   4404 NO_DEVICE, 4409 DEVICE_LOST, 4429 VIEWER_CAP.
 *
 * Browser-only module: no Bun/node APIs. Sockets and the RTCPeerConnection
 * are injectable so the suite runs headless under bun against a fake WS
 * server + fake PC (the real WebRTC path is validated on the demo page).
 */

import type {
  ControlAckMessage,
  ControlErrorMessage,
  ControlEvent,
  RtcIceCandidateInit,
  RtcStreamState,
} from "../types";

// ─── Structural seams (DOM-agnostic; one cast at the platform edge) ──────

/** JSON text socket surface (browser/Bun WebSocket or test double). */
export interface SignalSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  onopen: unknown;
  onmessage: unknown;
  onclose: unknown;
  onerror: unknown;
}

/** Structural RTCPeerConnection surface the client actually drives. */
export interface PeerConnectionLike {
  readonly localDescription: { type: string; sdp: string } | null;
  connectionState: string;
  onicecandidate: ((ev: { candidate: RtcIceCandidateInit | null }) => void) | null;
  ontrack: ((ev: { track: unknown; streams: readonly unknown[] }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  setRemoteDescription(desc: { type: string; sdp: string }): Promise<void>;
  createAnswer(): Promise<{ type: string; sdp: string }>;
  setLocalDescription(desc: { type: string; sdp: string }): Promise<void>;
  addIceCandidate(candidate: RtcIceCandidateInit): Promise<void>;
  close(): void;
}

/** Caller-owned <video> element (structural — srcObject assignment only). */
export interface VideoSinkLike {
  srcObject: unknown;
}

/** Client lifecycle phases, mirroring the server's state contract. */
export type StreamClientStatus =
  | { phase: "connecting" }
  | { phase: "handshake"; rtcId: string; fps: number }
  | { phase: "streaming" }
  | { phase: "error"; message: string }
  | { phase: "closed"; code?: number; reason?: string };

/** Server contract messages the client can surface (state / ack / error). */
export type StreamClientMessage =
  | ControlAckMessage
  | ControlErrorMessage
  | { type: "state"; state: RtcStreamState; reason?: string };

export interface StreamClientDeps {
  createSignalSocket?: (url: string) => SignalSocketLike;
  createControlSocket?: (url: string) => SignalSocketLike;
  createPeerConnection?: () => PeerConnectionLike;
}

export interface StreamClientOptions {
  /** Video signaling WS URL, e.g. `ws://127.0.0.1:8765/v1/stream/video`. */
  url: string;
  /** Caller-owned video element the remote track's MediaStream attaches to. */
  video: VideoSinkLike;
  onStatus?: (status: StreamClientStatus) => void;
  deps?: StreamClientDeps;
}

export interface StreamClient {
  /** Connect the signal socket and complete the JSEP answer. Call once. */
  open(): Promise<void>;
  /** Close the peer connection + both sockets. Idempotent. */
  close(): void;
  /**
   * Inject an input event over the control socket (`/video` → `/control`,
 * frozen contract). Returns false when the control socket is not open —
   * route input through `POST /v1/input/*` in that case.
   */
  sendInput(event: ControlEvent): boolean;
  /** Optional listener for server contract messages (state / ack / error). */
  onMessage?: (msg: StreamClientMessage) => void;
  /** Handshake facts (rtcId + configured fps) once received. */
  readonly info: { rtcId: string; fps: number } | null;
}

/** VP8 is mandatory (proposal D1): every other codec gate is deleted. */
export function hasVp8(codecs: readonly string[]): boolean {
  return codecs.some((c) => c.toUpperCase() === "VP8");
}

/** The control WS is the video URL with the `/video` suffix swapped. */
export function deriveControlUrl(videoUrl: string): string {
  return videoUrl.replace(/\/video(?=$|\?)/, "/control");
}

const WS_OPEN = 1;

/** Structural adaptation of the platform WebSocket — one cast at the edge. */
const defaultSocketFactory = (url: string): SignalSocketLike =>
  new WebSocket(url) as unknown as SignalSocketLike;

export function createStreamClient(opts: StreamClientOptions): StreamClient {
  const deps = opts.deps ?? {};
  const makeSocket = deps.createSignalSocket ?? defaultSocketFactory;
  const makeControlSocket = deps.createControlSocket ?? makeSocket;
  const makePeerConnection =
    deps.createPeerConnection ?? (() => new RTCPeerConnection() as unknown as PeerConnectionLike);

  const controlUrl = deriveControlUrl(opts.url);
  let signal: SignalSocketLike | null = null;
  let pc: PeerConnectionLike | null = null;
  let control: SignalSocketLike | null = null;
  let closedByUs = false;
  let finished = false; // one terminal status wins (error or closed)
  let handshakeSeen = false;
  let answered = false;
  let streamingSent = false;
  let info: { rtcId: string; fps: number } | null = null;
  /** Remote candidates arriving before the offer is applied (robustness). */
  let pendingRemoteIce: RtcIceCandidateInit[] = [];
  /** Local candidates generated before our answer is set (defensive buffer). */
  let pendingLocalIce: RtcIceCandidateInit[] = [];

  let resolveOpen: (() => void) | null = null;
  let rejectOpen: ((e: Error) => void) | null = null;
  const openPromise = new Promise<void>((res, rej) => {
    resolveOpen = res;
    rejectOpen = rej;
  });

  /** The assignable listener lives behind a getter/setter (see return). */
  let messageListener: ((msg: StreamClientMessage) => void) | undefined;
  const emitMessage = (msg: StreamClientMessage): void => {
    messageListener?.(msg);
  };

  const status = (s: StreamClientStatus): void => {
    if (finished) return;
    if (s.phase === "error" || s.phase === "closed") finished = true;
    opts.onStatus?.(s);
  };

  const fail = (message: string): void => {
    status({ phase: "error", message });
    teardownSockets();
    rejectOpen?.(new Error(message));
  };

  const teardownSockets = (): void => {
    pc?.close();
    pc = null;
    signal?.close();
    signal = null;
  };

  const send = (msg: unknown): void => {
    try {
      signal?.send(JSON.stringify(msg));
    } catch {
      // A send on a dying socket races the close event; nothing to do.
    }
  };

  const addRemoteCandidate = (candidate: RtcIceCandidateInit): void => {
    if (!pc || !answered) {
      pendingRemoteIce.push(candidate);
      return;
    }
    pc.addIceCandidate(candidate).catch(() => {
      // Transient ICE failures surface via connectionState, not as errors.
    });
  };

  const handleOffer = async (sdp: string): Promise<void> => {
    if (answered || !pc) return;
    try {
      await pc.setRemoteDescription({ type: "offer", sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "answer", sdp: pc.localDescription?.sdp ?? answer.sdp });
      answered = true;
      for (const candidate of pendingRemoteIce.splice(0)) {
        pc.addIceCandidate(candidate).catch(() => {});
      }
      resolveOpen?.();
    } catch (e) {
      fail(`answer failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleFrame = async (raw: string): Promise<void> => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return fail("malformed signaling frame (not valid JSON)");
    }
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      return fail("signaling frame must be a JSON object");
    }
    const obj = msg as Record<string, unknown>;
    switch (obj.type) {
      case "handshake": {
        if (handshakeSeen) return fail("duplicate handshake");
        if (typeof obj.rtcId !== "string" || typeof obj.fps !== "number" || !Array.isArray(obj.codecs)) {
          return fail("handshake requires rtcId, fps and codecs");
        }
        if (!hasVp8(obj.codecs as string[])) {
          return fail(`VP8 is mandatory but the handshake offered: ${(obj.codecs as string[]).join(", ")}`);
        }
        handshakeSeen = true;
        info = { rtcId: obj.rtcId as string, fps: obj.fps as number };
        pc = pc ?? makePeerConnection();
        wirePeerConnection(pc);
        status({ phase: "handshake", rtcId: info.rtcId, fps: info.fps });
        return;
      }
      case "offer":
        if (!handshakeSeen) return fail("offer before handshake");
        await handleOffer(obj.sdp as string);
        return;
      case "answer":
        if (!handshakeSeen) return fail("answer before handshake");
        await pc?.setRemoteDescription({ type: "answer", sdp: obj.sdp as string });
        return;
      case "ice": {
        if (!handshakeSeen) return fail("ice before handshake");
        const candidate = obj.candidate as RtcIceCandidateInit | undefined;
        if (!candidate || typeof candidate.candidate !== "string") {
          return fail("ice frame requires an RTCIceCandidateInit candidate");
        }
        addRemoteCandidate(candidate);
        return;
      }
      case "state": {
        const state = obj.state as RtcStreamState;
        const reason = typeof obj.reason === "string" ? obj.reason : undefined;
        emitMessage({ type: "state", state, reason });
        if (state === "error") status({ phase: "error", message: reason ?? "stream error" });
        return;
      }
      case "error": {
        // Rejection bodies (cap/permission/etc.) ride the same socket.
        emitMessage(obj as unknown as ControlErrorMessage);
        return;
      }
      default:
        return fail(`unknown signaling type: ${String(obj.type)}`);
    }
  };

  const wirePeerConnection = (connection: PeerConnectionLike): void => {
    connection.onicecandidate = (ev) => {
      if (!ev.candidate) return; // end-of-candidates — nothing to relay
      if (answered) {
        send({ type: "ice", candidate: ev.candidate });
      } else {
        pendingLocalIce.push(ev.candidate); // flushed right after the answer
      }
    };
    connection.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (stream !== undefined) opts.video.srcObject = stream;
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "connected" && !streamingSent) {
        streamingSent = true;
        send({ type: "state", state: "streaming" });
        status({ phase: "streaming" });
      } else if (connection.connectionState === "failed") {
        status({ phase: "error", message: "peer connection failed" });
      }
    };
  };

  return {
    open(): Promise<void> {
      if (signal) return openPromise;
      status({ phase: "connecting" });
      signal = makeSocket(opts.url);
      // Server speaks first (handshake first — Phase-2 daemon contract).
      signal.onmessage = (ev: { data: unknown }) => {
        const data = (ev as { data?: unknown }).data;
        void handleFrame(typeof data === "string" ? data : String(data));
      };
      signal.onclose = (ev: { code?: number; reason?: string }) => {
        if (closedByUs || finished) return;
        const code = typeof ev?.code === "number" ? ev.code : undefined;
        const reason = typeof ev?.reason === "string" && ev.reason !== "" ? ev.reason : undefined;
        teardownSockets();
        status({ phase: "closed", ...(code !== undefined ? { code } : {}), ...(reason ? { reason } : {}) });
        rejectOpen?.(new Error(`signal socket closed${code !== undefined ? ` (${code})` : ""}`));
      };
      signal.onerror = () => {
        // The close event always follows; keep it from being unhandled.
      };
      return openPromise;
    },

    close(): void {
      if (closedByUs) return;
      closedByUs = true;
      teardownSockets();
      control?.close();
      control = null;
      status({ phase: "closed" });
      rejectOpen?.(new Error("stream closed before signaling completed"));
    },

    sendInput(event: ControlEvent): boolean {
      if (closedByUs) return false;
      if (!control || control.readyState !== WS_OPEN) {
        if (!control) {
          control = makeControlSocket(controlUrl);
          control.onmessage = (ev: { data: unknown }) => {
            const data = (ev as { data?: unknown }).data;
            const text = typeof data === "string" ? data : String(data);
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              return;
            }
            const msg = parsed as Record<string, unknown>;
            if (msg.type === "ack" || msg.type === "error") {
              emitMessage(parsed as unknown as ControlAckMessage | ControlErrorMessage);
            }
          };
          control.onclose = () => {};
          control.onerror = () => {};
        }
        return false;
      }
      try {
        control.send(JSON.stringify(event));
        return true;
      } catch {
        return false;
      }
    },

    get onMessage() {
      return messageListener;
    },

    set onMessage(fn: ((msg: StreamClientMessage) => void) | undefined) {
      messageListener = fn;
    },

    get info() {
      return info;
    },
  };
}
