/**
 * StreamGateway — the bridge's stream subsystem (design D2/D3/D5, slice 2B).
 *
 * Glues the StreamManager (lifecycle, slice 2A) to the StreamSession daemon
 * (raw sockets, slice 2B) and exposes the narrow contract the WS routes in
 * server.ts consume:
 *  - subscribeVideo(viewer): subscribe a WS viewer. On the FIRST viewer the
 *    gateway starts the manager (push→reverse→spawn→read-loop); the daemon's
 *    fan-out broadcasts AUs into the socket-facing viewer, and the handshake
 *    is delivered once the CONFIG frame lands. Returns UNSUPPORTED when the
 *    manager is disabled, NO_DEVICE when the session failed to start, or
 *    CAP_REACHED at 8 viewers (design D4).
 *  - unsubscribeVideo(viewerId): remove the viewer (last one tears the
 *    session down via the manager's refcount).
 *  - controlActive(): the ACTIVE session's control writer for /v1/stream/control.
 *  - snapshot(): additive /v1/state stream object (supported/active/viewers).
 *
 * The manager's device-loss watchdog closes the session → the fanout
 * closeAll() closes every socket-facing viewer → the bridge translates that
 * into a 4409 close + state message (spec: Device lost mid-stream).
 */

import { StreamManager, type StreamVideoInfo } from "./manager";
import { StreamSession } from "./daemon";
import type { CommandRunner } from "../device/runner";
import type {
  StreamSubscribeResult,
  StreamStateView,
  StreamGateway as GatewayContract,
} from "../bridge/server";
import type { StreamViewer } from "./types";
import { MAX_VIEWERS } from "./types";

export interface StreamGatewayDeps {
  runner: CommandRunner;
  /** Target serial; `"auto"` = resolve the single attached device on first start. */
  serial: string;
  /** Kill-switch: `OPENMOBILE_STREAM=off` disables streaming (design D6). */
  enabled: boolean;
  /** Watchdog source (defaults to live `adb devices -l`). */
  pollDevices?: () => Promise<import("../device/types").Device[]>;
  /** Fixed session id (tests); default: fresh random scid per start. */
  scid?: string;
}

/** Fresh scid per stream start: signed 32-bit hex (design §Live-validated facts). */
function freshScid(): string {
  const raw = new Uint32Array(1);
  crypto.getRandomValues(raw);
  return (raw[0]! & 0x7fffffff).toString(16);
}

export class StreamGateway implements GatewayContract {
  private readonly manager: StreamManager;
  private readonly sessionFactory: (scid: string) => StreamSession;
  private session: StreamSession | null = null;
  /** id → socket-facing viewer registered through subscribeVideo. */
  private viewers = new Map<string, StreamViewer>();
  private videoInfo: StreamVideoInfo = { width: 0, height: 0 };
  private readonly fixedScid: string | undefined;
  private readonly runner: CommandRunner;
  private resolvedSerial: string | null = null;

  constructor(deps: StreamGatewayDeps, sessionFactory?: (scid: string) => StreamSession) {
    this.fixedScid = deps.scid;
    this.runner = deps.runner;
    this.adapterSerial = deps.serial;
    this.sessionFactory =
      sessionFactory ??
      ((scid) =>
        new StreamSession({
          runner: deps.runner,
          serial: this.serialForStream(),
          scid,
        }));
    this.manager = new StreamManager({
      adapter: {
        start: async (serial) => {
          // Resolve "auto" to the single attached device ONCE (adb devices).
          if (this.adapterSerial === "auto" && !this.resolvedSerial) {
            this.resolvedSerial = await this.resolveAutoSerial();
          }
          const target = this.serialForStream();
          // One StreamSession per stream start; re-push+spawn every time
          // (the server self-deletes the jar — design §Live-validated facts).
          this.session = this.sessionFactory(this.fixedScid ?? freshScid());
          try {
            await this.session.start();
          } catch (e) {
            this.session = null;
            throw e;
          }
          // Surface the video size once the handshake arrives so /v1/state
          // and the control encoder see the real dimensions.
          void this.session.handshakeReady.then((hs) => {
            this.videoInfo = { width: hs.width, height: hs.height };
          }).catch(() => {});
          this.session.onLoss(() => {
            // The manager's watchdog polls adb; the session's socket-close
            // path also fires loss. Either way the manager tears down, which
            // closes the fanout + viewers (bridge → 4409).
          });
          void serial;
          void target;
          return this.session;
        },
        stop: async () => {
          this.session?.close();
          this.session = null;
        },
      },
      serial: deps.serial,
      enabled: deps.enabled,
      pollDevices: deps.pollDevices,
      video: this.videoInfo,
    });
    // Keep the manager's snapshot video size live: it starts 0x0 and updates
    // from the session handshake (the manager reads AdapterSession.video).
  }

  private adapterSerial: string;

  /** The serial the sessions actually use ("auto" → resolved). */
  private serialForStream(): string {
    if (this.adapterSerial !== "auto") return this.adapterSerial;
    return this.resolvedSerial ?? "auto";
  }

