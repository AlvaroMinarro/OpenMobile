/**
 * GET /v1/state selection field contracts (bridge-surface-v2 Phase 3, task
 * 3.4; design D4). While the override tier RESOLVES `selected`, the body gains
 * ONE sibling key `"selection":{"serial","source":"override"}` via the same
 * conditional-spread precedent as `stream`. With no override — or when an
 * explicit ?device= outranks it — zero new keys: byte-identical legacy body.
 */
import { describe, expect, it } from "bun:test";
import { createBridgeApp } from "../src/bridge/server";
import type { BridgeDeps } from "../src/bridge/server";
import { createSelectionOverride } from "../src/bridge/main";
import type { AVD, Device } from "../src/device/types";

const TWO_DEVICES = [
  { serial: "emulator-5554", state: "device", model: "Pixel_9_Pro" },
  { serial: "emulator-5556", state: "device", model: "Tablet_11" },
] as Device[];

/** Minimal state-capable deps: devices + emulators + optional override holder. */
function makeStateDeps(opts: {
  devices?: Device[];
  env?: Record<string, string>;
  withHolder?: boolean; // wire a holder WITHOUT selecting anything
} = {}) {
  const deps: BridgeDeps = {
    bridge: { version: "test", pid: 1234 },
    adb: {
      devices: async () => (opts.devices ?? TWO_DEVICES) as Device[],
      inputTap: async () => {},
      inputSwipe: async () => {},
      inputText: async () => {},
    },
    cli: {
      emulatorList: async () => [{ name: "Pixel_9_Pro", running: false }] as AVD[],
      capture: async () => {},
    },
    env: opts.env ?? {},
    readFile: async () => new Uint8Array(),
    tempPngPath: () => "/tmp/om-state-field-test.png",
    ...(opts.withHolder ? { selectionOverride: createSelectionOverride() } : {}),
  };
  const app = createBridgeApp(deps);
  return {
    deps,
    http: (req: Request) =>
      app.fetch(req, { upgrade: () => false } as unknown as Bun.Server<Record<string, unknown>>),
  };
}

const get = (path: string): Request => new Request(`http://127.0.0.1${path}`);

interface StateBody {
  schema: string;
  selected: { serial: string; state: string; model?: string } | null;
  selection?: { serial: string; source: string };
  devices: Device[];
  emulators: AVD[];
}

describe("GET /v1/state with an active selection override (task 3.4, design D4)", () => {
  it("override resolving `selected` adds sibling selection {serial, source:'override'} and selected reports it", async () => {
    const { http } = makeStateDeps({ withHolder: true });
    // Select through the real route so holder + field are proven end-to-end.
    const select = await http(
      new Request("http://127.0.0.1/v1/device/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serial: "emulator-5556" }),
      }),
    );
    expect(select.status).toBe(200);
    const res = await http(get("/v1/state"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as StateBody;
    expect(body.selection).toEqual({ serial: "emulator-5556", source: "override" });
    expect(body.selected).toEqual(TWO_DEVICES[1]!); // resolved serial carries the full entry
  });

  it("selection is a TOP-LEVEL sibling appended after emulators (stream-spread precedent)", async () => {
    const { http } = makeStateDeps({ withHolder: true });
    await http(
      new Request("http://127.0.0.1/v1/device/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serial: "emulator-5554" }),
      }),
    );
    const body = (await (await http(get("/v1/state"))).json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      "schema",
      "bridge",
      "selected",
      "frame",
      "devices",
      "emulators",
      "selection",
    ]);
  });

  it("explicit ?device= beats the override for THIS request and adds NO selection key", async () => {
    const { deps, http } = makeStateDeps({ withHolder: true });
    deps.selectionOverride!.set("emulator-5556");
    const res = await http(get("/v1/state?device=emulator-5554"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as StateBody;
    expect(body.selected?.serial).toBe("emulator-5554");
    expect(body.selection).toBeUndefined();
  });

  it("stale override still answers 200 with selected synthesized naming the serial (state never errors on selection)", async () => {
    const { deps, http } = makeStateDeps({ devices: [], withHolder: true });
    deps.selectionOverride!.set("emulator-5556");
    const res = await http(get("/v1/state"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as StateBody;
    expect(body.selected).toEqual({ serial: "emulator-5556", state: "device" });
    expect(body.selection).toEqual({ serial: "emulator-5556", source: "override" });
    expect(body.devices).toEqual([]);
  });
});

describe("no override ⇒ zero new keys, byte-identical legacy body (task 3.4)", () => {
  it("holder present-but-null produces EXACTLY the bytes of an app without the dep", async () => {
    const withoutDep = makeStateDeps();
    const withNullHolder = makeStateDeps({ withHolder: true });
    const a = await withoutDep.http(get("/v1/state"));
    const b = await withNullHolder.http(get("/v1/state"));
    expect(b.status).toBe(200);
    expect(await b.text()).toBe(await a.text());
  });

  it("legacy single-device auto body contains no selection key at all", async () => {
    const { http } = makeStateDeps({
      devices: [{ serial: "emulator-5554", state: "device", model: "Pixel_9_Pro" }],
      withHolder: true,
    });
    const raw = await (await http(get("/v1/state"))).text();
    expect(raw).not.toContain('"selection"');
    const body = JSON.parse(raw) as StateBody;
    expect(body.selected?.serial).toBe("emulator-5554"); // auto tier intact
    expect(Object.keys(body)).toEqual([
      "schema",
      "bridge",
      "selected",
      "frame",
      "devices",
      "emulators",
    ]);
  });

  it("env-selected body stays byte-identical too (override tier sits ABOVE env only when active)", async () => {
    const { http } = makeStateDeps({
      env: { ANDROID_DEVICE: "emulator-5556" },
      withHolder: true,
    });
    const raw = await (await http(get("/v1/state"))).text();
    expect(raw).not.toContain('"selection"');
    expect((JSON.parse(raw) as StateBody).selected?.serial).toBe("emulator-5556");
  });

  it("no device attached keeps the legacy 200 empty-list contract untouched", async () => {
    const { http } = makeStateDeps({ devices: [] });
    const res = await http(get("/v1/state"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as StateBody;
    expect(body.selected).toBeNull();
    expect(body.devices).toEqual([]);
    expect(body.selection).toBeUndefined();
  });
});
