/**
 * StreamManager — stream lifecycle controller (design D5, D6).
 *
 * UI-agnostic session lifecycle on top of the scrcpy adapter:
 *  - START on the first viewer subscribing (push→reverse→listen→spawn→read-loop),
 *  - TEARDOWN when the last viewer unsubscribes,
 *  - device-loss watchdog: while active, poll `adb devices -l`; when the
 *    stream's serial disappears, tear the session down and report
 *    `reason: "device_lost"` (spec: Device lost mid-stream, Restart after
 *    disconnect — re-subscribing restarts a fresh session).
 *
 * The manager does NOT know about WebSockets: routing a viewer/subscription
 * to a socket is the bridge's job (slice 2B). It exposes a typed interface
 * (subscribe/unsubscribe/start/stop/sendControl/snapshot/onEvent) that the
 * WS layer maps onto.
 */

import type { Device } from "../device/types";
import type { ControlEvent, FanoutRegistry, VideoHandshake } from "./types";

/** Video size reported by the session, updated from handshake meta. */
export interface StreamVideoInfo {
  width: number;
  height: number;
}

export type StreamManagerEvent =
  | { type: "started" }
  | { type: "stopped"; reason?: string }
  | { type: "error"; message: string };

/** Snapshot consumed by /v1/state (design D6) + the WS state message. */
export interface StreamSnapshot {
  supported: boolean;
  active: boolean;
  reason?: string;
  viewers: number;
}

/** A live scrcpy session handed to the manager by the adapter. */
export interface AdapterSession {
  serial: string;
  /** Non-null when the session reports the video size (from the handshake). */
  video?: StreamVideoInfo;
  /** Inject control bytes into the CONTROL socket. */
  sendControl(bytes: Uint8Array): Promise<void>;
  /** Register the device-loss callback (fires when the device vanishes). */
  onLoss(cb: (() => void) | undefined): void;
  /** Full teardown: kill spawn, remove reverse, clean jar. */
  close(): void;
  /** Session fan-out registry — the gateway attaches WS viewers (slice 2B). */
  fanout?: FanoutRegistry;
  /** Resolves with the handshake once the CONFIG frame is parsed (slice 2B). */
  handshakeReady?: Promise<VideoHandshake>;
  /** Resolves with the video size when the handshake lands (slice 2B). */
  ready?: Promise<StreamVideoInfo>;
}

/** Dependency surface StreamManager needs from the scrcpy adapter. */
export interface AdapterDeps {
  /** Produce a NEW session bound to the adapter's device (re-push + spawn). */
  start(serial: string): Promise<AdapterSession>;
  /** General adapter teardown (running sessions may self-manage). */
  stop(): Promise<void>;
}

/** Adapter events a session may emit while streaming. */
export interface AdapterEvent {
  type: "frame" | "handshake" | "control";
  // The manager forwards raw stream events; the bridge interprets them.
  data?: unknown;
}

export interface StreamManagerOptions {
  /** The scrcpy adapter (production: src/stream/scrcpy.ts wiring; tests: double). */
  adapter: AdapterDeps;
  /** Device the manager streams (serial that must stay in `adb devices`). */
  serial: string;
  /** False when OPENMOBILE_STREAM=off (design D6 kill-switch). Default true. */
  enabled?: boolean;
  /** Watchdog source; defaults to a real `adb devices -l` read. */
  pollDevices?: () => Promise<Device[]>;
  /** Watchdog poll interval ms. Default 3000. */
  watchdogMs?: number;
  /** Resolution of the video stream reported in the snapshot. */
  video?: StreamVideoInfo;
}

/**
 * Stream lifecycle controller. One manager = one stream (one serial).
 *
 * The watchdog is ONLY armed while a session is active (first viewer → last
 * viewer). It polls `adb devices`; if the stream serial is missing, the
 * session self-tears-down and the manager reports `reason: "device_lost"`.
 */
