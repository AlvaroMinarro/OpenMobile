/**
 * Bridge lifecycle + UI-tree route contracts (bridge-surface-v2 Phase 2).
 *
 * Adapters delegate to the proven MCP handlers (tools/handlers.ts) through an
 * assembled DeviceContext and translate handler failures into HTTP semantics
 * at the route layer (design D3). In-memory CLI/adb doubles record every call
 * so pre-check-before-delegate behavior is directly observable.
 */
import { describe, expect, it } from "bun:test";
import { createBridgeApp, toolFailureToHttp } from "../src/bridge/server";
import type { BridgeDeps } from "../src/bridge/server";
import type { AVD, Device, UIElement } from "../src/device/types";
import { uiElementToJson } from "../src/device/serialize";

/** A minimal but fully-populated UIElement for layout doubles. */
const sampleElement = (): UIElement => ({
  bounds: { left: 0, top: 0, right: 200, bottom: 80 },
  center: { x: 100, y: 40 },
  interactions: ["click"],
  state: "default",
  offScreen: false,
  text: "Sign in",
});

/** Lifecycle-capable in-memory doubles recording every CLI call. */
function makeLifecycleDeps() {
  const state = {
    avds: [{ name: "Pixel_9_Pro", running: false }] as AVD[],
    devices: [{ serial: "emulator-5554", state: "device" }] as Device[],
    startCalls: [] as string[],
    stopCalls: [] as string[],
    createCalls: [] as string[],
    layoutCalls: [] as string[],
    layoutElements: [] as UIElement[],
    dumpXml: "<hierarchy/>",
  };
  const deps: BridgeDeps = {
    bridge: { version: "test", pid: 1234 },
    adb: {
      devices: async () => state.devices,
      inputTap: async () => {},
      inputSwipe: async () => {},
      inputText: async () => {},
      uiautomatorDump: async (serial: string) => {
        state.layoutCalls.push(`dump:${serial}`);
        return state.dumpXml;
      },
    },
    cli: {
      emulatorList: async () => state.avds.map((a) => ({ ...a })),
      capture: async () => {},
      emulatorStart: async (name: string) => {
        state.startCalls.push(name);
        state.avds[0]!.running = true;
        return "emulator-5554";
      },
      emulatorStop: async (name: string) => {
        state.stopCalls.push(name);
        state.avds[0]!.running = false;
      },
      emulatorCreate: async (name: string) => {
        state.createCalls.push(name);
        state.avds.push({ name, running: false });
      },
      layout: async (target: { serial: string }) => {
        state.layoutCalls.push(`layout:${target.serial}`);
        return state.layoutElements;
      },
    },
    env: {},
    readFile: async () => new Uint8Array(),
    tempPngPath: () => "/tmp/om-lifecycle-test.png",
  };
  const app = createBridgeApp(deps);
  return {
    deps,
    state,
    http: (req: Request) => app.fetch(req, { upgrade: () => false } as unknown as Bun.Server<Record<string, unknown>>),
  };
}

const post = (path: string, body?: string): Request =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

