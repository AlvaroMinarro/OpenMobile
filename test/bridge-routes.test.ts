/**
 * Bridge route contracts for the auth seam (bridge-surface-v2 Phase 1).
 *
 * Golden half (task 1.8): seed-unset responses of ALL pre-existing /v1 routes
 * pinned byte-for-byte against literals recorded from the PRE-CHANGE code
 * (approval testing) — the auth-seam refactor may not move a single byte.
 * Auth-gate contracts live alongside per task order.
 */
import { describe, expect, it } from "bun:test";
import { createBridgeApp } from "../src/bridge/server";
import type { BridgeDeps } from "../src/bridge/server";
import { TokenRegistry } from "../src/bridge/auth";
import type { AVD, Device } from "../src/device/types";

/** In-memory device doubles recording calls so gate-before-handler is observable. */
export function makeRouteDeps(overrides: Partial<BridgeDeps> = {}) {
  const state = {
    devices: [{ serial: "emulator-5554", state: "device", model: "Pixel_9_Pro" }] as Device[],
    emulators: [{ name: "Pixel_9_Pro", running: true }] as AVD[],
    taps: [] as Array<{ s: string; x: number; y: number }>,
    texts: [] as Array<{ s: string; t: string }>,
  };
  const deps: BridgeDeps = {
    bridge: { version: "test", pid: 1234 },
    adb: {
      devices: async () => state.devices,
      inputTap: async (s, x, y) => void state.taps.push({ s, x, y }),
      inputSwipe: async () => {},
      inputText: async (s, t) => void state.texts.push({ s, t }),
      screencap: async () => {},
    },
    cli: { emulatorList: async () => state.emulators, capture: async () => {} },
    env: {},
    readFile: async () =>
      new Uint8Array([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
        0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0, 253, 212, 154, 115,
        0, 0, 0, 9, 112, 72, 89, 83, 0, 0, 3, 232, 0, 0, 3, 232,
        1, 181, 123, 82, 107, 0, 0, 0, 18, 73, 68, 65, 84, 8, 153, 99,
        56, 145, 98, 116, 34, 197, 136, 1, 66, 1, 0, 40, 174, 5, 121,
        159, 94, 63, 149, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
      ]),
    tempPngPath: () => "/tmp/om-golden-mock.png",
    ...overrides,
  };
  return { deps, state };
}

export interface RouteServer {
  http: (path: string, init?: RequestInit) => Promise<Response>;
  stop: () => void;
}

