import { describe, expect, it } from "bun:test";
import { GrpcControlError } from "../src/device/grpc";
import { StreamGateway, type RtcCapability, type StreamGatewayDeps } from "../src/stream/gateway";
import { RtcSession } from "../src/stream/rtc/session";
import type { RtcServerMessage, StreamViewer } from "../src/stream/types";
import type { Device } from "../src/device/types";
import { FakeRtcAdapter } from "./helpers/fake-rtc-adapter";

/**
 * StreamGateway — the PR2 RtcSession retarget (task 2.5). The gateway binds
 * the lifecycle skeleton (StreamManager: first-viewer start / last-viewer
 * teardown / kill-switch / events) onto a REAL RtcSession, resolves the
 * serial + RTC capability, routes client JSEP frames, and exposes the
 * control injector. All doubles are in-memory — the REAL adapter/session
 * conformance is pinned in stream-rtc-adapter / stream-rtc-session tests and
 * the full stack in stream-rtc-integration.test.ts.
 */

class RecordingViewer implements StreamViewer {
  readonly id: string;
  messages: RtcServerMessage[] = [];
  open = true;
  closeCount = 0;

  constructor(id: string) {
    this.id = id;
  }
  async sendMessage(msg: RtcServerMessage): Promise<void> {
    this.messages.push(msg);
  }
  close(): void {
    this.open = false;
    this.closeCount += 1;
  }
}

interface GatewayHarness {
  gateway: StreamGateway;
  adapter: FakeRtcAdapter;
  capabilities: Map<string, RtcCapability>;
  controls: Map<string, unknown>;
  injections: string[];
  losses: number;
}

const OK_CAP: RtcCapability = { supported: true, endpoint: { addr: "localhost:8554", token: "tok" } };

function makeGateway(
  overrides: Partial<StreamGatewayDeps> & { probe?: () => Promise<void> } = {},
): GatewayHarness {
  const adapter = new FakeRtcAdapter();
  const capabilities = new Map<string, RtcCapability>([["emulator-5554", OK_CAP]]);
  const controls = new Map<string, unknown>();
  const injections: string[] = [];
  const harness: GatewayHarness = {
    adapter,
    capabilities,
    controls,
    injections,
    losses: 0,
    gateway: null as unknown as StreamGateway,
  };
  const gateway = new StreamGateway({
    serial: overrides.serial ?? "emulator-5554",
    enabled: overrides.enabled ?? true,
    fps: overrides.fps ?? 60,
    resolveCapability: (serial) => capabilities.get(serial) ?? { supported: false, reason: "grpc_permission_denied" },
    createSession: (endpoint, serial) => {
      void endpoint;
      return new RtcSession({
        serial,
        adapter,
        fps: overrides.fps ?? 60,
        ...(overrides.watchdogMs !== undefined ? { watchdogMs: overrides.watchdogMs } : {}),
        ...(overrides.probe !== undefined ? { probe: overrides.probe } : {}),
        onLoss: () => void harness.gateway.managerRef.forceStop("device_lost"),
      });
    },
    controlFor: async (serial) => (controls.get(serial) as never) ?? null,
    // DEFAULT: the manager's adb watchdog sees the serial PRESENT — without
    // this every gateway test arms a REAL `adb devices` watchdog that (with
    // no emulator attached) fires a spurious device_lost ~3s later, racing
    // the session watchdog under file-parallel test load.
    pollDevices: async () => [{ serial: "emulator-5554", state: "device" }] as Device[],
    ...(overrides.pollDevices !== undefined ? { pollDevices: overrides.pollDevices } : {}),
    ...(overrides.resolveCapability !== undefined ? { resolveCapability: overrides.resolveCapability } : {}),
    ...(overrides.createSession !== undefined ? { createSession: overrides.createSession } : {}),
    ...overrides,
  });
  harness.gateway = gateway;
  return harness;
}

