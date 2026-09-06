/**
 * StreamGateway — the bridge's stream subsystem (design D2/D3/D5, task 2.5).
 *
 * PR2: the lifecycle skeleton (StreamManager: first-viewer start, last-viewer
 * teardown, kill-switch, events) is RETARGETED onto a real RtcSession over
 * the RtcService v1 adapter. The gateway owns:
 *  - capability resolution (pid-ini endpoint + version gate, wired from
 *    main.ts) — the kill-switch and the external-launch degradation live
 *    here, surfaced additively as `stream.rtc{…}` in /v1/state,
 *  - per-viewer subscribe/unsubscribe (the manager refcounts; each viewer
 *    gets its own RtcId inside the ONE RtcSession),
 *  - the getStatus watchdog chain: session loss → manager.forceStop →
 *    teardown → every viewer socket closed with 4409 by the bridge,
 *  - client JSEP frame routing (answer/ice/state) into the viewer's stream,
 *  - the control injector: grpcControlInjector over the stream's serial, so
 *    WS /v1/stream/control works exactly while a stream is active (control
 *    itself is independent of video — REST /v1/input stays gRPC-first).
 *
 * The manager does NOT know about WebSockets: routing a viewer to its socket
 * is the bridge's job.
 */

import { grpcControlInjector, type ControlInjector } from "./control";
import { Fanout } from "./fanout";
import { StreamManager, type StreamViewerSubscription } from "./manager";
import { RtcSession, type RtcSessionErrorCode } from "./rtc/session";
import type { RtcAdapter } from "./rtc/adapter";
import type { Device } from "../device/types";
import type { EmulatorControl } from "../device/grpc";
import type {
  RtcClientMessage,
  RtcStateView,
  StreamViewer,
} from "./types";
import { MAX_VIEWERS } from "./types";
import type {
  StreamSubscribeResult,
  StreamStateView,
  StreamGateway as GatewayContract,
} from "../bridge/server";

/** Resolved RTC capability for one serial (pid-ini endpoint + version gate). */
export interface RtcCapability {
  supported: boolean;
  reason?: string;
  /** Loopback endpoint when supported (addr "host:port" + Bearer token). */
  endpoint?: { addr: string; token: string };
}

export interface StreamGatewayDeps {
  /** Target serial; "auto" resolves through pollDevices at subscribe time. */
  serial: string;
  /** Kill-switch: `OPENMOBILE_STREAM=off` disables streaming (design D6). */
  enabled: boolean;
  /** Configured -rtcfps value (handshake + /v1/state stream.rtc.fps). */
  fps: number;
  /** Handshake codecs. Default ["VP8"] (mandatory). */
  codecs?: string[];
  /** Resolve the RTC capability for a serial (pid-ini + version gate). */
  resolveCapability?: (serial: string) => RtcCapability | null;
  /** Build the RtcSession for an endpoint (wires the gRPC adapter + probe). */
  createSession?: (endpoint: { addr: string; token: string }, serial: string) => RtcSession;
  /** Resolve the gRPC control surface for the active stream's serial. */
  controlFor?: (serial: string) => Promise<EmulatorControl | null>;
  /** Device source for "auto" resolution + the manager's adb watchdog. */
  pollDevices?: () => Promise<Device[]>;
  /** Watchdog poll interval ms for the manager's adb watchdog. Default 3000. */
  watchdogMs?: number;
}

export class StreamGateway implements GatewayContract {
  /** Lifecycle skeleton — now driving a REAL RtcSession (task 2.5). */
  readonly managerRef: StreamManager;
  private readonly deps: StreamGatewayDeps;
  private readonly fanout = new Fanout();
  private session: RtcSession | undefined;
  private sessionCreation: Promise<RtcSession> | undefined;
  private injector: ControlInjector | undefined;
  private viewerSubs = new Map<string, StreamViewerSubscription>();
  private capability: RtcCapability | undefined;
  private capabilitySerial: string | undefined;

