/**
 * bridge-auth suite (bridge-surface-v2 Phase 1 — design D2/D6).
 *
 * Unit half: AuthConfig parsing (seed + TTL knobs), SHA-256 hashing with
 * timing-safe comparison, the hashed token registry, and WS subprotocol
 * credential extraction. Route-level contracts live in bridge-routes.test.ts.
 */
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_TOKEN_TTL_MAX_SECONDS,
  DEFAULT_TOKEN_TTL_SECONDS,
  TOKEN_BYTES,
  clampTtlSeconds,
  constantTimeHex,
  generateToken,
  parseAuthConfig,
  sha256Hex,
  subprotocolCredential,
  TokenRegistry,
} from "../src/bridge/auth";
import { createBridgeApp } from "../src/bridge/server";
import type { BridgeDeps, StreamGateway, StreamStateView, StreamSubscribeResult } from "../src/bridge/server";
import type { Device } from "../src/device/types";

describe("parseAuthConfig — env knobs (task 1.1)", () => {
  it("enables auth when OPENMOBILE_BRIDGE_SECRET is set, storing ONLY its SHA-256 hash", () => {
    const cfg = parseAuthConfig({ OPENMOBILE_BRIDGE_SECRET: "hunter2" });
    expect(cfg.enabled).toBe(true);
    // Known vector: sha256("hunter2") — raw seed never retained anywhere.
    expect(cfg.seedHash).toBe("f52fbd32b2b3b86ff88ef6c490628285f482af15ddcb29541f94bcf526a3f6c7");
    expect(cfg.seedHash).not.toContain("hunter2");
    expect(cfg.ttlDefaultSeconds).toBe(DEFAULT_TOKEN_TTL_SECONDS);
    expect(cfg.ttlMaxSeconds).toBe(DEFAULT_TOKEN_TTL_MAX_SECONDS);
  });

  it("defaults TTL knobs to 3600 / 86400", () => {
    expect(DEFAULT_TOKEN_TTL_SECONDS).toBe(3600);
    expect(DEFAULT_TOKEN_TTL_MAX_SECONDS).toBe(86400);
    const cfg = parseAuthConfig({ OPENMOBILE_BRIDGE_SECRET: "s3cr3t" });
    expect(cfg.ttlDefaultSeconds).toBe(3600);
    expect(cfg.ttlMaxSeconds).toBe(86400);
  });

  it("parses explicit TTL overrides", () => {
    const cfg = parseAuthConfig({
      OPENMOBILE_BRIDGE_SECRET: "s3cr3t",
      OPENMOBILE_BRIDGE_TOKEN_TTL: "120",
      OPENMOBILE_BRIDGE_TOKEN_TTL_MAX: "7200",
    });
    expect(cfg.ttlDefaultSeconds).toBe(120);
    expect(cfg.ttlMaxSeconds).toBe(7200);
  });

  it("throws on non-integer or out-of-range TTL values (fail fast at startup)", () => {
    // Blank mirrors the resolvePort precedent: unset-or-blank ⇒ default.
    for (const bad of ["abc", "90.5", "0", "-10"]) {
      expect(() =>
        parseAuthConfig({ OPENMOBILE_BRIDGE_SECRET: "s", OPENMOBILE_BRIDGE_TOKEN_TTL: bad! }),
      ).toThrow(/OPENMOBILE_BRIDGE_TOKEN_TTL/);
      expect(() =>
        parseAuthConfig({ OPENMOBILE_BRIDGE_SECRET: "s", OPENMOBILE_BRIDGE_TOKEN_TTL_MAX: bad! }),
      ).toThrow(/OPENMOBILE_BRIDGE_TOKEN_TTL_MAX/);
    }
  });

  it("treats blank TTL values as unset (resolvePort precedent)", () => {
    const cfg = parseAuthConfig({
      OPENMOBILE_BRIDGE_SECRET: "s",
      OPENMOBILE_BRIDGE_TOKEN_TTL: "",
      OPENMOBILE_BRIDGE_TOKEN_TTL_MAX: "",
    });
    expect(cfg.ttlDefaultSeconds).toBe(3600);
    expect(cfg.ttlMaxSeconds).toBe(86400);
  });

  it("seed unset (missing or empty) ⇒ disabled fast path", () => {
    expect(parseAuthConfig({}).enabled).toBe(false);
    expect(parseAuthConfig({ OPENMOBILE_BRIDGE_SECRET: "" }).enabled).toBe(false);
    const disabled = parseAuthConfig({});
    expect(disabled.seedHash).toBe("");
  });
});