/** In-memory Bun.serve over the FULL app (fetch + websocket), port 0. */
export function makeRouteServer(
  deps: BridgeDeps,
  opts?: { secret?: string; allowedOriginsCsv?: string; authRegistry?: TokenRegistry },
): RouteServer {
  const app = createBridgeApp(deps, opts);
  const server = Bun.serve<Record<string, unknown>>({
    port: 0,
    fetch: app.fetch,
    websocket: app.websocket,
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    http: async (path, init) => await server.fetch(new Request(`${base}${path}`, init)),
    stop: () => server.stop(),
  };
}

const JSON_CT = "application/json; charset=utf-8";

const SEED = "s3cr3t";

describe("auth enabled — single seam rejects anonymous access (task 1.2)", () => {
  it("401 JSON {error:{code,message}} for a credential-less GET /v1/state", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps, { secret: SEED });
    try {
      const res = await srv.http("/v1/state");
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toBe(JSON_CT);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("unauthorized");
      expect(typeof body.error.message).toBe("string");
    } finally {
      srv.stop();
    }
  });

  it("gates EVERY /v1 route incl. legacy POST ones — handler never runs without credentials", async () => {
    const { deps, state } = makeRouteDeps();
    const srv = makeRouteServer(deps, { secret: SEED });
    try {
      for (const path of ["/v1/screenshot", "/v1/input/tap", "/v1/input/swipe", "/v1/input/text"]) {
        const res = await srv.http(path, {
          method: path.includes("screenshot") ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          body: path === "/v1/screenshot" ? undefined : JSON.stringify({ x: 1, y: 2 }),
        });
        expect(res.status).toBe(401);
      }
      // Gate precedes dispatch: zero device-core calls leaked through.
      expect(state.taps).toEqual([]);
    } finally {
      srv.stop();
    }
  });

  it("accepts the seed as Authorization: Bearer on legacy routes", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps, { secret: SEED });
    try {
      const res = await srv.http("/v1/state", { headers: { authorization: `Bearer ${SEED}` } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { schema: string }).schema).toBe("v1");
    } finally {
      srv.stop();
    }
  });

  it("keeps honoring the legacy X-OpenMobile-Secret header", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps, { secret: SEED });
    try {
      const ok = await srv.http("/v1/state", { headers: { "x-openmobile-secret": SEED } });
      expect(ok.status).toBe(200);
      const bad = await srv.http("/v1/state", { headers: { "x-openmobile-secret": "wrong" } });
      expect(bad.status).toBe(401);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
    } finally {
      srv.stop();
    }
  });

  it("accepts both credential carriers when wired through parsed AuthConfig too", async () => {
    const { parseAuthConfig } = await import("../src/bridge/auth");
    const app = createBridgeApp(makeRouteDeps().deps, {
      auth: parseAuthConfig({ OPENMOBILE_BRIDGE_SECRET: SEED }),
    });
    const server = Bun.serve<Record<string, unknown>>({ port: 0, fetch: app.fetch, websocket: app.websocket });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const denied = await server.fetch(new Request(`${base}/v1/state`));
      expect(denied.status).toBe(401);
      const bearer = await server.fetch(new Request(`${base}/v1/state`, {
        headers: { authorization: `Bearer ${SEED}` },
      }));
      expect(bearer.status).toBe(200);
    } finally {
      server.stop();
    }
  });
});

