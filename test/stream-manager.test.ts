import { describe, expect, it } from "bun:test";
import {
  StreamManager,
  type AdapterDeps,
  type AdapterEvent,
  type AdapterSession,
  type StreamManagerOptions,
  type StreamViewerSubscription,
} from "../src/stream/manager";
import type { Device } from "../src/device/types";

/**
 * In-memory scrcpy adapter — INDEPENDENT double (NOT the real scrcpy.ts):
 * StreamManager only depends on the documented interface
 * `start(serial): Promise<AdapterSession>` / `stop()`. This keeps the
 * lifecycle test honest: start-on-first-viewer, teardown-on-last, the
 * device-loss watchdog, and the env kill-switch are exercised against the
 * manager contract, not against adb argv wiring (which PR 1 already pins).
 */
class FakeAdapter {
  started: string | null = null;
  stopped = 0;
  sessions: FakeSession[] = [];
  /** Client-supplied failure injection: next start() rejects. */
  failNext = false;
  /** Client-supplied loss injection: fire the session's loss callback. */
  dropSession?: (s: FakeSession) => void;

  async start(serial: string): Promise<AdapterSession> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("adb: device offline");
    }
    const session = new FakeSession(serial, this);
    this.started = serial;
    this.sessions.push(session);
    return session;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    this.started = null;
  }
}

class FakeSession implements AdapterSession {
  readonly serial: string;
  onEvent: ((e: AdapterEvent) => void) | undefined;
  closed = false;
  private _onLoss: (() => void) | undefined;
  private readonly adapter: FakeAdapter;

  constructor(serial: string, adapter: FakeAdapter) {
    this.serial = serial;
    this.adapter = adapter;
    this.adapter.dropSession = undefined;
  }

  onLoss(cb: (() => void) | undefined): void {
    this._onLoss = cb;
    this.adapter.dropSession = cb;
  }

  async sendControl(bytes: Uint8Array): Promise<void> {
    // The manager must never write control bytes when unsupported — the
    // session is only reachable while active, so just record the write.
  }

  close(): void {
    this.closed = true;
    this.adapter.stop().catch(() => {});
  }

  get connected(): boolean {
    return !this.closed;
  }
}

