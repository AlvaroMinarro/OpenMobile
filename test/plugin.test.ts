import { describe, expect, it } from "bun:test";
import { buildSnapshot, hasUsableDevice, sha256, type BridgeState } from "../src/plugin/snapshot";
import { FeedbackLoop } from "../src/plugin/controller";
import {
  bridgeStateUrl,
  createPush,
  makePluginHooks,
  type SessionClient,
} from "../src/plugin/index";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dev = { serial: "emulator-5554", state: "device" as const, model: "Pixel 9 Pro" };

describe("snapshot building (pure)", () => {
  it("builds a compact snapshot when a usable device is selected", () => {
    const state: BridgeState = {
      selected: dev,
      devices: [dev],
      emulators: [{ name: "Pixel_9_Pro", running: true }],
      frame: { width: 1080, height: 2400, elementCount: 42, changedCount: 5, layoutAt: "2026-08-12T17:00:00.000Z" },
    };
    const snap = buildSnapshot(state);
    expect(snap).not.toBeNull();
    expect(snap).toContain("emulator-5554");
    expect(snap).toContain("device");
    expect(snap).toContain("Pixel 9 Pro");
    expect(snap).toContain("1080x2400");
    expect(snap).toContain("42");
    expect(snap).toContain("5 changed");
  });

  it("returns null when no device is selected", () => {
    expect(buildSnapshot({ selected: null, devices: [] })).toBeNull();
  });

  it("returns null when the selected device is not usable (offline)", () => {
    expect(
      buildSnapshot({ selected: { serial: "x", state: "offline" }, devices: [] }),
    ).toBeNull();
  });

  it("hasUsableDevice is true only for a selected device in state 'device'", () => {
    expect(hasUsableDevice({ selected: dev, devices: [dev] })).toBe(true);
    expect(hasUsableDevice({ selected: { serial: "x", state: "offline" }, devices: [] })).toBe(
      false,
    );
    expect(hasUsableDevice({ selected: null, devices: [] })).toBe(false);
  });

  it("emits a stable content hash", async () => {
    const a = await sha256("hello snapshot");
    const b = await sha256("hello snapshot");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256("different")).not.toBe(a);
  });
});

describe("FeedbackLoop (debounce + dedupe + skip)", () => {
  it("does not push when snapshot content is unchanged (content-hash dedupe)", async () => {
    let pushes = 0;
    const loop = new FeedbackLoop({
      throttleMs: 1,
      fetchState: async () => ({ selected: dev, devices: [dev] }),
      push: async () => void pushes++,
    });
    await loop.flush();
    await loop.flush();
    await loop.flush();
    expect(pushes).toBe(1);
  });

  it("pushes again when the snapshot content changes", async () => {
    let count = 1;
    let pushes = 0;
    const loop = new FeedbackLoop({
      throttleMs: 1,
      fetchState: async () => ({
        selected: dev,
        devices: [dev],
        frame: { elementCount: count },
      }),
      push: async () => void pushes++,
    });
    await loop.flush();
    count = 2;
    await loop.flush();
    expect(pushes).toBe(2);
  });

  it("skips (no push) when no device is selected", async () => {
    let pushes = 0;
    const loop = new FeedbackLoop({
      throttleMs: 1,
      fetchState: async () => ({ selected: null, devices: [] }),
      push: async () => void pushes++,
    });
    await loop.flush();
    await loop.flush();
    expect(pushes).toBe(0);
    expect(loop.lastSnapshot()).toBeNull();
  });

  it("tolerates a down bridge without crashing or pushing", async () => {
    let pushes = 0;
    let errors = 0;
    const loop = new FeedbackLoop({
      throttleMs: 1,
      fetchState: async () => {
        throw new Error("connection refused");
      },
      push: async () => void pushes++,
      onError: () => void errors++,
    });
    await loop.flush();
    expect(pushes).toBe(0);
    expect(errors).toBe(1);
  });

  it("debounces a burst of events into a single push (2000ms-style trailing)", async () => {
    let pushes = 0;
    const loop = new FeedbackLoop({
      throttleMs: 20,
      fetchState: async () => ({ selected: dev, devices: [dev] }),
      push: async () => void pushes++,
    });
    loop.onData();
    loop.onData();
    loop.onData();
    await sleep(60);
    expect(pushes).toBe(1);
  });

  it("coalesces concurrent overlapping flushes", async () => {
    let pushes = 0;
    let resolveFirst!: () => void;
    const gate = new Promise<void>((r) => (resolveFirst = r));
    const loop = new FeedbackLoop({
      throttleMs: 1,
      fetchState: async () => ({ selected: dev, devices: [dev] }),
      push: async () => {
        pushes++;
        await gate;
      },
    });
    const p1 = loop.flush();
    const p2 = loop.flush();
    resolveFirst();
    await Promise.all([p1, p2]);
    expect(pushes).toBe(1);
  });
});

describe("plugin wiring (headless hooks)", () => {
  it("builds the bridge state URL from OPENMOBILE_BRIDGE_PORT", () => {
    expect(bridgeStateUrl({ OPENMOBILE_BRIDGE_PORT: "9999" })).toBe("http://127.0.0.1:9999/v1/state");
    expect(bridgeStateUrl({})).toBe("http://127.0.0.1:8765/v1/state");
  });

  it("returns the expected hook set", () => {
    const loop = new FeedbackLoop({
      throttleMs: 1,
      fetchState: async () => ({ selected: null, devices: [] }),
      push: async () => {},
    });
    const hooks = makePluginHooks({}, loop);
    expect(typeof hooks["session.idle"]).toBe("function");
    expect(typeof hooks["tool.execute.after"]).toBe("function");
    expect(typeof hooks["experimental.session.compacting"]).toBe("function");
  });

  it("pushes to session.prompt with noReply:true via createPush", async () => {
    const calls: unknown[] = [];
    const client: SessionClient = {
      session: {
        prompt: async (req) => void calls.push(req),
      },
    };
    const push = createPush(client, "sess-1");
    await push("device snapshot");
    expect(calls).toHaveLength(1);
    const payload = calls[0] as { noReply?: boolean; prompt: string; parts: unknown[]; sessionID?: string };
    expect(payload.noReply).toBe(true);
    expect(payload.parts).toEqual([]);
    expect(payload.sessionID).toBe("sess-1");
    expect(payload.prompt).toBe("device snapshot");
  });

  it("createPush omits sessionID when none is available", async () => {
    const calls: unknown[] = [];
    const client: SessionClient = {
      session: { prompt: async (req) => void calls.push(req) },
    };
    await createPush(client)("snapshot");
    const payload = calls[0] as { sessionID?: string };
    expect(payload.sessionID).toBeUndefined();
  });

  it("createPush throws when session.prompt is unavailable", async () => {
    await expect(createPush(undefined)("snapshot")).rejects.toThrow(/session\.prompt/);
  });
});