describe("POST /v1/auth/token — issuance (task 1.3)", () => {
  const postToken = (srv: RouteServer, init?: RequestInit) =>
    srv.http("/v1/auth/token", { method: "POST", ...init });

  it("Bearer seed ⇒ 200 {token(32B base64url), expiresAt ISO future, ttlSeconds 3600}", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps, { secret: SEED });
    try {
      const res = await postToken(srv, { headers: { authorization: `Bearer ${SEED}` } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(JSON_CT);
      const body = (await res.json()) as { token: string; expiresAt: string; ttlSeconds: number };
      // 32 random bytes → 43-char unpadded base64url (RFC6455 token grammar).
      expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(body.token, "base64url").length).toBe(32);
      const exp = new Date(body.expiresAt);
      expect(body.expiresAt).toBe(exp.toISOString()); // absolute ISO-8601
      const expectedExpiry = Date.now() + 3600_000;
      expect(Math.abs(exp.getTime() - expectedExpiry)).toBeLessThan(5000);
      expect(body.ttlSeconds).toBe(3600);
    } finally {
      srv.stop();
    }
  });

  it("clamps requested ttlSeconds into [60, cap]", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps, { secret: SEED });
    try {
      const mint = async (ttl: number) =>
        (await (
          await postToken(srv, {
            headers: { authorization: `Bearer ${SEED}`, "content-type": "application/json" },
            body: JSON.stringify({ ttlSeconds: ttl }),
          })
        ).json()) as { ttlSeconds: number };
      expect((await mint(90)).ttlSeconds).toBe(90);
      expect((await mint(10)).ttlSeconds).toBe(60); // floor
      expect((await mint(999_999)).ttlSeconds).toBe(86_400); // default cap
    } finally {
      srv.stop();
    }
  });

  it("respects a server-enforced lower TTL_MAX cap from config", async () => {
    const { parseAuthConfig } = await import("../src/bridge/auth");
    const app = createBridgeApp(makeRouteDeps().deps, {
      auth: parseAuthConfig({
        OPENMOBILE_BRIDGE_SECRET: SEED,
        OPENMOBILE_BRIDGE_TOKEN_TTL_MAX: "300",
      }),
    });
    const server = Bun.serve<Record<string, unknown>>({ port: 0, fetch: app.fetch, websocket: app.websocket });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const res = await server.fetch(new Request(`${base}/v1/auth/token`, {
        method: "POST",
        headers: { authorization: `Bearer ${SEED}`, "content-type": "application/json" },
        body: JSON.stringify({ ttlSeconds: 999_999 }),
      }));
      expect(((await res.json()) as { ttlSeconds: number }).ttlSeconds).toBe(300);
    } finally {
      server.stop();
    }
  });

  it("wrong or missing credential ⇒ 401 unauthorized, no token issued", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps, { secret: SEED });
    try {
      const anon = await postToken(srv);
      expect(anon.status).toBe(401);
      expect(((await anon.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
      const wrong = await postToken(srv, { headers: { authorization: "Bearer nope" } });
      expect(wrong.status).toBe(401);
      expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
      // Legacy header carrier works too (design D2).
      const legacy = await postToken(srv, { headers: { "x-openmobile-secret": SEED } });
      expect(legacy.status).toBe(200);
    } finally {
      srv.stop();
    }
  });

  it("a freshly issued TOKEN cannot mint more tokens — seed only", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps, { secret: SEED });
    try {
      const minted = (await (
        await postToken(srv, { headers: { authorization: `Bearer ${SEED}` } })
      ).json()) as { token: string };
      const res = await postToken(srv, { headers: { authorization: `Bearer ${minted.token}` } });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
    } finally {
      srv.stop();
    }
  });

  it("malformed bodies follow house conventions (400 bad JSON, 422 bad field)", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps, { secret: SEED });
    try {
      const bad400 = await postToken(srv, {
        headers: { authorization: `Bearer ${SEED}`, "content-type": "application/json" },
        body: "{not json",
      });
      expect(bad400.status).toBe(400);
      const bad422 = await postToken(srv, {
        headers: { authorization: `Bearer ${SEED}`, "content-type": "application/json" },
        body: JSON.stringify({ ttlSeconds: "soon" }),
      });
      expect(bad422.status).toBe(422);
      expect(((await bad422.json()) as { error: { code: string } }).error.code).toBe(
        "VALIDATION_ERROR",
      );
    } finally {
      srv.stop();
    }
  });
});