  constructor(deps: StreamGatewayDeps) {
    this.deps = deps;
    this.managerRef = new StreamManager({
      adapter: {
        start: async (serial) => this.adapterStart(serial),
        stop: async () => {},
      },
      serial: deps.serial,
      enabled: deps.enabled,
      ...(deps.pollDevices !== undefined ? { pollDevices: deps.pollDevices } : {}),
      ...(deps.watchdogMs !== undefined ? { watchdogMs: deps.watchdogMs } : {}),
    });
    // Teardown (last viewer / loss / failed start): close every viewer socket
    // (the bridge maps that onto 4409) and drop the cached session.
    this.managerRef.onEvent((e) => {
      if (e.type === "stopped") {
        this.fanout.closeAll();
        this.session = undefined;
        this.sessionCreation = undefined;
        this.injector = undefined;
      }
    });
  }

  snapshot(): StreamStateView {
    const mgr = this.managerRef.snapshot();
    if (!mgr.supported) {
      const reason = mgr.reason ?? "OPENMOBILE_STREAM=off";
      return {
        supported: false,
        active: false,
        reason,
        viewers: 0,
        rtc: { supported: false, active: false, viewers: 0, reason },
      };
    }
    const cap = this.currentCapability();
    const active = mgr.active && cap.supported;
    const reason = mgr.reason ?? (cap.supported ? undefined : cap.reason);
    const rtc: RtcStateView = {
      supported: cap.supported,
      active,
      viewers: mgr.viewers,
      ...(active && this.session?.guid !== undefined ? { guid: this.session.guid } : {}),
      ...(cap.supported ? { fps: this.deps.fps } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
    return {
      supported: cap.supported,
      active,
      ...(reason !== undefined ? { reason } : {}),
      viewers: mgr.viewers,
      rtc,
    };
  }

  async subscribeVideo(viewer: StreamViewer): Promise<StreamSubscribeResult> {
    if (!this.managerRef.enabled) {
      return { ok: false, code: "UNSUPPORTED", reason: "OPENMOBILE_STREAM=off" };
    }
    if (this.fanout.count >= MAX_VIEWERS) {
      return { ok: false, code: "CAP_REACHED", reason: `viewer cap reached (${MAX_VIEWERS})` };
    }
    const serial = await this.resolveTarget();
    if (!serial) {
      return { ok: false, code: "NO_DEVICE", reason: "no emulator attached" };
    }
    this.managerRef.updateTargetSerial(serial);
    // Fresh resolve per subscribe: the emulator (and its pid ini) may have
    // appeared since the last look.
    const cap = (this.capability =
      this.deps.resolveCapability?.(serial) ?? { supported: false, reason: "grpc_permission_denied" });
    this.capabilitySerial = serial;
    if (!cap.supported) {
      return { ok: false, code: "UNSUPPORTED", reason: cap.reason ?? "rtc unavailable" };
    }
    const sub = this.managerRef.subscribe();
    if (!sub) {
      return { ok: false, code: "UNSUPPORTED", reason: "OPENMOBILE_STREAM=off" };
    }
    this.viewerSubs.set(viewer.id, sub);
    try {
      const session = await this.ensureSession();
      await session.attach(viewer);
    } catch (e) {
      // Fail closed: release the refcount (a first-viewer failure tears the
      // session down) and map the error onto the spec close codes.
      this.viewerSubs.delete(viewer.id);
      this.managerRef.unsubscribe(sub);
      return this.mapSubscribeFailure(e);
    }
    if (!viewer.open) {
      // The socket died while attach was in flight (connect-close race):
      // release everything, the close handler already ran.
      this.releaseViewer(viewer.id);
      return { ok: false, code: "NO_DEVICE", reason: "viewer closed during subscribe" };
    }
    if (!this.fanout.add(viewer)) {
      this.releaseViewer(viewer.id);
      return { ok: false, code: "CAP_REACHED", reason: `viewer cap reached (${MAX_VIEWERS})` };
    }
    return { ok: true, viewerId: viewer.id };
  }

  unsubscribeVideo(viewerId: string): void {
    this.releaseViewer(viewerId);
  }

  relayViewerMessage(viewerId: string, msg: RtcClientMessage): boolean {
    const session = this.session;
    if (!session || !session.has(viewerId)) return false;
    switch (msg.type) {
      case "answer":
        void session.relayAnswer(viewerId, msg.sdp);
        break;
      case "ice":
        void session.relayIce(viewerId, msg.candidate);
        break;
      case "state":
        session.noteStreaming(viewerId);
        break;
    }
    return true;
  }

  controlActive(): ControlInjector | null {
    return this.injector ?? null;
  }

  // ─── internals ──────────────────────────────────────────────────────────

  /** The manager's adapter start: build (once) the RtcSession + injector. */
  private async adapterStart(serial: string): Promise<RtcSession> {
    const session = await this.ensureSession();
    void serial;
    return session;
  }

  /**
   * ONE shared creation promise per session lifetime: the manager's
   * (fire-and-forget) start and the gateway's awaited subscribe both funnel
   * through it, so concurrent starts can never build two sessions.
   */
  private ensureSession(): Promise<RtcSession> {
    if (this.session) return Promise.resolve(this.session);
    if (!this.sessionCreation) {
      this.sessionCreation = this.createSessionNow().then(
        (s) => s,
        (e: unknown) => {
          this.sessionCreation = undefined; // allow the next viewer to retry
          throw e;
        },
      );
    }
    return this.sessionCreation;
  }

  private async createSessionNow(): Promise<RtcSession> {
    const cap = this.capability;
    if (!cap?.supported || !cap.endpoint) {
      throw new Error(cap?.reason ?? "rtc unavailable");
    }
    const create = this.deps.createSession;
    if (!create) throw new Error("rtc session factory not wired");
    const session = create(cap.endpoint, this.managerRef.targetSerial);
    // Loss chain (task 2.3): session watchdog → manager forceStop →
    // teardown event → fanout.closeAll → bridge closes every socket 4409.
    session.onLoss(() => void this.managerRef.forceStop("device_lost"));
    this.session = session;
    const controlFor = this.deps.controlFor;
    if (controlFor) {
      const control = await controlFor(this.managerRef.targetSerial);
      this.injector = control ? grpcControlInjector(control) : undefined;
    }
    return session;
  }

  /** Resolve the target serial ("auto" → the single attached emulator). */
  private async resolveTarget(): Promise<string | null> {
    const configured = this.managerRef.targetSerial;
    if (configured && configured !== "auto") return configured;
    let devices: Device[];
    try {
      devices = this.deps.pollDevices ? await this.deps.pollDevices() : await defaultPollDevices();
    } catch {
      return null;
    }
    const emulators = devices.filter((d) => d.serial.startsWith("emulator-") && d.state === "device");
    if (emulators.length !== 1) return null;
    const serial = emulators[0]!.serial;
    this.managerRef.updateTargetSerial(serial);
    return serial;
  }

  /** Capability for the CURRENT serial (cached per serial; sync). */
  private currentCapability(): RtcCapability {
    const serial = this.managerRef.targetSerial;
    if (this.capability && this.capabilitySerial === serial) return this.capability;
    if (!serial || serial === "auto") return { supported: false, reason: "no_device_selected" };
    const cap =
      this.deps.resolveCapability?.(serial) ?? { supported: false, reason: "grpc_permission_denied" };
    this.capability = cap;
    this.capabilitySerial = serial;
    return cap;
  }

  /** Release one viewer: fanout + session detach + manager refcount. */
  private releaseViewer(viewerId: string): void {
    this.fanout.remove(viewerId);
    this.session?.detach(viewerId);
    const sub = this.viewerSubs.get(viewerId);
    if (sub) {
      this.viewerSubs.delete(viewerId);
      this.managerRef.unsubscribe(sub);
    }
  }

  /** Map a failed subscribe onto the spec close-code semantics. */
  private mapSubscribeFailure(e: unknown): StreamSubscribeResult {
    const err = e as { code?: RtcSessionErrorCode | string; message?: string; wsCloseCode?: number };
    if (err?.code === "PERMISSION_DENIED") {
      return { ok: false, code: "PERMISSION_DENIED", reason: err.message };
    }
    return {
      ok: false,
      code: "NO_DEVICE",
      reason: err?.message ?? "the rtc stream failed to start",
    };
  }
}

/** Default "auto" resolution source: live `adb devices -l`. */
async function defaultPollDevices(): Promise<Device[]> {
  // Lazy import keeps the gateway dependency-light for tests and avoids a
  // hard import cycle with the device core.
  const { AdbWrapper } = await import("../device/adb");
  const { BunCommandRunner } = await import("../device/runner");
  return new AdbWrapper(new BunCommandRunner()).devices();
}
