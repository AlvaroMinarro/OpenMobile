import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBridgeHandler } from "../src/bridge/server";
import type { BridgeDeps } from "../src/bridge/server";
import type { AVD, Device } from "../src/device/types";

/** In-memory device stubs recording calls so route behavior is observable. */
function makeDeps(overrides: Partial<BridgeDeps> = {}) {
  const state: {
    devices: Device[];
    emulators: AVD[];
    taps: Array<{ s: string; x: number; y: number }>;
    swipes: Array<{ s: string; x1: number; y1: number; x2: number; y2: number; d?: number }>;
    texts: Array<{ s: string; t: string }>;
    captures: Array<{ serial: string; outPath: string }>;
  } = {
    devices: [],
    emulators: [],
    taps: [],
    swipes: [],
    texts: [],
    captures: [],
  };
  const deps: BridgeDeps = {
    bridge: { version: "test", pid: 1234 },
    adb: {
      devices: async () => state.devices,
      inputTap: async (s, x, y) => void state.taps.push({ s, x, y }),
      inputSwipe: async (s, x1, y1, x2, y2, d) => void state.swipes.push({ s, x1, y1, x2, y2, d }),
      inputText: async (s, t) => void state.texts.push({ s, t }),
    },
    cli: {
      emulatorList: async () => state.emulators,
      capture: async (t) => void state.captures.push(t),
    },
    env: {},
    readFile: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), // PNG magic
    tempPngPath: (_kind: string, _serial: string) => "/tmp/om-br-mock.png",
    ...overrides,
  };
  return { deps, state };
}

/** Route through Bun.in-memory Server.fetch (no network socket needed). */
function makeInMemoryServer(deps: BridgeDeps, opts?: { secret?: string }) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createBridgeHandler(deps, opts),
  });
  return {
    dispatch: (path: string, init?: RequestInit) =>
      server.fetch(new Request(`http://127.0.0.1${path}`, init)),
    stop: () => server.stop(),
  };
}

const req = (
  srv: ReturnType<typeof makeInMemoryServer>,
  path: string,
  init?: RequestInit,
) => srv.dispatch(path, init);

describe("GET /v1/state", () => {
  it("returns 200 always, with schema/bridge metadata, selected/frame (nullable) and device+emulator lists", async () => {
    const { deps, state } = makeDeps();
    state.devices = [
      { serial: "emulator-5554", state: "device", model: "Pixel_9_Pro" },
      { serial: "deadbeef", state: "device" },
    ];
    state.emulators = [{ name: "Pixel_9_Pro", running: true }];
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/state");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        schema: string;
        bridge: { version: string; pid: number };
        selected: unknown;
        frame: unknown;
        devices: unknown[];
        emulators: unknown[];
      };
      expect(body.schema).toBe("v1");
      expect(body.bridge).toEqual({ version: "test", pid: 1234 });
      expect(body.selected).toBeNull(); // 2 devices, none selected
      expect(body.frame).toBeNull();
      expect(body.devices).toHaveLength(2);
      expect(body.emulators).toHaveLength(1);
    } finally {
      srv.stop();
    }
  });

  it("auto-selects the single attached device", async () => {
    const { deps, state } = makeDeps();
    state.devices = [{ serial: "emulator-5554", state: "device", model: "Pixel_9_Pro" }];
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/state");
      const body = (await res.json()) as {
        selected: { serial: string; state: string; model?: string };
      };
      expect(body.selected).toEqual({
        serial: "emulator-5554",
        state: "device",
        model: "Pixel_9_Pro",
      });
    } finally {
      srv.stop();
    }
  });

  it("honors ANDROID_DEVICE env over auto-detect", async () => {
    const { deps, state } = makeDeps({ env: { ANDROID_DEVICE: "deadbeef" } });
    state.devices = [
      { serial: "emulator-5554", state: "device" },
      { serial: "deadbeef", state: "device" },
    ];
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/state");
      const body = (await res.json()) as { selected: { serial: string } };
      expect(body.selected?.serial).toBe("deadbeef");
    } finally {
      srv.stop();
    }
  });

  it("honors the ?device explicit serial over env", async () => {
    const { deps, state } = makeDeps({ env: { ANDROID_DEVICE: "deadbeef" } });
    state.devices = [{ serial: "emulator-5554", state: "device" }];
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/state?device=emulator-5554");
      const body = (await res.json()) as { selected?: { serial: string } };
      expect(body.selected?.serial).toBe("emulator-5554");
    } finally {
      srv.stop();
    }
  });
});