describe("token validation on protected routes (task 1.4)", () => {
  it("a freshly issued token authenticates GET /v1/state end-to-end", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps, { secret: SEED });
    try {
      const minted = (await (
        await srv.http("/v1/auth/token", { headers: { authorization: `Bearer ${SEED}` }, method: "POST" })
      ).json()) as { token: string };
      const res = await srv.http("/v1/state", { headers: { authorization: `Bearer ${minted.token}` } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { schema: string }).schema).toBe("v1");
    } finally {
      srv.stop();
    }
  });

  it("an expired token ⇒ 401 token_expired, purged lazily from the registry", async () => {
    const registry = new TokenRegistry();
    registry.register("stale-token", Date.now() - 1000); // already expired
    expect(registry.size).toBe(1);
    const srv = makeRouteServer(makeRouteDeps().deps, { secret: SEED, authRegistry: registry });
    try {
      const res = await srv.http("/v1/state", { headers: { authorization: "Bearer stale-token" } });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("token_expired");
      // Lazy purge: the expired entry is gone after the failed attempt.
      expect(registry.size).toBe(0);
      // A second attempt no longer knows the token ever existed.
      const again = await srv.http("/v1/state", { headers: { authorization: "Bearer stale-token" } });
      expect(again.status).toBe(401);
      expect(((await again.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
    } finally {
      srv.stop();
    }
  });

  it("an unknown credential ⇒ 401 unauthorized (never token_expired)", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps, { secret: SEED });
    try {
      const res = await srv.http("/v1/state", { headers: { authorization: "Bearer never-minted" } });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
    } finally {
      srv.stop();
    }
  });

  it("expired tokens cannot authenticate WS upgrades either", async () => {
    const registry = new TokenRegistry();
    registry.register("stale-ws", Date.now() - 1000);
    const srv = makeRouteServer(makeRouteDeps().deps, { secret: SEED, authRegistry: registry });
    try {
      const res = await srv.http("/v1/stream/video", {
        headers: {
          connection: "upgrade",
          upgrade: "websocket",
          authorization: "Bearer stale-ws",
        },
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("token_expired");
    } finally {
      srv.stop();
    }
  });
});

describe("credential hygiene — failed auth leaks nothing (task 1.6)", () => {
  const LEAK = "SUPER-SECRET-LEAK-VALUE";

  function spyConsole(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const originals = ["log", "error", "warn", "info"] as const;
    const stubs = originals.map((level) => {
      const original = console[level];
      console[level] = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
      return { level, original };
    });
    return {
      lines,
      restore: () => stubs.forEach(({ level, original }) => (console[level] = original)),
    };
  }

  it("invalid-bearer 401 body contains zero echo of the presented credential", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps, { secret: SEED });
    try {
      const res = await srv.http("/v1/state", { headers: { authorization: `Bearer ${LEAK}` } });
      expect(res.status).toBe(401);
      const raw = await res.text();
      expect(raw).not.toContain(LEAK);
      // The fixed message names no credential material at all.
      const body = JSON.parse(raw) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("unauthorized");
      expect(body.error.message).not.toContain("SUPER");
    } finally {
      srv.stop();
    }
  });

  it("bridge logs stay free of credential material during denied requests", async () => {
    const spy = spyConsole();
    try {
      const srv = makeRouteServer(makeRouteDeps().deps, { secret: SEED });
      try {
        await srv.http("/v1/state", { headers: { authorization: `Bearer ${LEAK}` } });
        await srv.http("/v1/state", { headers: { "x-openmobile-secret": LEAK } });
        await srv.http("/v1/stream/video", {
          headers: {
            connection: "upgrade",
            upgrade: "websocket",
            "sec-websocket-protocol": `openmobile.bearer.${LEAK}`,
          },
        });
        // The bridge is a silent daemon (design D6: "no echo/no log") — every
        // line that DOES appear (Bun internals included in-process) must be
        // free of credential material.
        for (const line of spy.lines) expect(line).not.toContain(LEAK);
      } finally {
        srv.stop();
      }
    } finally {
      spy.restore();
    }
  });

  it("error serialization never gains credential carriers", async () => {
    // A VALID seed reaches routing: any handler error text (404 echo of
    // method/path, INTERNAL_ERROR e.message, …) must stay credential-free —
    // neither the presented seed nor a bogus value may surface in bodies.
    const srv = makeRouteServer(makeRouteDeps().deps, { secret: SEED });
    try {
      const notFound = await srv.http("/v1/nope", { headers: { authorization: `Bearer ${SEED}` } });
      expect(notFound.status).toBe(404);
      const raw = await notFound.text();
      expect(raw).not.toContain(SEED);
      expect(raw).not.toContain("Bearer");
    } finally {
      srv.stop();
    }
  });
});

