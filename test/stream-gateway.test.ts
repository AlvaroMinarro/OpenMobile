import { describe, expect, it } from "bun:test";
import { StreamGateway } from "../src/stream/gateway";
import type { RtcServerMessage, StreamViewer } from "../src/stream/types";

/**
 * StreamGateway in PR1 (native gRPC control): the legacy daemon transport is
 * deleted and the emulator-native RTC session is not wired yet, so video is
 * UNSUPPORTED everywhere while the manager lifecycle skeleton stays intact
 * for the PR2 RtcSession retarget (task 2.5).
 */

class Recorder implements StreamViewer {
  open = true;
  closed = 0;
  messages: RtcServerMessage[] = [];
  private readonly _id: string;
  constructor(id: string) {
    this._id = id;
  }
  get id(): string {
    return this._id;
  }
  async sendMessage(msg: RtcServerMessage): Promise<void> {
    this.messages.push(msg);
  }
  close(): void {
    this.open = false;
    this.closed++;
  }
}

function makeGateway(overrides: { enabled?: boolean; serial?: string } = {}): StreamGateway {
  return new StreamGateway({
    serial: overrides.serial ?? "emulator-5554",
    enabled: overrides.enabled ?? true,
  });
}

describe("StreamGateway (PR1) — video unsupported until the RtcSession retarget", () => {
  it("reports supported:false with rtc_streaming_not_deployed in /v1/state (Unsupported environment)", async () => {
    const gw = makeGateway();
    const snap = gw.snapshot();
    expect(snap.supported).toBe(false);
    expect(snap.active).toBe(false);
    expect(snap.reason).toBe("rtc_streaming_not_deployed");
    expect(snap.viewers).toBe(0);
  });

  it("rejects every video viewer with UNSUPPORTED (never a silent hang or a session start)", async () => {
    const gw = makeGateway();
    const v = new Recorder("v1");
    const res = await gw.subscribeVideo(v);
    expect(res).toEqual({ ok: false, code: "UNSUPPORTED", reason: "rtc_streaming_not_deployed" });
    // The viewer socket was NOT closed by the gateway — the bridge owns the
    // reject path (4403) and the client is told, not hung.
    expect(v.closed).toBe(0);
    // No ghost refcount: the manager never saw a subscriber.
    expect(gw.managerRef.snapshot().viewers).toBe(0);
    expect(gw.managerRef.snapshot().active).toBe(false);
  });

  it("reports the kill-switch reason when OPENMOBILE_STREAM=off", () => {
    const gw = makeGateway({ enabled: false });
    const snap = gw.snapshot();
    expect(snap.supported).toBe(false);
    expect(snap.reason).toBe("OPENMOBILE_STREAM=off");
  });

  it("has no active control injector — control goes through REST /v1/input", async () => {
    const gw = makeGateway();
    expect(gw.controlActive()).toBeNull();
    // Unsubscribe is a safe no-op while no viewer can attach.
    gw.unsubscribeVideo("ghost");
    expect(gw.managerRef.snapshot().viewers).toBe(0);
  });
});