  /** Auto-detect: the single `device`-state serial (mirrors REST resolveSerial). */
  private async resolveAutoSerial(): Promise<string> {
    const devices = await this.runner.run(["adb", "devices", "-l"]);
    const lines = (devices.stdout ?? "").split("\n").slice(1);
    const attached = lines
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length >= 2 && p[1] === "device")
      .map((p) => p[0]!);
    if (attached.length === 0) {
      throw new Error("no Android device attached for streaming");
    }
    if (attached.length > 1) {
      throw new Error(`multiple devices attached; set ANDROID_DEVICE (${attached.join(", ")})`);
    }
    return attached[0]!;
  }

  snapshot(): StreamStateView {
    const s = this.manager.snapshot();
    const v = this.manager.activeSession()?.video ?? this.videoInfo;
    return {
      supported: s.supported,
      active: s.active,
      ...(s.reason !== undefined ? { reason: s.reason } : {}),
      viewers: s.viewers,
      ...(v.width > 0 ? { width: v.width, height: v.height } : {}),
    };
  }

  get managerRef(): StreamManager {
    return this.manager;
  }

  /** Attached fanout viewer count (test/observability hook for the bridge). */
  get attachedViewers(): number {
    return this.session?.fanout.count ?? 0;
  }

  async subscribeVideo(viewer: StreamViewer): Promise<StreamSubscribeResult> {
    if (!this.manager.enabled) {
      return { ok: false, code: "UNSUPPORTED", reason: "OPENMOBILE_STREAM=off" };
    }
    if (this.viewers.size >= MAX_VIEWERS) {
      return { ok: false, code: "CAP_REACHED", reason: "viewer cap reached (8)" };
    }
    // Resolve "auto" to the real serial BEFORE the manager starts — the
    // manager's device-loss watchdog matches ITS serial against adb devices,
    // so it must see the actual serial, never "auto".
    if (this.adapterSerial === "auto" && !this.resolvedSerial) {
      try {
        this.resolvedSerial = await this.resolveAutoSerial();
        this.manager.updateTargetSerial(this.resolvedSerial);
      } catch (e) {
        return {
          ok: false,
          code: "NO_DEVICE",
          reason: e instanceof Error ? e.message : "no usable device for streaming",
        };
      }
    }
    // Connect race: the WS may have closed while we were resolving the serial
    // (tab reload / rapid connect-close). A dead viewer must NEVER be
    // registered — it would hold a manager refcount + a viewer-cap slot and
    // the session would run forever (the bridge close handler can only
    // unsubscribe a viewer it knows about).
    if (!viewer.open) {
      return { ok: false, code: "NO_DEVICE", reason: "viewer closed before subscription completed" };
    }
    const subscription = this.manager.subscribe();
    if (!subscription) {
      return { ok: false, code: "UNSUPPORTED", reason: "OPENMOBILE_STREAM=off" };
    }
    this.viewers.set(viewer.id, viewer);
    // Attach the socket-facing viewer to the session's fanout. The session
    // may not exist yet (first viewer starts it async); the manager's
    // start-on-first-viewer path creates it, and the fanout is only reachable
    // once the adapter.start resolves.
    void this.attachToSession(viewer, subscription.id);
    return { ok: true, viewerId: viewer.id };
  }

  unsubscribeVideo(viewerId: string): void {
    const viewer = this.viewers.get(viewerId);
    if (!viewer) return;
    this.viewers.delete(viewerId);
    this.session?.fanout.remove(viewer.id);
    // The manager refcounts viewers; last unsubscribe tears the session down.
    const subscription = { id: viewerId };
    this.manager.unsubscribe(subscription);
  }

  controlActive(): { video: { width: number; height: number }; write: (bytes: Buffer[]) => Promise<void> } | null {
    const session = this.manager.activeSession();
    if (!session || !this.manager.snapshot().active) return null;
    const video = this.videoInfo.width > 0 ? this.videoInfo : { width: 0, height: 0 };
    return {
      video,
      write: async (bytes: Buffer[]) => {
        for (const b of bytes) await session.sendControl(b);
      },
    };
  }

  /** Attach the viewer once the session is up; deliver the handshake first. */
  private async attachToSession(viewer: StreamViewer, subscriptionId: string): Promise<void> {
    // Wait for an active session (first viewer starts it). Retry a few times
    // in case adapter.start is still in flight; fall back gracefully.
    for (let i = 0; i < 40 && !this.manager.activeSession(); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const session = this.manager.activeSession();
    if (!session) {
      // Start failed (push/reverse/spawn): reject the viewer.
      viewer.close();
      return;
    }
    // Connect race: the viewer's WS may have closed while the session was
    // starting (attachToSession polls up to 1s). Re-check liveness right
    // before attaching, or the unsubscribe that already removed the viewer
    // would be undone — a ghost re-attached to the fanout forever.
    if (!viewer.open) return;
    const fanout = session.fanout ?? undefined;
    if (fanout) {
      if (!fanout.add(viewer)) {
        // Cap raced — close the viewer (bridge → 4429).
        viewer.close();
        return;
      }
    }
    void subscriptionId;
    // Handshake: deliver once available. If the session dies before the
    // handshake, the fanout closeAll (on teardown) closes the viewer anyway.
    if (session.handshakeReady) {
      session.handshakeReady.then((hs) => viewer.sendHandshake(hs)).catch(() => {});
    }
  }
}