describe("CORS narrowing while authenticated (task 1.7, design D6)", () => {
  it("auth on + empty allow-list ⇒ evil Origin gets NO access-control-allow-origin", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps, { secret: SEED });
    try {
      const res = await srv.http("/v1/state", { headers: { origin: "https://evil.example" } });
      expect(res.status).toBe(401); // still gated
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      srv.stop();
    }
  });

  it("csv allow-list entries are reflected verbatim; others stay blocked", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps, {
      secret: SEED,
      allowedOriginsCsv: "https://good.example, https://also.example",
    });
    try {
      const good = await srv.http("/v1/state", { headers: { origin: "https://good.example" } });
      expect(good.status).toBe(401); // gated, but CORS-readable for the embedder
      expect(good.headers.get("access-control-allow-origin")).toBe("https://good.example");
      const also = await srv.http("/v1/state", { headers: { origin: "https://also.example" } });
      expect(also.headers.get("access-control-allow-origin")).toBe("https://also.example");
      const evil = await srv.http("/v1/state", { headers: { origin: "https://evil.example" } });
      expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      srv.stop();
    }
  });

  it("narrowed preflights keep 204 + methods but omit ACAO for non-allowlisted Origins", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps, {
      secret: SEED,
      allowedOriginsCsv: "https://good.example",
    });
    try {
      const evil = await srv.http("/v1/input/tap", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
      });
      expect(evil.status).toBe(204);
      expect(evil.headers.get("access-control-allow-origin")).toBeNull();
      expect(evil.headers.get("access-control-allow-methods")).toContain("POST");
      const good = await srv.http("/v1/input/tap", {
        method: "OPTIONS",
        headers: { origin: "https://good.example", "access-control-request-method": "POST" },
      });
      expect(good.headers.get("access-control-allow-origin")).toBe("https://good.example");
      // While auth is on, Authorization must be a permitted preflight header.
      expect(good.headers.get("access-control-allow-headers")).toContain("authorization");
    } finally {
      srv.stop();
    }
  });

  it("seed unset ⇒ legacy requestOrigin||'*' reflection untouched (csv ignored)", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps, {
      allowedOriginsCsv: "https://good.example",
    });
    try {
      const evil = await srv.http("/v1/state", { headers: { origin: "https://evil.example" } });
      expect(evil.status).toBe(200);
      expect(evil.headers.get("access-control-allow-origin")).toBe("https://evil.example");
      const noOrigin = await srv.http("/v1/state");
      expect(noOrigin.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      srv.stop();
    }
  });
});