describe("sha256Hex + constantTimeHex (timing-safe core, task 1.6)", () => {
  it("hashes UTF-8 input to lowercase hex", () => {
    expect(sha256Hex("s3cr3t")).toBe(
      "4e738ca5563c06cfd0018299933d58db1dd8bf97f6973dc99bf6cdc64b5550bd",
    );
  });

  it("constantTimeHex accepts equal digests and rejects differing ones", () => {
    const a = sha256Hex("hunter2");
    expect(constantTimeHex(a, a)).toBe(true);
    expect(constantTimeHex(a, sha256Hex("hunter3"))).toBe(false);
  });
});

// ─── WS upgrade harness (real Bun.serve, port 0) ────────────────────────────

function wsDeps(overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  const devices: Device[] = [{ serial: "emulator-5554", state: "device" }];
  return {
    bridge: { version: "test", pid: 1234 },
    adb: {
      devices: async () => devices,
      inputTap: async () => {},
      inputSwipe: async () => {},
      inputText: async () => {},
    },
    cli: { emulatorList: async () => [], capture: async () => {} },
    env: {},
    readFile: async () => new Uint8Array(0),
    tempPngPath: () => "/tmp/om-ws-auth.png",
    ...overrides,
  };
}

/** Minimal gateway keeping upgraded video sockets open (auth is the subject). */
const openGateway: StreamGateway = {
  snapshot(): StreamStateView {
    return { supported: true, active: true, viewers: 0 };
  },
  async subscribeVideo(): Promise<StreamSubscribeResult> {
    return { ok: true, viewerId: "v1" };
  },
  unsubscribeVideo(): void {},
  controlActive() {
    return null;
  },
};

function wsServer(deps: BridgeDeps, opts?: { secret?: string; authRegistry?: TokenRegistry }) {
  const app = createBridgeApp(deps, opts);
  const server = Bun.serve<Record<string, unknown>>({ port: 0, fetch: app.fetch, websocket: app.websocket });
  return {
    // Bun assigns the real ephemeral port once listening; type says `?`.
    port: server.port ?? 0,
    /** Upgrade attempt at the HTTP layer — a 401 Response proves no socket. */
    upgradeRequest: (path: string, headers: Record<string, string>) =>
      server.fetch(new Request(`http://127.0.0.1:${server.port}${path}`, { headers })),
    stop: () => server.stop(),
  };
}