const flush = async (turns = 4): Promise<void> => {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("StreamGateway snapshot — capability + additive stream.rtc (task 2.7)", () => {
  it("reports supported with an endpoint-capable emulator and the rtc sub-object", () => {
    const { gateway } = makeGateway();
    const snap = gateway.snapshot();
    expect(snap.supported).toBe(true);
    expect(snap.active).toBe(false);
    expect(snap.viewers).toBe(0);
    expect(snap.rtc).toEqual({ supported: true, active: false, viewers: 0, fps: 60 });
  });

  it("reports supported:false + grpc_permission_denied for an externally launched emulator", () => {
    const { gateway } = makeGateway({
      resolveCapability: () => ({ supported: false, reason: "grpc_permission_denied" }),
    });
    const snap = gateway.snapshot();
    expect(snap.supported).toBe(false);
    expect(snap.rtc?.reason).toBe("grpc_permission_denied");
  });

  it("reports the version-gate reason naming the requirement (Version gate scenario)", () => {
    const { gateway } = makeGateway({
      resolveCapability: () => ({
        supported: false,
        reason: "emulator 36.4.0 lacks native RTC (requires >= 36.5.11; upgrade the Android emulator)",
      }),
    });
    const snap = gateway.snapshot();
    expect(snap.supported).toBe(false);
    expect(snap.rtc?.reason).toContain("36.5.11");
  });

  it("reports the kill-switch on both levels when OPENMOBILE_STREAM=off", () => {
    const { gateway } = makeGateway({ enabled: false });
    const snap = gateway.snapshot();
    expect(snap.supported).toBe(false);
    expect(snap.reason).toBe("OPENMOBILE_STREAM=off");
    expect(snap.rtc?.reason).toBe("OPENMOBILE_STREAM=off");
  });

  it("reports the active guid + viewers while a stream runs (FPS reported scenario)", async () => {
    const { gateway } = makeGateway();
    const v = new RecordingViewer("v1");
    const res = await gateway.subscribeVideo(v);
    expect(res.ok).toBe(true);
    await flush();
    const snap = gateway.snapshot();
    expect(snap.active).toBe(true);
    expect(snap.viewers).toBe(1);
    expect(snap.rtc?.active).toBe(true);
    expect(snap.rtc?.guid).toBe("guid-1");
    expect(snap.rtc?.fps).toBe(60);
    gateway.unsubscribeVideo("v1");
  });

  it("auto serial with no resolution yet reports no_device_selected (never a fake capability)", () => {
    const { gateway } = makeGateway({ serial: "auto" });
    const snap = gateway.snapshot();
    expect(snap.supported).toBe(false);
    expect(snap.rtc?.reason).toBe("no_device_selected");
  });
});

describe("StreamGateway.subscribeVideo — RtcSession lifecycle (First/Last viewer scenarios)", () => {
  it("first viewer: capability gate → session attach → handshake is the FIRST frame", async () => {
    const { gateway, adapter } = makeGateway();
    const v = new RecordingViewer("v1");
    const res = await gateway.subscribeVideo(v);
    expect(res).toEqual({ ok: true, viewerId: "v1" });
    await flush();
    expect(adapter.started).toBe(1);
    expect(v.messages[0]).toEqual({ type: "handshake", rtcId: "guid-1", fps: 60, codecs: ["VP8"] });
    gateway.unsubscribeVideo("v1");
  });

  it("auto serial resolves through the device poll (single attached emulator)", async () => {
    const { gateway, adapter } = makeGateway({
      serial: "auto",
      pollDevices: async () =>
        [{ serial: "emulator-5554", state: "device" }] as Device[],
    });
    const v = new RecordingViewer("v1");
    const res = await gateway.subscribeVideo(v);
    expect(res.ok).toBe(true);
    await flush();
    expect(adapter.started).toBe(1);
    gateway.unsubscribeVideo("v1");
  });

  it("auto serial with no emulator attached → NO_DEVICE (never a hang)", async () => {
    const { gateway } = makeGateway({
      serial: "auto",
      pollDevices: async () => [],
    });
    const res = await gateway.subscribeVideo(new RecordingViewer("v1"));
    expect(res).toEqual({ ok: false, code: "NO_DEVICE", reason: "no emulator attached" });
  });

  it("second viewer shares the session (no second adapter start) with its OWN guid", async () => {
    const { gateway, adapter } = makeGateway();
    const a = new RecordingViewer("a");
    const b = new RecordingViewer("b");
    await gateway.subscribeVideo(a);
    await gateway.subscribeVideo(b);
    await flush();
    expect(adapter.started).toBe(2); // per-viewer streams…
    expect(gateway.snapshot().viewers).toBe(2); // …one manager session
    const aHand = a.messages[0] as { rtcId: string };
    const bHand = b.messages[0] as { rtcId: string };
    expect(aHand.rtcId).toBe("guid-1");
    expect(bHand.rtcId).toBe("guid-2");
    gateway.unsubscribeVideo("a");
    gateway.unsubscribeVideo("b");
  });

  it("rejects a 9th viewer with CAP_REACHED and keeps the 8 running (Stream cap scenario)", async () => {
    const { gateway, adapter } = makeGateway();
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const v = new RecordingViewer(`v${i}`);
      const res = await gateway.subscribeVideo(v);
      expect(res.ok).toBe(true);
      ids.push(v.id);
    }
    const ninth = new RecordingViewer("ninth");
    const res = await gateway.subscribeVideo(ninth);
    expect(res).toEqual({ ok: false, code: "CAP_REACHED", reason: "viewer cap reached (8)" });
    expect(adapter.started).toBe(8); // no stream for the rejected viewer
    expect(ninth.closeCount).toBe(0); // the bridge owns the 4429 close
    for (const id of ids) gateway.unsubscribeVideo(id);
  });

  it("maps PERMISSION_DENIED at start onto code PERMISSION_DENIED (4401)", async () => {
    const { gateway, adapter } = makeGateway();
    adapter.failStart = new GrpcControlError("PERMISSION_DENIED", "denied", undefined, 4401);
    const res = await gateway.subscribeVideo(new RecordingViewer("v1"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("PERMISSION_DENIED");
  });

  it("maps DEVICE_OFFLINE at start onto NO_DEVICE (4404, RtcStream cannot start)", async () => {
    const { gateway, adapter } = makeGateway();
    adapter.failStart = new GrpcControlError("DEVICE_OFFLINE", "unreachable");
    const res = await gateway.subscribeVideo(new RecordingViewer("v1"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("NO_DEVICE");
  });

  it("kill-switch off rejects with UNSUPPORTED naming the env knob", async () => {
    const { gateway } = makeGateway({ enabled: false });
    const res = await gateway.subscribeVideo(new RecordingViewer("v1"));
    expect(res).toEqual({ ok: false, code: "UNSUPPORTED", reason: "OPENMOBILE_STREAM=off" });
  });

  it("capability gate (external launch) rejects with UNSUPPORTED + permission reason", async () => {
    const { gateway } = makeGateway({
      resolveCapability: () => ({ supported: false, reason: "grpc_permission_denied" }),
    });
    const res = await gateway.subscribeVideo(new RecordingViewer("v1"));
    expect(res).toEqual({ ok: false, code: "UNSUPPORTED", reason: "grpc_permission_denied" });
  });

  it("last viewer unsubscribe tears the session down: bye for every stream + adapter stop", async () => {
    const { gateway, adapter } = makeGateway();
    const a = new RecordingViewer("a");
    const b = new RecordingViewer("b");
    await gateway.subscribeVideo(a);
    await gateway.subscribeVideo(b);
    gateway.unsubscribeVideo("a");
    await flush();
    expect(adapter.sendsFor("guid-1")).toEqual([{ bye: true }]);
    expect(gateway.snapshot().viewers).toBe(1); // b still attached
    expect(gateway.snapshot().active).toBe(true);
    gateway.unsubscribeVideo("b");
    await flush();
    expect(adapter.sendsFor("guid-2")).toEqual([{ bye: true }]);
    expect(gateway.snapshot().active).toBe(false);
    expect(adapter.stopped).toBe(1);
  });
});

describe("StreamGateway loss — getStatus watchdog → 4409 + active:false (task 2.3)", () => {
  it("probe failure closes every viewer socket and reports device_lost on the state", async () => {
    let alive = true;
    const { gateway, adapter } = makeGateway({
      probe: async () => {
        if (!alive) throw new GrpcControlError("DEVICE_OFFLINE", "emulator gone");
      },
      watchdogMs: 5,
    });
    const a = new RecordingViewer("a");
    const b = new RecordingViewer("b");
    await gateway.subscribeVideo(a);
    await gateway.subscribeVideo(b);
    await flush();
    expect(gateway.snapshot().active).toBe(true);
    alive = false;
    // The watchdog interval is 5ms — wait a real wall-clock window so the
    // interval is guaranteed to fire regardless of test-load scheduling.
    await new Promise((r) => setTimeout(r, 60));
    expect(a.closeCount).toBe(1);
    expect(b.closeCount).toBe(1);
    const snap = gateway.snapshot();
    expect(snap.active).toBe(false);
    expect(snap.reason).toBe("device_lost");
    expect(snap.rtc?.active).toBe(false);
    expect(adapter.sendsFor("guid-1")).toEqual([{ bye: true }]);
    expect(adapter.sendsFor("guid-2")).toEqual([{ bye: true }]);
  });
});

describe("StreamGateway.relayViewerMessage — client JSEP routing (task 2.7)", () => {
  it("routes answer+ice into the viewer's stream (probe-b2 flush preserved end-to-end)", async () => {
    const { gateway, adapter } = makeGateway();
    const v = new RecordingViewer("v1");
    await gateway.subscribeVideo(v);
    expect(gateway.relayViewerMessage("v1", { type: "ice", candidate: { candidate: "candidate:1", sdpMid: "0" } })).toBe(true);
    expect(gateway.relayViewerMessage("v1", { type: "answer", sdp: "v=0 answer" })).toBe(true);
    await flush();
    expect(adapter.sendsFor("guid-1")).toEqual([
      { type: "answer", sdp: "v=0 answer" },
      { candidate: "candidate:1", sdpMid: "0" },
    ]);
    gateway.unsubscribeVideo("v1");
  });

  it("state:streaming from the client echoes the state frame", async () => {
    const { gateway } = makeGateway();
    const v = new RecordingViewer("v1");
    await gateway.subscribeVideo(v);
    expect(gateway.relayViewerMessage("v1", { type: "state", state: "streaming" })).toBe(true);
    await flush();
    expect(v.messages).toContainEqual({ type: "state", state: "streaming" });
    gateway.unsubscribeVideo("v1");
  });

  it("returns false for a viewer with no stream (the bridge closes 4409)", async () => {
    const { gateway } = makeGateway();
    expect(gateway.relayViewerMessage("ghost", { type: "answer", sdp: "v=0" })).toBe(false);
  });
});

describe("StreamGateway.controlActive — gRPC injector while streaming (task 2.5)", () => {
  it("exposes the injector from controlFor while the stream is active, null after teardown", async () => {
    const { gateway, injections, controls } = makeGateway();
    controls.set("emulator-5554", {
      tap: async (x: number, y: number) => void injections.push(`tap(${x},${y})`),
      swipe: async () => {},
      text: async () => {},
      keyPress: async () => {},
      keyCode: async () => {},
      reportDisplaySize: () => undefined,
      refreshDisplay: async () => ({ width: 1080, height: 2400 }),
    });
    expect(gateway.controlActive()).toBeNull(); // no stream yet
    const v = new RecordingViewer("v1");
    await gateway.subscribeVideo(v);
    const injector = gateway.controlActive();
    expect(injector).not.toBeNull();
    await injector!.inject({ type: "inject", event: "tap", x: 10, y: 20 });
    expect(injections).toEqual(["tap(10,20)"]);
    gateway.unsubscribeVideo("v1");
    await flush();
    expect(gateway.controlActive()).toBeNull(); // stream gone → injector gone
  });
});