describe("seed-unset goldens — byte-identical legacy surface (task 1.8)", () => {
  // Literals below were recorded from the PRE-CHANGE code via a probe run;
  // they pin status + headers + exact body bytes of every pre-existing /v1
  // route so the auth-seam refactor stays byte-identical when unset.
  it("GET /v1/state without Origin matches pre-change bytes", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps);
    try {
      const res = await srv.http("/v1/state");
      expect(res.status).toBe(200);
      expect([...res.headers.entries()]).toEqual([
        ["access-control-allow-origin", "*"],
        ["content-type", JSON_CT],
      ]);
      expect(await res.text()).toBe(
        '{"schema":"v1","bridge":{"version":"test","pid":1234},"selected":{"serial":"emulator-5554","state":"device","model":"Pixel_9_Pro"},"frame":null,"devices":[{"serial":"emulator-5554","state":"device","model":"Pixel_9_Pro"}],"emulators":[{"name":"Pixel_9_Pro","running":true}]}',
      );
    } finally {
      srv.stop();
    }
  });

  it("GET /v1/state with Origin reflects it (legacy CORS untouched)", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps);
    try {
      const res = await srv.http("/v1/state", { headers: { origin: "https://good.example" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://good.example");
      expect(await res.text()).toBe(
        '{"schema":"v1","bridge":{"version":"test","pid":1234},"selected":{"serial":"emulator-5554","state":"device","model":"Pixel_9_Pro"},"frame":null,"devices":[{"serial":"emulator-5554","state":"device","model":"Pixel_9_Pro"}],"emulators":[{"name":"Pixel_9_Pro","running":true}]}',
      );
    } finally {
      srv.stop();
    }
  });

  it("POST /v1/input/tap success/422/400 match pre-change bytes", async () => {
    const { deps, state } = makeRouteDeps();
    const srv = makeRouteServer(deps);
    try {
      const ok = await srv.http("/v1/input/tap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: 100, y: 200 }),
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("access-control-allow-origin")).toBe("*");
      expect(await ok.text()).toBe('{"ok":true,"x":100,"y":200,"serial":"emulator-5554"}');
      expect(state.taps).toEqual([{ s: "emulator-5554", x: 100, y: 200 }]);

      const v422 = await srv.http("/v1/input/tap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ y: 200 }),
      });
      expect(v422.status).toBe(422);
      expect(await v422.text()).toBe(
        '{"error":{"code":"VALIDATION_ERROR","message":"field \'x\' must be a finite number","details":"x"}}',
      );

      const b400 = await srv.http("/v1/input/tap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(b400.status).toBe(400);
      expect(await b400.text()).toBe(
        '{"error":{"code":"BAD_REQUEST","message":"request body is not valid JSON"}}',
      );
    } finally {
      srv.stop();
    }
  });

  it("POST /v1/input/swipe 422 and /v1/input/text ok match pre-change bytes", async () => {
    const { deps, state } = makeRouteDeps();
    const srv = makeRouteServer(deps);
    try {
      const swipe = await srv.http("/v1/input/swipe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x1: 0 }),
      });
      expect(swipe.status).toBe(422);
      expect(await swipe.text()).toBe(
        '{"error":{"code":"VALIDATION_ERROR","message":"field \'y1\' must be a finite number","details":"y1"}}',
      );

      const text = await srv.http("/v1/input/text", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      expect(text.status).toBe(200);
      expect(await text.text()).toBe('{"ok":true,"serial":"emulator-5554"}');
      expect(state.texts).toEqual([{ s: "emulator-5554", t: "hello" }]);
    } finally {
      srv.stop();
    }
  });

  it("GET /v1/screenshot matches pre-change bytes and headers", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps);
    try {
      const res = await srv.http("/v1/screenshot");
      expect(res.status).toBe(200);
      expect([...res.headers.entries()].sort()).toEqual([
        ["access-control-allow-origin", "*"],
        ["content-type", "image/png"],
        ["x-device-height", "2"],
        ["x-device-width", "2"],
      ]);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes.length).toBe(96);
      expect(bytes[0]).toBe(137); // PNG magic preserved byte-for-byte
    } finally {
      srv.stop();
    }
  });

  it("unknown routes keep the exact legacy NOT_FOUND bytes", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps);
    try {
      const r1 = await srv.http("/v1/nope");
      expect(r1.status).toBe(404);
      expect(await r1.text()).toBe(
        '{"error":{"code":"NOT_FOUND","message":"no route for GET /v1/nope"}}',
      );
      const r2 = await srv.http("/healthz");
      expect(r2.status).toBe(404);
      expect(await r2.text()).toBe(
        '{"error":{"code":"NOT_FOUND","message":"no route for GET /healthz"}}',
      );
    } finally {
      srv.stop();
    }
  });

  it("OPTIONS preflight keeps the exact legacy 204 header set", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps);
    try {
      const res = await srv.http("/v1/input/tap", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:5180", "access-control-request-method": "POST" },
      });
      expect(res.status).toBe(204);
      expect([...res.headers.entries()].sort()).toEqual([
        ["access-control-allow-headers", "content-type, x-openmobile-secret"],
        ["access-control-allow-methods", "GET, POST, OPTIONS"],
        ["access-control-allow-origin", "http://localhost:5180"],
      ]);
      expect(await res.text()).toBe("");
    } finally {
      srv.stop();
    }
  });

  it("POST /v1/auth/token with seed unset returns the legacy 404 bytes (never registered)", async () => {
    const srv = makeRouteServer(makeRouteDeps().deps);
    try {
      const res = await srv.http("/v1/auth/token", { method: "POST" });
      expect(res.status).toBe(404);
      expect([...res.headers.entries()].sort()).toEqual([
        ["access-control-allow-origin", "*"],
        ["content-type", JSON_CT],
      ]);
      expect(await res.text()).toBe(
        '{"error":{"code":"NOT_FOUND","message":"no route for POST /v1/auth/token"}}',
      );
    } finally {
      srv.stop();
    }
  });
});