describe("POST /v1/emulator/start (task 2.1)", () => {
  it("happy path with an explicit name responds 200 {started, serial}", async () => {
    const { http, state } = makeLifecycleDeps();
    const res = await http(post("/v1/emulator/start", JSON.stringify({ name: "Pixel_9_Pro" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ started: "Pixel_9_Pro", serial: "emulator-5554" });
    expect(state.startCalls).toEqual(["Pixel_9_Pro"]);
  });

  it("defaults the name to the single available AVD", async () => {
    const { http, state } = makeLifecycleDeps();
    const res = await http(post("/v1/emulator/start", "{}"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ started: "Pixel_9_Pro", serial: "emulator-5554" });
    expect(state.startCalls).toEqual(["Pixel_9_Pro"]);
  });

  it("schema-invalid body responds 422 validation_error without delegating", async () => {
    const { http, state } = makeLifecycleDeps();
    const res = await http(post("/v1/emulator/start", JSON.stringify({ name: 123 })));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
    expect(state.startCalls).toEqual([]);
  });

  it("malformed (non-JSON) body responds 422 validation_error", async () => {
    const { http, state } = makeLifecycleDeps();
    const res = await http(post("/v1/emulator/start", "not json"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
    expect(state.startCalls).toEqual([]);
  });
});

describe("D3 cheap emulatorList() pre-checks (task 2.2)", () => {
  it("duplicate create responds 409 avd_exists and issues ZERO CLI creates", async () => {
    const { http, state } = makeLifecycleDeps();
    const res = await http(post("/v1/emulator/create", JSON.stringify({ name: "Pixel_9_Pro" })));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("avd_exists");
    expect(body.error.message).toContain("Pixel_9_Pro");
    // Pre-check beats delegation: the existing AVD is never clobbered.
    expect(state.createCalls).toEqual([]);
  });

  it("start of an unknown AVD responds 404 avd_not_found with details.available", async () => {
    const { deps, http, state } = makeLifecycleDeps();
    state.avds.push({ name: "Tablet_11", running: false });
    const res = await http(post("/v1/emulator/start", JSON.stringify({ name: "Missing" })));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; details: { available: string[] } } };
    expect(body.error.code).toBe("avd_not_found");
    expect(body.error.details.available).toEqual(["Pixel_9_Pro", "Tablet_11"]);
    // The pre-check wins over the handler's own unknown-AVD ToolError.
    expect(state.startCalls).toEqual([]);
    void deps;
  });

  it("stop of an unknown AVD responds 404 avd_not_found with details.available", async () => {
    const { http, state } = makeLifecycleDeps();
    state.avds.push({ name: "Tablet_11", running: false });
    const res = await http(post("/v1/emulator/stop", JSON.stringify({ name: "Missing" })));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; details: { available: string[] } } };
    expect(body.error.code).toBe("avd_not_found");
    expect(body.error.details.available).toEqual(["Pixel_9_Pro", "Tablet_11"]);
    expect(state.stopCalls).toEqual([]);
  });

  it("create of a NEW AVD still delegates to the handler and reports created", async () => {
    const { http, state } = makeLifecycleDeps();
    const res = await http(post("/v1/emulator/create", JSON.stringify({ name: "Fresh_AVD" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: "Fresh_AVD" });
    expect(state.createCalls).toEqual(["Fresh_AVD"]);
  });
});

describe("ONE ToolError→status mapping function (task 2.3, design D3)", () => {
  it("maps the pinned boot-timeout message to 504 boot_timeout {name,serial,lastState}", () => {
    // Exact tools/handlers.ts emulator_start timeout text (contract-pinned).
    const e = toolFailureToHttp(
      "Pixel_9_Pro",
      "emulator Pixel_9_Pro did not reach 'device' state within 60000ms (serial emulator-5554, last observed state: offline)",
    );
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(504);
    expect(e.code).toBe("boot_timeout");
    expect(e.details).toEqual({ name: "Pixel_9_Pro", serial: "emulator-5554", lastState: "offline" });
  });

  it("maps ANY other handler failure to 500 INTERNAL_ERROR with the message verbatim", () => {
    const e = toolFailureToHttp(undefined, "android CLI failed (emulator stop X): boom");
    expect(e.status).toBe(500);
    expect(e.code).toBe("INTERNAL_ERROR");
    expect(e.message).toBe("android CLI failed (emulator stop X): boom");
    expect(e.details).toBeUndefined();
  });

  it("recovers the AVD name from the pinned message when none was supplied", () => {
    const e = toolFailureToHttp(
      undefined,
      "emulator Tablet_11 did not reach 'device' state within 5ms (serial emulator-5560, last observed state: no-device)",
    );
    expect(e.status).toBe(504);
    expect(e.details).toEqual({ name: "Tablet_11", serial: "emulator-5560", lastState: "no-device" });
  });

  it("surfaces a real boot timeout through POST /v1/emulator/start as 504", async () => {
    const { http, state } = makeLifecycleDeps();
    // The started serial never reaches 'device' before the tiny outer bound.
    state.devices[0]!.state = "offline";
    const res = await http(
      post("/v1/emulator/start", JSON.stringify({ name: "Pixel_9_Pro", timeoutMs: 60 })),
    );
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: { code: string; details: Record<string, string> } };
    expect(body.error.code).toBe("boot_timeout");
    expect(body.error.details).toEqual({
      name: "Pixel_9_Pro",
      serial: "emulator-5554",
      lastState: "offline",
    });
    expect(state.startCalls).toEqual(["Pixel_9_Pro"]);
  });

  it("surfaces an arbitrary CLI failure through POST /v1/emulator/stop as 500", async () => {
    const { deps, http, state } = makeLifecycleDeps();
    // Running AVD ⇒ the route delegates; only THEN does the CLI failure map.
    state.avds[0]!.running = true;
    deps.cli.emulatorStop = async () => {
      throw new Error("android CLI failed (emulator stop Pixel_9_Pro): boom");
    };
    const res = await http(post("/v1/emulator/stop", JSON.stringify({ name: "Pixel_9_Pro" })));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
    // Idempotence memory must NOT record a failed stop as settled.
    const retry = await http(post("/v1/emulator/stop", JSON.stringify({ name: "Pixel_9_Pro" })));
    expect(retry.status).toBe(500);
  });
});

describe("route-layer idempotent stop (task 2.4, design D3)", () => {
  it("stopping a known stopped AVD twice answers 200 twice; second is alreadyStopped; zero CLI stops", async () => {
    const { http, state } = makeLifecycleDeps(); // AVD exists and is NOT running
    const first = await http(post("/v1/emulator/stop", JSON.stringify({ name: "Pixel_9_Pro" })));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ stopped: "Pixel_9_Pro" });
    expect(state.stopCalls).toEqual([]);
    const second = await http(post("/v1/emulator/stop", JSON.stringify({ name: "Pixel_9_Pro" })));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ stopped: "Pixel_9_Pro", alreadyStopped: true });
    // Route-layer check: no CLI stop was EVER issued for a stopped AVD.
    expect(state.stopCalls).toEqual([]);
  });

  it("stopping a RUNNING AVD delegates once; the repeat is answered idempotently", async () => {
    const { http, state } = makeLifecycleDeps();
    state.avds[0]!.running = true;
    const first = await http(post("/v1/emulator/stop", JSON.stringify({ name: "Pixel_9_Pro" })));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ stopped: "Pixel_9_Pro" });
    expect(state.stopCalls).toEqual(["Pixel_9_Pro"]);
    const second = await http(post("/v1/emulator/stop", JSON.stringify({ name: "Pixel_9_Pro" })));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ stopped: "Pixel_9_Pro", alreadyStopped: true });
    // The repeat never reached the CLI again.
    expect(state.stopCalls).toEqual(["Pixel_9_Pro"]);
  });
});