export class StreamManager {
  private readonly adapter: AdapterDeps;
  private serial: string;
  private readonly pollDevices: () => Promise<Device[]>;
  private readonly watchdogMs: number;
  private _enabled: boolean;
  private sessions: AdapterSession[] = [];
  private viewerRefs = 0;
  private active = false;
  private reason?: string;
  private _video: StreamVideoInfo;
  private watchdogTimer: ReturnType<typeof setInterval> | undefined;
  private eventHandler?: (e: StreamManagerEvent) => void;
  /** In-flight start guard so a failed adapter.start isn't retried in a loop. */
  private guarded = false;

  constructor(options: StreamManagerOptions) {
    this.adapter = options.adapter;
    this.serial = options.serial;
    this._enabled = options.enabled ?? true;
    this.pollDevices = options.pollDevices ?? defaultPollDevices;
    this.watchdogMs = options.watchdogMs ?? 3000;
    this._video = options.video ?? { width: 0, height: 0 };
  }

  /** Video size reported by the active session (0x0 before the handshake). */
  get videoInfo(): StreamVideoInfo {
    return this._video;
  }

  /** Subscribe a viewer — starts the stream on the FIRST subscriber. */
  subscribe(): StreamViewerSubscription | undefined {
    if (!this._enabled) return undefined;
    this.viewerRefs += 1;
    const subscription: StreamViewerSubscription = { id: `viewer-${this.viewerRefs}` };
    // Start on the first viewer; also re-attempt when a prior start failed
    // and no session is active (D5 recovery), even if more viewers joined.
    if (!this.active && this.viewerRefs >= 1) {
      void this.startedOnce().catch(() => {});
    }
    return subscription;
  }

  /** Unsubscribe a viewer — tears the stream down on the LAST one. */
  unsubscribe(subscription: StreamViewerSubscription): void {
    if (this.viewerRefs === 0) {
      this.viewerRefs = 0;
      return;
    }
    this.viewerRefs -= 1;
    if (this.viewerRefs === 0 && this.active) {
      this.reason = undefined;
      void this.stopSession();
    }
  }

  /** Serial the manager streams (the watchdog guards it). */
  get targetSerial(): string {
    return this.serial;
  }

  /**
   * Update the stream serial (used by the gateway when an "auto" target
   * resolves to a real device AFTER construction). The watchdog guards the
   * CURRENT serial; changing it mid-session is only safe pre-start.
   */
  updateTargetSerial(serial: string): void {
    this.serial = serial;
  }

  /** Whether the manager is enabled (OPENMOBILE_STREAM kill-switch). */
  get enabled(): boolean {
    return this._enabled;
  }

  /** Flip the kill-switch at runtime; in-flight sessions are left alone. */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  /** Register an observer for lifecycle events. Returns an unsubscribe fn. */
  onEvent(handler: (e: StreamManagerEvent) => void): () => void {
    this.eventHandler = handler;
    return () => {
      if (this.eventHandler === handler) this.eventHandler = undefined;
    };
  }

  /** Inject a control event (tap/swipe/text/key) into the active session. */
  async sendControl(event: ControlEvent): Promise<void> {
    const session = this.sessions[0];
    if (!session || !this.active) return;
    // Encoding is the control module's job (task 2.3); the manager only
    // routes the raw event to the session's control socket.
    const messages = encodeControlEvent(event, this._video);
    for (const bytes of messages) await session.sendControl(bytes);
  }

  /**
   * Bound control writer for the ACTIVE session (or null when no stream is
   * up). The WS control route uses this with control.ts's sendControlEvent to
   * return the typed STREAM_OFF result when nothing is streaming (task 2.3).
   */
  controlWriter(): StreamControlWriter | null {
    const session = this.sessions[0];
    if (!session || !this.active) return null;
    return {
      video: { ...this._video },
      write: async (bytes: Buffer[]) => {
        for (const b of bytes) await session.sendControl(b);
      },
    };
  }

  /**
   * The ACTIVE adapter session (or null). The gateway uses it to attach
   * fanout viewers, await the handshake, and observe the video size.
   */
  activeSession(): AdapterSession | null {
    return this.active ? (this.sessions[0] ?? null) : null;
  }