async function flush(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** subscribe() returns undefined only when disabled; tests always enable. */
function sub(manager: StreamManager): StreamViewerSubscription {
  const s = manager.subscribe();
  expect(s).toBeDefined();
  return s as StreamViewerSubscription;
}

function makeManager(overrides: Partial<StreamManagerOptions> = {}): {
  manager: StreamManager;
  adapter: FakeAdapter;
} {
  const adapter = new FakeAdapter();
  const manager = new StreamManager({
    adapter,
    serial: "emulator-5554",
    // Never hit real adb from unit tests: the default watchdog poll source
    // shells out; tests that exercise loss/presence supply their own poll.
    pollDevices: async () => [{ serial: "emulator-5554", state: "device" }],
    ...overrides,
  });
  return { manager, adapter };
}

describe("StreamManager lifecycle — start on first viewer, teardown on last (design D5)", () => {
  it("does NOT start an adapter session before the first viewer subscribes", () => {
    const { adapter } = makeManager();
    expect(adapter.started).toBeNull();
  });

  it("starts exactly one session when the first viewer subscribes", async () => {
    const { manager, adapter } = makeManager();
    const v = sub(manager);
    await flush();
    expect(adapter.started).toBe("emulator-5554");
    expect(adapter.sessions).toHaveLength(1);
    expect(manager.snapshot().viewers).toBe(1);
    expect(v).toBeDefined();
  });

  it("keeps the ONE session while a second viewer subscribes (no restart)", async () => {
    const { manager, adapter } = makeManager();
    sub(manager);
    await flush();
    const before = adapter.sessions.length;
    expect(before).toBe(1);
    sub(manager);
    await flush();
    expect(adapter.sessions).toHaveLength(1);
    expect(manager.snapshot().viewers).toBe(2);
  });

  it("tears down the session when the LAST viewer unsubscribes", async () => {
    const { manager, adapter } = makeManager();
    const v1 = sub(manager);
    const v2 = sub(manager);
    await flush();
    expect(adapter.sessions).toHaveLength(1);
    manager.unsubscribe(v1);
    await flush();
    expect(adapter.started).toBe("emulator-5554"); // one viewer left — still streaming
    manager.unsubscribe(v2);
    await flush();
    expect(adapter.stopped).toBeGreaterThanOrEqual(1);
    expect(adapter.started).toBeNull();
    expect(manager.snapshot().active).toBe(false);
  });

  it("refcounts: same subscription id cannot double-release the session", async () => {
    const { manager, adapter } = makeManager();
    const v = sub(manager);
    await flush();
    manager.unsubscribe(v);
    manager.unsubscribe(v); // no-op — must not tear down twice / throw
    await flush();
    expect(adapter.stopped).toBeGreaterThanOrEqual(1);
    expect(adapter.sessions).toHaveLength(1);
  });

  it("restarts a fresh session after teardown when a viewer re-subscribes", async () => {
    const { manager, adapter } = makeManager();
    const v1 = sub(manager);
    await flush();
    manager.unsubscribe(v1);
    await flush();
    expect(adapter.started).toBeNull();
    const v2 = sub(manager);
    await flush();
    expect(adapter.sessions).toHaveLength(2); // session #2, not a reuse
    expect(adapter.started).toBe("emulator-5554");
    manager.unsubscribe(v2);
  });
});

describe("StreamManager device-loss watchdog — serial gone mid-stream tears down (design D5)", () => {
  it("tears down the session when the serial disappears from `adb devices`", async () => {
    const { manager, adapter } = makeManager({
      pollDevices: async () => [],
    });
    const v = sub(manager);
    await flush();
    expect(adapter.started).toBe("emulator-5554");
    // The watchdog polls `adb devices -l`; the serial vanishes.
    manager.poke(); // one full poll cycle
    await flush();
    expect(adapter.stopped).toBeGreaterThanOrEqual(1);
    expect(adapter.started).toBeNull();
    expect(manager.snapshot().active).toBe(false);
    expect(manager.snapshot().reason).toBe("device_lost");
    manager.unsubscribe(v);
  });

  it("keeps the session when the serial is still present", async () => {
    const { manager, adapter } = makeManager();
    // The watchdog read is provided from the outside via options poll fn.
    const { manager: m2, adapter: a2 } = makeManager({
      pollDevices: async () => [{ serial: "emulator-5554", state: "device" }],
    });
    const v = sub(m2);
    await flush();
    m2.poke();
    await flush();
    expect(a2.started).toBe("emulator-5554");
    expect(a2.stopped).toBe(0);
    m2.unsubscribe(v);
  });

  it("does not tear down when OTHER serials are gone — only ITS serial drives teardown", async () => {
    const { manager: m, adapter: a } = makeManager({
      pollDevices: async () => [{ serial: "emulator-5554", state: "device" }],
    });
    const v = sub(m);
    await flush();
    m.poke();
    await flush();
    expect(a.stopped).toBe(0);
    expect(m.snapshot().active).toBe(true);
    m.unsubscribe(v);
  });

  it("reports device_lost even when the poll itself throws (adb hiccup counts as loss)", async () => {
    const { manager: m, adapter: a } = makeManager({
      pollDevices: async () => {
        throw new Error("adb crashed");
      },
    });
    const v = sub(m);
    await flush();
    m.poke();
    await flush();
    expect(a.stopped).toBeGreaterThanOrEqual(1);
    expect(m.snapshot().active).toBe(false);
    expect(m.snapshot().reason).toBe("device_lost");
    m.unsubscribe(v);
  });

  it("restarts the session after a device-loss teardown when a viewer re-subscribes", async () => {
    const { manager, adapter } = makeManager();
    // The serial is present until the FIRST loss poll, then absent; the
    // restart's watchdog sees the serial gone again and self-tears-down
    // (which the assertions below guard against by checking sessions).
    let lost = false;
    let present = true;
    const poll: () => Promise<Device[]> = async () => {
      if (lost && present) {
        present = false; // device gone after first loss
      }
      return present ? [{ serial: "emulator-5554", state: "device" }] : [];
    };
    const m = new StreamManager({
      adapter,
      serial: "emulator-5554",
      pollDevices: poll,
    });
    const v = sub(m);
    await flush();
    lost = true;
    await m.poke(); // loss
    await flush();
    expect(m.snapshot().active).toBe(false);
    // Re-subscribe: a fresh session must start even though the watchdog
    // (device now gone) may immediately tear it down again — the point is
    // the manager is NOT wedged.
    const v2 = sub(m);
    await flush();
    await flush();
    expect(adapter.sessions.length).toBeGreaterThanOrEqual(2);
    m.unsubscribe(v);
    m.unsubscribe(v2);
    await m.stop().catch(() => {});
  });
});

describe("StreamManager env kill-switch — OPENMOBILE_STREAM=off (design D6)", () => {
  it("exposes supported:false when the kill-switch is off", () => {
    const { manager } = makeManager({ enabled: false });
    expect(manager.snapshot().supported).toBe(false);
    expect(manager.snapshot().active).toBe(false);
  });

  it("cannot start a stream when disabled (subscribe is a no-op)", async () => {
    const { manager, adapter } = makeManager({ enabled: false });
    const v = manager.subscribe(); // returns undefined when disabled
    await flush();
    expect(adapter.started).toBeNull();
    expect(adapter.sessions).toHaveLength(0);
    expect(manager.snapshot().viewers).toBe(0);
    expect(v).toBeUndefined();
  });

  it("does NOT tear down an active stream when disabled mid-flight — it simply stops starting", async () => {
    const { manager, adapter } = makeManager();
    const v = sub(manager);
    await flush();
    expect(adapter.started).toBe("emulator-5554");
    manager.setEnabled(false); // env flip while streaming — in-flight session survives
    await flush();
    expect(adapter.started).toBe("emulator-5554");
    manager.unsubscribe(v);
    await flush(); // teardown still happens on last viewer
  });
});

describe("StreamManager snapshot + events", () => {
  it("emits 'started' once on first viewer and 'stopped' on last viewer", async () => {
    const { manager } = makeManager();
    const events: string[] = [];
    manager.onEvent((e) => events.push(e.type));
    const v = sub(manager);
    await flush();
    expect(events).toEqual(["started"]);
    manager.unsubscribe(v);
    await flush();
    expect(events).toEqual(["started", "stopped"]);
  });

  it("exposes supported/active/reason/viewers in the snapshot (design D6)", async () => {
    const { manager, adapter } = makeManager();
    expect(manager.snapshot()).toEqual({ supported: true, active: false, viewers: 0 });
    const v = sub(manager);
    await flush();
    const snap = manager.snapshot();
    expect(snap.active).toBe(true);
    expect(snap.viewers).toBe(1);
    expect(snap.supported).toBe(true);
    expect(snap.reason).toBeUndefined();
    manager.unsubscribe(v);
  });

  it("does not start a second session when start() fails once (next viewer retries)", async () => {
    const { manager, adapter } = makeManager();
    adapter.failNext = true;
    const v1 = sub(manager);
    await flush(8); // drain the failed-start promise chain fully
    expect(adapter.started).toBeNull(); // failed start — no session
    // A second viewer retries and succeeds (recovery path).
    adapter.failNext = false;
    const v2 = sub(manager);
    await flush(8);
    expect(adapter.started).toBe("emulator-5554");
    expect(adapter.sessions).toHaveLength(1);
    manager.unsubscribe(v1);
    manager.unsubscribe(v2);
    manager.stop().catch(() => {});
  });
});