function platformConnect(
  port: number,
  path: string,
  protocols?: string[],
  headers?: Record<string, string>,
): Promise<{ protocol: string }> {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}${path}`;
    const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url, { headers });
    ws.addEventListener("open", () => {
      resolve({ protocol: ws.protocol });
      ws.close();
    });
    ws.addEventListener("error", () => reject(new Error("handshake failed")));
  });
}

describe("WS subprotocol authentication at upgrade (task 1.5, design D1)", () => {
  const SEED = "s3cr3t";

  it("valid openmobile.bearer.<T> entry upgrades and is ECHOED explicitly over a competing offer", async () => {
    const registry = new TokenRegistry();
    const srv = wsServer(wsDeps({ streamGateway: openGateway }), { secret: SEED, authRegistry: registry });
    try {
      // Direct mint into the injected registry keeps this test focused on the
      // upgrade path (issuance is covered by bridge-routes.test.ts).
      registry.register("T", Date.now() + 60_000);
      // ["chat", cred] offer: without an explicit echo Bun would auto-pick
      // "chat" (SPIKE-1 fact b). Negotiated protocol MUST be our validated
      // entry instead — proof the echo header landed exactly once.
      const opened = await platformConnect(srv.port, "/v1/stream/video", [
        "chat",
        "openmobile.bearer.T",
      ]);
      expect(opened.protocol).toBe("openmobile.bearer.T");
    } finally {
      srv.stop();
    }
  });

  it("wrong subprotocol credential ⇒ 401 JSON Response WITHOUT server.upgrade()", async () => {
    const srv = wsServer(wsDeps({ streamGateway: openGateway }), { secret: SEED });
    try {
      const res = await srv.upgradeRequest("/v1/stream/video", {
        connection: "upgrade",
        upgrade: "websocket",
        "sec-websocket-protocol": "openmobile.bearer.wrong",
      });
      expect(res.status).toBe(401); // failed handshake, never an open socket
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("unauthorized");
      await expect(
        platformConnect(srv.port, "/v1/stream/video", ["openmobile.bearer.wrong"]),
      ).rejects.toThrow("handshake failed");
    } finally {
      srv.stop();
    }
  });

  it("missing credential at upgrade ⇒ 401 (no header, no subprotocol, no query)", async () => {
    const srv = wsServer(wsDeps({ streamGateway: openGateway }), { secret: SEED });
    try {
      const res = await srv.upgradeRequest("/v1/stream/video", {
        connection: "upgrade",
        upgrade: "websocket",
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
    } finally {
      srv.stop();
    }
  });

  it("expired subprotocol credential ⇒ 401 token_expired", async () => {
    const registry = new TokenRegistry();
    registry.register("stale", Date.now() - 1000);
    const srv = wsServer(wsDeps({ streamGateway: openGateway }), { secret: SEED, authRegistry: registry });
    try {
      const res = await srv.upgradeRequest("/v1/stream/video", {
        connection: "upgrade",
        upgrade: "websocket",
        "sec-websocket-protocol": "openmobile.bearer.stale",
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("token_expired");
    } finally {
      srv.stop();
    }
  });

  it("?token=T query is treated as NO credential — refused exactly like none", async () => {
    const registry = new TokenRegistry();
    registry.register("T", Date.now() + 60_000);
    const srv = wsServer(wsDeps({ streamGateway: openGateway }), { secret: SEED, authRegistry: registry });
    try {
      const res = await srv.upgradeRequest("/v1/stream/video?token=T", {
        connection: "upgrade",
        upgrade: "websocket",
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
    } finally {
      srv.stop();
    }
  });

  it("legacy X-OpenMobile-Secret header still authenticates the upgrade", async () => {
    const srv = wsServer(wsDeps({ streamGateway: openGateway }), { secret: SEED });
    try {
      const opened = await platformConnect(srv.port, "/v1/stream/video", undefined, {
        "x-openmobile-secret": SEED,
      });
      expect(opened.protocol).toBe(""); // no subprotocol offered → none echoed
    } finally {
      srv.stop();
    }
  });

  it("seed unset ⇒ upgrades stay credential-less (legacy fast path)", async () => {
    const srv = wsServer(wsDeps({ streamGateway: openGateway }));
    try {
      const opened = await platformConnect(srv.port, "/v1/stream/video");
      expect(opened.protocol).toBe("");
      const res = await srv.upgradeRequest("/v1/stream/control", {
        connection: "upgrade",
        upgrade: "websocket",
      });
      // No auth + no active stream ⇒ reaches the STREAM_OFF branch (409), not 401.
      expect(res.status).toBe(409);
    } finally {
      srv.stop();
    }
  });
});

describe("subprotocolCredential extraction (unit)", () => {
  const reqWith = (headers: Record<string, string>) => new Request("http://127.0.0.1/x", { headers });

  it("scans a multi-entry offer for the exact openmobile.bearer.<cred> entry", () => {
    const hit = subprotocolCredential(reqWith({ "sec-websocket-protocol": "chat, openmobile.bearer.T" }));
    expect(hit?.entry).toBe("openmobile.bearer.T");
    expect(hit?.credential).toBe("T");
  });

  it("returns null for non-matching or bare-prefix offers", () => {
    expect(subprotocolCredential(reqWith({ "sec-websocket-protocol": "chat, other.proto" }))).toBeNull();
    expect(subprotocolCredential(reqWith({ "sec-websocket-protocol": "openmobile.bearer." }))).toBeNull();
    expect(subprotocolCredential(reqWith({}))).toBeNull();
  });
});
