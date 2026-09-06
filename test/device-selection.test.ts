/**
 * Selection override tier + POST /v1/device/select contracts
 * (bridge-surface-v2 Phase 3, tasks 3.1–3.3; design D7).
 *
 * The override lives in DAEMON MEMORY only: it is a holder owned by main.ts
 * wiring, so re-creating the deps (a simulated restart) clears it. Precedence
 * under the override is pinned by the device-discovery delta:
 *   explicit ?device=  >  override  >  ANDROID_DEVICE env  >  auto-detect.
 * In-memory CLI/adb doubles record every call so targeting is directly
 * observable without a real device.
 */
import { describe, expect, it } from "bun:test";
import { createBridgeApp } from "../src/bridge/server";
import type { BridgeDeps } from "../src/bridge/server";
import { createBridgeDeps, createSelectionOverride } from "../src/bridge/main";
import type { AVD, Device, UIElement } from "../src/device/types";

/** Two attached devices for precedence/ambiguity cases. */
const TWO_DEVICES = [
  { serial: "emulator-5554", state: "device", model: "Pixel_9_Pro" },
  { serial: "emulator-5556", state: "device", model: "Tablet_11" },
] as Device[];

/**
 * Full in-memory deps with recording adb doubles and an optional pre-set
 * selection override + ANDROID_DEVICE env — the harness for the matrix.
 */
function makeSelectionDeps(opts: {
  devices?: Device[];
  env?: Record<string, string>;
  selectFirst?: boolean; // convenience: set the override to emulator-5556
} = {}) {
  const state = {
    devices: (opts.devices ?? TWO_DEVICES) as Device[],
    taps: [] as Array<{ s: string; x: number; y: number }>,
    layoutCalls: [] as string[],
    dumpCalls: [] as string[],
    layoutElements: [] as UIElement[],
    dumpXml: "<hierarchy/>",
  };
  const deps: BridgeDeps = {
    bridge: { version: "test", pid: 1234 },
    adb: {
      devices: async () => state.devices,
      inputTap: async (s, x, y) => void state.taps.push({ s, x, y }),
      inputSwipe: async () => {},
      inputText: async () => {},
      uiautomatorDump: async (serial: string) => {
        state.dumpCalls.push(serial);
        return state.dumpXml;
      },
    },
    cli: {
      emulatorList: async () =>
        [{ name: "Pixel_9_Pro", running: false }] as AVD[],
      capture: async () => {},
      layout: async (target: { serial: string }) => {
        state.layoutCalls.push(target.serial);
        return state.layoutElements;
      },
    },
    env: opts.env ?? {},
    readFile: async () => new Uint8Array(),
    tempPngPath: () => "/tmp/om-selection-test.png",
    selectionOverride: createSelectionOverride(),
  };
  if (opts.selectFirst) deps.selectionOverride!.set("emulator-5556");
  const app = createBridgeApp(deps);
  return {
    deps,
    state,
    http: (req: Request) =>
      app.fetch(req, { upgrade: () => false } as unknown as Bun.Server<Record<string, unknown>>),
  };
}

const postJson = (path: string, body: string): Request =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

describe("selectionOverride holder (task 3.1, design D7)", () => {
  it("createBridgeDeps wires an in-memory holder: set then current returns the serial", () => {
    const deps = createBridgeDeps({});
    expect(deps.selectionOverride).toBeDefined();
    expect(deps.selectionOverride!.current()).toBeNull();
    deps.selectionOverride!.set("emulator-5556");
    expect(deps.selectionOverride!.current()).toBe("emulator-5556");
  });

  it("simulated daemon restart (re-wired deps) yields null — daemon memory only", () => {
    const env = { OPENMOBILE_STREAM: "off" };
    const first = createBridgeDeps(env);
    first.selectionOverride!.set("emulator-5556");
    // A restart rebuilds the wiring from scratch; nothing persists it.
    const restarted = createBridgeDeps(env);
    expect(restarted.selectionOverride!.current()).toBeNull();
    // The old holder is untouched: state is per-wiring, not global.
    expect(first.selectionOverride!.current()).toBe("emulator-5556");
  });

  it("createSelectionOverride returns independent holders per call", () => {
    const a = createSelectionOverride();
    const b = createSelectionOverride();
    a.set("emulator-5554");
    expect(b.current()).toBeNull();
    expect(a.current()).toBe("emulator-5554");
  });
});

