/**
 * StreamGateway — the bridge's stream subsystem (design D2/D3/D5).
 *
 * PR1 (native gRPC control): the in-guest encoder daemon transport is DELETED
 * and the emulator-native RTC session (RtcService v1) is not wired yet, so
 * video is UNSUPPORTED everywhere:
 *  - /v1/state reports `supported:false` with reason `rtc_streaming_not_deployed`
 *    (or `OPENMOBILE_STREAM=off` when the kill-switch is engaged),
 *  - WS /v1/stream/video rejects with close 4403 (never a silent hang),
 *  - WS /v1/stream/control rejects at upgrade (no active stream) — control
 *    flows via REST /v1/input (gRPC-first, adb fallback) instead,
 *  - `controlActive()` is always null until PR2 wires the gRPC injector
 *    into the session lifecycle.
 *
 * The StreamManager lifecycle skeleton (refcount, watchdog, kill-switch,
 * events) is KEPT for the PR2 RtcSession retarget (task 2.5): subscribeVideo
 * → requestRtcStream per viewer, last-viewer teardown, getStatus watchdog.
 */

import { StreamManager } from "./manager";
import type {
  StreamSubscribeResult,
  StreamStateView,
  StreamGateway as GatewayContract,
} from "../bridge/server";
import type { RtcClientMessage, StreamViewer } from "./types";
import type { ControlInjector } from "./control";

export interface StreamGatewayDeps {
  /** Target serial; retained for the PR2 RtcSession retarget. */
  serial: string;
  /** Kill-switch: `OPENMOBILE_STREAM=off` disables streaming (design D6). */
  enabled: boolean;
}

export class StreamGateway implements GatewayContract {
  /** Lifecycle skeleton — the PR2 RtcSession retarget plugs a real adapter in. */
  readonly managerRef: StreamManager;

  constructor(deps: StreamGatewayDeps) {
    this.managerRef = new StreamManager({
      adapter: {
        // PR1 has no transport: any start attempt fails closed (the gateway
        // short-circuits before reaching it — this is the safety net).
        start: async () => {
          throw new Error("rtc_streaming_not_deployed");
        },
        stop: async () => {},
      },
      serial: deps.serial,
      enabled: deps.enabled,
    });
  }

  snapshot(): StreamStateView {
    const enabled = this.managerRef.enabled;
    return {
      supported: false,
      active: false,
      ...(enabled ? { reason: "rtc_streaming_not_deployed" } : { reason: "OPENMOBILE_STREAM=off" }),
      viewers: 0,
    };
  }

  async subscribeVideo(_viewer: StreamViewer): Promise<StreamSubscribeResult> {
    return { ok: false, code: "UNSUPPORTED", reason: "rtc_streaming_not_deployed" };
  }

  unsubscribeVideo(_viewerId: string): void {
    // No viewers can attach while RTC video is undeployed (PR2 retargets this
    // onto the manager refcount).
  }

  relayViewerMessage(_viewerId: string, _msg: RtcClientMessage): boolean {
    // No session can exist while RTC video is undeployed: every frame is
    // answered with the DEVICE_LOST close by the bridge (never silently kept).
    return false;
  }

  controlActive(): ControlInjector | null {
    // Control requires an active stream; none can exist in PR1. REST
    // /v1/input (gRPC-first, adb fallback) is the control path meanwhile.
    return null;
  }
}