  /** Design D6 snapshot for /v1/state and the WS state message. */
  snapshot(): StreamSnapshot {
    return {
      supported: this._enabled,
      active: this.active,
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
      viewers: this.viewerRefs,
    };
  }

  /** Force a watchdog poll now (tests drive this; prod runs the interval). */
  async poke(): Promise<void> {
    if (!this.active) return;
    // A poll failure (adb hiccup) counts as device loss — a stream whose
    // device cannot be confirmed MUST not keep running blind.
    let present = false;
    try {
      const devices = await this.pollDevices();
      present = devices.some((d) => d.serial === this.serial && d.state === "device");
    } catch {
      present = false;
    }
    if (!this.active) return;
    if (!present) {
      this.reason = "device_lost";
      await this.stopSession();
    }
  }

  /** Explicit start (used by hosts that pre-warm the stream). */
  async start(): Promise<void> {
    if (this.active) return;
    this.reason = undefined;
    await this.startSession();
  }

  /** Explicit stop (used by hosts that tear down out-of-band). */
  async stop(): Promise<void> {
    await this.stopSession();
  }

  private async startSession(): Promise<boolean> {
    if (this.active) return true;
    try {
      const session = await this.adapter.start(this.serial);
      this.sessions.push(session);
      this.active = true;
      this.reason = undefined;
      this.armWatchdog();
      this.eventHandler?.({ type: "started" });
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.eventHandler?.({ type: "error", message });
      return false;
    }
  }

  /** startSession, but only ever fires the lifecycle guard ONCE per refcount. */
  private async startedOnce(): Promise<void> {
    if (this.guarded) return;
    this.guarded = true;
    try {
      const ok = await this.startSession();
      if (!ok) {
        // A failed adapter.start MUST NOT wedge the manager: release the
        // guard so the next viewer subscribe can retry (D5 restart).
        this.guarded = false;
      }
    } finally {
      // Whether the attempt succeeded, failed, or the session was torn down
      // mid-flight, the guard is per-ATTEMPT: unarm it so the next subscribe
      // (or a restart after teardown) can always begin a fresh session.
      this.guarded = false;
    }
  }

  private async stopSession(): Promise<void> {
    if (this.active) {
      this.active = false;
      this.disarmWatchdog();
      const sessions = this.sessions;
      this.sessions = [];
      for (const s of sessions) s.close();
      this.eventHandler?.({ type: "stopped", reason: this.reason });
    }
    // A stopped session must never wedge a future start: clear any armed
    // start guard so the next subscribe can begin a fresh session.
    this.guarded = false;
  }

  private armWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      void this.poke();
    }, this.watchdogMs);
  }

  private disarmWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }
}

/** A viewer subscription token (opaque to the manager). */
export interface StreamViewerSubscription {
  id: string;
}

/** A control writer bound to the ACTIVE session (design D3, slice 2B). */
export interface StreamControlWriter {
  /** Current video size (0x0 before the handshake). */
  video: StreamVideoInfo;
  /** Write the encoded scrcpy control bytes into the session's CONNECT socket. */
  write(bytes: Buffer[]): Promise<void>;
}

/** Default watchdog source: live `adb devices -l`. */
async function defaultPollDevices(): Promise<Device[]> {
  // Lazy import keeps the manager dependency-light for tests and avoids a
  // hard import cycle with the device core.
  const { AdbWrapper } = await import("../device/adb");
  const { BunCommandRunner } = await import("../device/runner");
  return new AdbWrapper(new BunCommandRunner()).devices();
}

// ─── control-encoding delegation (task 2.3) ───────────────────────────────

import { encodeControlEvent } from "./control";

/**
 * Encode a typed control event into scrcpy control bytes. Delegates to the
 * control module (task 2.3), which owns validation + swipe stepping; the
 * manager only routes raw events to the active session's control socket.
 */
export { encodeControlEvent };