describe("precedence matrix via POST /v1/input/tap (task 3.2)", () => {
  it("explicit ?device= beats the override", async () => {
    const { http, state } = makeSelectionDeps({ selectFirst: true }); // override → emulator-5556
    const res = await http(
      postJson("/v1/input/tap?device=emulator-5554", JSON.stringify({ x: 1, y: 2 })),
    );
    expect(res.status).toBe(200);
    expect(state.taps.map((t) => t.s)).toEqual(["emulator-5554"]);
  });

  it("override beats ANDROID_DEVICE env", async () => {
    const { http, state } = makeSelectionDeps({
      env: { ANDROID_DEVICE: "emulator-5554" },
      selectFirst: true, // override → emulator-5556
    });
    const res = await http(postJson("/v1/input/tap", JSON.stringify({ x: 1, y: 2 })));
    expect(res.status).toBe(200);
    expect(state.taps.map((t) => t.s)).toEqual(["emulator-5556"]);
  });

  it("env beats auto-detect (two attached, no override/explicit)", async () => {
    const { http, state } = makeSelectionDeps({ env: { ANDROID_DEVICE: "emulator-5554" } });
    const res = await http(postJson("/v1/input/tap", JSON.stringify({ x: 1, y: 2 })));
    expect(res.status).toBe(200);
    expect(state.taps.map((t) => t.s)).toEqual(["emulator-5554"]);
  });

  it("multi-device ambiguity error lists ALL serials (unchanged legacy rule)", async () => {
    const { http, state } = makeSelectionDeps();
    const res = await http(postJson("/v1/input/tap", JSON.stringify({ x: 1, y: 2 })));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details: string[] } };
    expect(body.error.code).toBe("AMBIGUOUS_DEVICE");
    expect(body.error.details).toEqual(["emulator-5554", "emulator-5556"]);
    expect(state.taps).toEqual([]);
  });

  it("single-device auto-detect intact (no env, no override)", async () => {
    const { http, state } = makeSelectionDeps({
      devices: [{ serial: "emulator-5554", state: "device", model: "Pixel_9_Pro" }],
    });
    const res = await http(postJson("/v1/input/tap", JSON.stringify({ x: 1, y: 2 })));
    expect(res.status).toBe(200);
    expect(state.taps.map((t) => t.s)).toEqual(["emulator-5554"]);
  });

  it("stale override on a routed op: 409 naming emulator-9999, zero taps issued", async () => {
    const { http, state } = makeSelectionDeps({
      devices: [{ serial: "emulator-5554", state: "device", model: "Pixel_9_Pro" }],
      selectFirst: true, // override points at the DETACHED emulator-5556
    });
    const res = await http(postJson("/v1/input/tap", JSON.stringify({ x: 1, y: 2 })));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("DEVICE_OFFLINE");
    expect(body.error.message).toContain("emulator-5556"); // names the stale serial
    expect(state.taps).toEqual([]); // never fell back to emulator-5554
  });

  it("GET /v1/ui-tree targets the override past ANDROID_DEVICE (override rides the explicit tier)", async () => {
    const { http, state } = makeSelectionDeps({
      env: { ANDROID_DEVICE: "emulator-5554" },
      selectFirst: true,
    });
    state.layoutElements = [];
    const res = await http(new Request("http://127.0.0.1/v1/ui-tree"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { serial: string };
    expect(body.serial).toBe("emulator-5556");
    expect(state.layoutCalls).toContain("emulator-5556");
  });

  it("stale override on GET /v1/ui-tree errors naming the serial without touching adb/CLI", async () => {
    const { http, state } = makeSelectionDeps({
      devices: [{ serial: "emulator-5554", state: "device", model: "Pixel_9_Pro" }],
      selectFirst: true,
    });
    const res = await http(new Request("http://127.0.0.1/v1/ui-tree"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain("emulator-5556");
    expect(state.layoutCalls).toEqual([]);
    expect(state.dumpCalls).toEqual([]);
  });
});

describe("POST /v1/device/select (task 3.3)", () => {
  it("attached serial ⇒ 200 {selected} and becomes the RUNTIME selection (next op targets it)", async () => {
    const { http, state } = makeSelectionDeps();
    const res = await http(postJson("/v1/device/select", JSON.stringify({ serial: "emulator-5556" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ selected: "emulator-5556" });
    // The selection outranks the two-device ambiguity for FOLLOWING ops.
    const tap = await http(postJson("/v1/input/tap", JSON.stringify({ x: 1, y: 2 })));
    expect(tap.status).toBe(200);
    expect(state.taps.map((t) => t.s)).toEqual(["emulator-5556"]);
  });

  it("unknown serial ⇒ 404 device_not_found with details.attached naming what IS attached", async () => {
    const { http, state } = makeSelectionDeps({
      devices: [{ serial: "emulator-5554", state: "device", model: "Pixel_9_Pro" }],
    });
    const res = await http(postJson("/v1/device/select", JSON.stringify({ serial: "does-not-exist" })));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; details: { attached: string[] } } };
    expect(body.error.code).toBe("device_not_found");
    expect(body.error.details.attached).toEqual(["emulator-5554"]);
    // A rejected select must NOT become the runtime selection.
    const tap = await http(postJson("/v1/input/tap", JSON.stringify({ x: 1, y: 2 })));
    expect(tap.status).toBe(200);
    expect(state.taps.map((t) => t.s)).toEqual(["emulator-5554"]); // plain auto-detect
  });

  it("malformed or schema-invalid bodies ⇒ 422 validation_error without touching the holder", async () => {
    const { deps, http } = makeSelectionDeps();
    const bad400 = await http(postJson("/v1/device/select", "{not json"));
    expect(bad400.status).toBe(422);
    expect(((await bad400.json()) as { error: { code: string } }).error.code).toBe("validation_error");
    const bad422 = await http(postJson("/v1/device/select", JSON.stringify({ serial: 123 })));
    expect(bad422.status).toBe(422);
    const missing = await http(postJson("/v1/device/select", JSON.stringify({})));
    expect(missing.status).toBe(422);
    expect(deps.selectionOverride!.current()).toBeNull();
  });

  it("re-selecting another attached serial overwrites the previous override", async () => {
    const { http, state } = makeSelectionDeps();
    await http(postJson("/v1/device/select", JSON.stringify({ serial: "emulator-5554" })));
    await http(postJson("/v1/device/select", JSON.stringify({ serial: "emulator-5556" })));
    const tap = await http(postJson("/v1/input/tap", JSON.stringify({ x: 1, y: 2 })));
    expect(tap.status).toBe(200);
    expect(state.taps.map((t) => t.s)).toEqual(["emulator-5556"]);
  });

  it("auth on ⇒ credential-less select is 401 behind the single seam; bearer seed passes", async () => {
    const { deps } = makeSelectionDeps();
    const app = createBridgeApp(deps, { secret: "s3cr3t" });
    const fetcher = (req: Request) =>
      app.fetch(req, { upgrade: () => false } as unknown as Bun.Server<Record<string, unknown>>);
    const denied = await fetcher(postJson("/v1/device/select", JSON.stringify({ serial: "emulator-5556" })));
    expect(denied.status).toBe(401);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
    expect(deps.selectionOverride!.current()).toBeNull(); // gate precedes any state change
    const ok = await fetcher(
      new Request("http://127.0.0.1/v1/device/select", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer s3cr3t" },
        body: JSON.stringify({ serial: "emulator-5556" }),
      }),
    );
    expect(ok.status).toBe(200);
    expect(deps.selectionOverride!.current()).toBe("emulator-5556");
  });

  it("simulated restart (fresh wiring) drops the selection — tiers rule again", async () => {
    const before = makeSelectionDeps();
    await before.http(postJson("/v1/device/select", JSON.stringify({ serial: "emulator-5556" })));
    // A restarted daemon re-wires everything; the new app knows no override.
    const after = makeSelectionDeps({
      devices: [
        { serial: "emulator-5554", state: "device", model: "Pixel_9_Pro" },
        { serial: "emulator-5556", state: "device", model: "Tablet_11" },
      ],
    });
    const res = await after.http(postJson("/v1/input/tap", JSON.stringify({ x: 1, y: 2 })));
    expect(res.status).toBe(409); // ambiguity again, NOT silently pinned to 5556
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AMBIGUOUS_DEVICE");
  });
});