describe("GET /v1/screenshot", () => {
  it("returns 200 PNG bytes", async () => {
    const { deps, state } = makeDeps();
    state.devices = [{ serial: "emulator-5554", state: "device" }];
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/screenshot");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes.slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(state.captures).toHaveLength(1);
      expect(state.captures[0]?.serial).toBe("emulator-5554");
    } finally {
      srv.stop();
    }
  });

  it("GET /v1/screenshot deletes its unique temp PNG after the read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "om-br-test-"));
    const shotPath = join(dir, "shot.png");
    const { deps, state } = makeDeps({
      readFile: async (path: string) => {
        await writeFile(path, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
        return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      },
      tempPngPath: (_kind: string, _serial: string) => shotPath,
    });
    state.devices = [{ serial: "emulator-5554", state: "device" }];
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/screenshot");
      expect(res.status).toBe(200);
      expect(existsSync(shotPath)).toBe(false); // cleaned up after bytes read
      expect(state.captures[0]?.outPath).toBe(shotPath);
    } finally {
      srv.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns 409 NO_DEVICE when nothing is attached", async () => {
    const { deps } = makeDeps(); // no devices
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/screenshot");
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("NO_DEVICE");
    } finally {
      srv.stop();
    }
  });

  it("returns 409 DEVICE_OFFLINE when the auto-detected device is offline", async () => {
    const { deps, state } = makeDeps();
    state.devices = [{ serial: "emulator-5554", state: "offline" }];
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/screenshot");
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("DEVICE_OFFLINE");
    } finally {
      srv.stop();
    }
  });

  it("returns 500 INTERNAL_ERROR when capture fails", async () => {
    const { deps, state } = makeDeps();
    state.devices = [{ serial: "emulator-5554", state: "device" }];
    deps.cli.capture = async () => {
      throw new Error("capture exploded");
    };
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/screenshot");
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INTERNAL_ERROR");
    } finally {
      srv.stop();
    }
  });
});

describe("POST /v1/input/tap", () => {
  it("injects a tap and returns 200", async () => {
    const { deps, state } = makeDeps();
    state.devices = [{ serial: "emulator-5554", state: "device" }];
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/input/tap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: 100, y: 200 }),
      });
      expect(res.status).toBe(200);
      expect(state.taps).toEqual([{ s: "emulator-5554", x: 100, y: 200 }]);
      const body = (await res.json()) as { ok: boolean; x: number; y: number; serial: string };
      expect(body.ok).toBe(true);
      expect(body.x).toBe(100);
      expect(body.y).toBe(200);
      expect(body.serial).toBe("emulator-5554");
    } finally {
      srv.stop();
    }
  });

  it("honors an explicit ?device serial", async () => {
    const { deps, state } = makeDeps({ env: { ANDROID_DEVICE: "deadbeef" } });
    state.devices = [
      { serial: "emulator-5554", state: "device" },
      { serial: "deadbeef", state: "device" },
    ];
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/input/tap?device=emulator-5554", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: 1, y: 2 }),
      });
      expect(res.status).toBe(200);
      expect(state.taps[0]?.s).toBe("emulator-5554");
    } finally {
      srv.stop();
    }
  });

  it("returns 422 when a required coordinate is missing", async () => {
    const { deps, state } = makeDeps();
    state.devices = [{ serial: "emulator-5554", state: "device" }];
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/input/tap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ y: 200 }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; details?: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details).toContain("x");
      expect(state.taps).toHaveLength(0);
    } finally {
      srv.stop();
    }
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const { deps, state } = makeDeps();
    state.devices = [{ serial: "emulator-5554", state: "device" }];
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/input/tap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("BAD_REQUEST");
    } finally {
      srv.stop();
    }
  });

  it("returns 409 when the auto-detected device is offline", async () => {
    const { deps, state } = makeDeps();
    state.devices = [{ serial: "emulator-5554", state: "offline" }];
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/input/tap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: 1, y: 2 }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("DEVICE_OFFLINE");
    } finally {
      srv.stop();
    }
  });
});

describe("POST /v1/input/swipe", () => {
  it("injects a swipe with optional duration and returns 200", async () => {
    const { deps, state } = makeDeps();
    state.devices = [{ serial: "emulator-5554", state: "device" }];
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/input/swipe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x1: 0, y1: 0, x2: 300, y2: 800, durationMs: 120 }),
      });
      expect(res.status).toBe(200);
      expect(state.swipes).toEqual([
        { s: "emulator-5554", x1: 0, y1: 0, x2: 300, y2: 800, d: 120 },
      ]);
    } finally {
      srv.stop();
    }
  });

  it("returns 422 when an endpoint coordinate is missing", async () => {
    const { deps, state } = makeDeps();
    state.devices = [{ serial: "emulator-5554", state: "device" }];
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/input/swipe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x1: 0, y1: 0, x2: 300 }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; details?: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details).toContain("y2");
    } finally {
      srv.stop();
    }
  });
});