describe("GET /v1/ui-tree (task 2.5)", () => {
  it("populated hierarchy responds 200 {serial, empty:false, tree} shape-equal to the local tool", async () => {
    const element = sampleElement();
    const { http, state } = makeLifecycleDeps();
    state.layoutElements = [element];
    const res = await http(new Request("http://127.0.0.1/v1/ui-tree"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { serial: string; empty: boolean; tree: unknown[] };
    // Exact key set of the local get_ui_tree payload.
    expect(Object.keys(body).sort()).toEqual(["empty", "serial", "tree"]);
    expect(body.serial).toBe("emulator-5554");
    expect(body.empty).toBe(false);
    // Shape-equality with the local tool: same uiElementToJson serialization.
    expect(body.tree).toEqual([uiElementToJson(element)]);
    expect(state.layoutCalls).toContain("layout:emulator-5554");
  });

  it("an EMPTY hierarchy is signalled IN-BAND as 200 empty:true tree:[] — never an HTTP error", async () => {
    const { http, state } = makeLifecycleDeps();
    state.layoutElements = []; // CLI empty ⇒ handler falls back to the XML dump
    const res = await http(new Request("http://127.0.0.1/v1/ui-tree"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { serial: string; empty: boolean; tree: unknown[] };
    expect(body.empty).toBe(true);
    expect(body.tree).toEqual([]);
    expect(body.serial).toBe("emulator-5554");
    expect(state.layoutCalls).toContain("dump:emulator-5554");
  });

  it("?device= targets the explicit serial through to the dump path", async () => {
    const element = sampleElement();
    const { http, state } = makeLifecycleDeps();
    state.layoutElements = [element];
    const res = await http(new Request("http://127.0.0.1/v1/ui-tree?device=emulator-9999"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { serial: string; empty: boolean; tree: unknown[] };
    expect(body.serial).toBe("emulator-9999");
    expect(body.empty).toBe(false);
    expect(state.layoutCalls).toContain("layout:emulator-9999");
  });

  it("without the ui-tree capabilities the route 404s (streaming-not-deployed precedent)", async () => {
    const { deps } = makeLifecycleDeps();
    delete deps.cli.layout;
    delete deps.adb.uiautomatorDump;
    const app = createBridgeApp(deps);
    const res = await app.fetch(
      new Request("http://127.0.0.1/v1/ui-tree"),
      { upgrade: () => false } as unknown as Bun.Server<Record<string, unknown>>,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("auth on ⇒ credential-less GET /v1/ui-tree is 401 like every /v1 route", async () => {
    const { deps } = makeLifecycleDeps();
    deps.cli.layout = async () => [];
    const app = createBridgeApp(deps, { secret: "s3cr3t" });
    const denied = await app.fetch(
      new Request("http://127.0.0.1/v1/ui-tree"),
      { upgrade: () => false } as unknown as Bun.Server<Record<string, unknown>>,
    );
    expect(denied.status).toBe(401);
    const body = (await denied.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("auth on ⇒ valid seed bearer reaches the route (open-by-default when auth unset proven above)", async () => {
    const element = sampleElement();
    const { deps, state } = makeLifecycleDeps();
    state.layoutElements = [element];
    const app = createBridgeApp(deps, { secret: "s3cr3t" });
    const ok = await app.fetch(
      new Request("http://127.0.0.1/v1/ui-tree", { headers: { authorization: "Bearer s3cr3t" } }),
      { upgrade: () => false } as unknown as Bun.Server<Record<string, unknown>>,
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { serial: string; empty: boolean };
    expect(body.serial).toBe("emulator-5554");
    expect(body.empty).toBe(false);
  });
});
