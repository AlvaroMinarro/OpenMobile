/**
 * StreamManager — stream lifecycle controller (design D5, D6).
 *
 * UI-agnostic session lifecycle skeleton:
 *  - START on the first viewer subscribing,
 *  - TEARDOWN when the last viewer unsubscribes,
 *  - device-loss watchdog: while active, poll `adb devices -l`; when the
 *    stream's serial disappears, tear the session down and report
 *    `reason: "device_lost"` (spec: Device lost mid-stream, Restart after
 *    disconnect — re-subscribing restarts a fresh session).
 *
 * PR1 (native gRPC control, legacy encoder deleted): the in-guest transport
 * is GONE and the emulator-native RTC session (RtcService v1) is not wired
 * yet, so no adapter session ever starts. The lifecycle skeleton (refcount,
 * watchdog, kill-switch, events) is KEPT — the PR2 RtcSession retarget plugs
 * a real adapter back in (task 2.5). The manager does NOT know about
 * WebSockets: routing a viewer/subscription to a socket is the bridge's job.
 */

import type { Device } from "../device/types";

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

/** A live streaming session handed to the manager by the adapter (PR2: RtcSession). */
export interface AdapterSession {
  serial: string;
  /** Register the device-loss callback (fires when the device vanishes). */
  onLoss(cb: (() => void) | undefined): void;
  /** Full teardown. */
  close(): void;
}

/** Dependency surface StreamManager needs from the streaming adapter. */
export interface AdapterDeps {
  /** Produce a NEW session bound to the adapter's device. */
  start(serial: string): Promise<AdapterSession>;
  /** General adapter teardown (running sessions may self-manage). */
  stop(): Promise<void>;
}

export interface StreamManagerOptions {
  /** The streaming adapter (PR2: RtcSession wiring; tests: double). */
  adapter: AdapterDeps;
  /** Device the manager streams (serial that must stay in `adb devices`). */
  serial: string;
  /** False when OPENMOBILE_STREAM=off (design D6 kill-switch). Default true. */
  enabled?: boolean;
  /** Watchdog source; defaults to a real `adb devices -l` read. */
  pollDevices?: () => Promise<Device[]>;
  /** Watchdog poll interval ms. Default 3000. */
  watchdogMs?: number;
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

  /**
   * Design D6 snapshot for /v1/state and the WS state message. Support is
   * enabled-driven at this layer; transport capability (RTC availability) is
   * reported by the gateway above it.
   */
  snapshot(): StreamSnapshot {
    const supported = this._enabled;
    const reason = this.reason ?? (this._enabled ? undefined : "OPENMOBILE_STREAM=off");
    return {
      supported,
      active: this.active,
      ...(reason !== undefined ? { reason } : {}),
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

/** Default watchdog source: live `adb devices -l`. */
async function defaultPollDevices(): Promise<Device[]> {
  // Lazy import keeps the manager dependency-light for tests and avoids a
  // hard import cycle with the device core.
  const { AdbWrapper } = await import("../device/adb");
  const { BunCommandRunner } = await import("../device/runner");
  return new AdbWrapper(new BunCommandRunner()).devices();
}