describe("POST /v1/input/text", () => {
  it("injects text and returns 200", async () => {
    const { deps, state } = makeDeps();
    state.devices = [{ serial: "emulator-5554", state: "device" }];
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/input/text", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello world" }),
      });
      expect(res.status).toBe(200);
      expect(state.texts).toEqual([{ s: "emulator-5554", t: "hello world" }]);
    } finally {
      srv.stop();
    }
  });

  it("returns 422 for empty text", async () => {
    const { deps, state } = makeDeps();
    state.devices = [{ serial: "emulator-5554", state: "device" }];
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/input/text", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "" }),
      });
      expect(res.status).toBe(422);
      expect(state.texts).toHaveLength(0);
    } finally {
      srv.stop();
    }
  });

  it("returns 422 for characters adb cannot inject", async () => {
    const { deps, state } = makeDeps();
    state.devices = [{ serial: "emulator-5554", state: "device" }];
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/input/text", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "line1\nline2" }),
      });
      expect(res.status).toBe(422);
      expect(state.texts).toHaveLength(0);
    } finally {
      srv.stop();
    }
  });
});

describe("routing and auth", () => {
  it("returns 404 for an unknown /v1 route", async () => {
    const { deps } = makeDeps();
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/v1/nope");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");
    } finally {
      srv.stop();
    }
  });

  it("returns 404 for a non-/v1 route", async () => {
    const { deps } = makeDeps();
    const srv = makeInMemoryServer(deps);
    try {
      const res = await req(srv, "/healthz");
      expect(res.status).toBe(404);
    } finally {
      srv.stop();
    }
  });

  it("rejects requests missing the secret header when configured (default off)", async () => {
    const { deps, state } = makeDeps();
    state.devices = [{ serial: "emulator-5554", state: "device" }];
    const srv = makeInMemoryServer(deps, { secret: "s3cr3t" });
    try {
      const noHeader = await req(srv, "/v1/state");
      expect(noHeader.status).toBe(401);
      const wrong = await req(srv, "/v1/state", { headers: { "x-openmobile-secret": "wrong" } });
      expect(wrong.status).toBe(401);
      const ok = await req(srv, "/v1/state", { headers: { "x-openmobile-secret": "s3cr3t" } });
      expect(ok.status).toBe(200);
    } finally {
      srv.stop();
    }
  });

  it("allows requests without a secret header by default", async () => {
    const { deps } = makeDeps();
    const srv = makeInMemoryServer(deps); // no secret option
    try {
      const res = await req(srv, "/v1/state");
      expect(res.status).toBe(200);
    } finally {
      srv.stop();
    }
  });
});

describe("CORS (V2 OpenChamber surface readiness)", () => {
  it("stamps Access-Control-Allow-Origin on GET responses", async () => {
    const { deps } = makeDeps();
    const srv = makeInMemoryServer(deps);
    try {
      const res = await srv.dispatch("/v1/state", {
        headers: { origin: "http://localhost:5180" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5180");
    } finally {
      srv.stop();
    }
  });

  it("echoes the request origin instead of a fixed * when one is sent", async () => {
    const { deps } = makeDeps();
    const srv = makeInMemoryServer(deps);
    try {
      const res = await srv.dispatch("/v1/state", {
        headers: { origin: "https://example-dev.example" },
      });
      expect(res.headers.get("access-control-allow-origin")).toBe("https://example-dev.example");
    } finally {
      srv.stop();
    }
  });

  it("answers OPTIONS preflight with 204 and the allow-methods/headers", async () => {
    const { deps } = makeDeps();
    const srv = makeInMemoryServer(deps);
    try {
      const res = await srv.dispatch("/v1/input/tap", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:5180",
          "access-control-request-method": "POST",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5180");
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
      expect(res.headers.get("access-control-allow-headers")).toContain("x-openmobile-secret");
    } finally {
      srv.stop();
    }
  });

  it("stamps CORS on error responses too (422 validation)", async () => {
    const { deps, state } = makeDeps();
    state.devices = [{ serial: "emulator-5554", state: "device" }];
    const srv = makeInMemoryServer(deps);
    try {
      const res = await srv.dispatch("/v1/input/tap", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:5180",
        },
        body: JSON.stringify({ y: 200 }),
      });
      expect(res.status).toBe(422);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5180");
    } finally {
      srv.stop();
    }
  });
});