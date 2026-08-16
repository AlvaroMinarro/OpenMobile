import { escapeForAdb, InputError } from "../device/input";
import { tempPngPath } from "../device/temp";
import { rm } from "node:fs/promises";
import type { AVD, Device } from "../device/types";
import {
  WS_CLOSE_CODES,
  type ControlErrorMessage,
  type StreamStateMessage,
  type StreamViewer,
  type VideoHandshake,
} from "../stream/types";
import {
  sendControlEvent,
  ControlError,
} from "../stream/control";

/**
 * The `/v1` loopback HTTP bridge daemon (SDD Phase 4 — locked D2 contract).
 *
 * Loopback (127.0.0.1) is the trust boundary; no shared-secret header is
 * required by default. An optional `secret` can be enabled (env-gated in
 * `main.ts`) and then every request MUST carry it in `X-OpenMobile-Secret`.
 *
 * Error body shape (all non-2xx):
 *   { "error": { "code": string, "message": string, "details"?: unknown } }
 * Status codes: 400 bad request, 404 unknown route, 409 conflict/offline,
 * 422 validation, 500 internal.
 */

/** Narrow dependency surface the bridge needs from the device core. */
export interface BridgeDeps {
  /** Self-describing bridge metadata (locked contract: surfaced in /v1/state). */
  bridge: { version: string; pid: number };
  adb: {
    devices(): Promise<Device[]>;
    inputTap(serial: string, x: number, y: number): Promise<void>;
    inputSwipe(
      serial: string,
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      duration?: number,
    ): Promise<void>;
    inputText(serial: string, text: string): Promise<void>;
  };
  cli: {
    emulatorList(): Promise<AVD[]>;
    capture(
      target: { serial: string; outPath: string },
    ): Promise<void>;
  };
  env: Record<string, string>;
  /** Embargo for reading capture output bytes (defaults in `main.ts`). */
  readFile: (path: string) => Promise<Uint8Array>;
  /** Unique temp PNG path for a capture kind+serial (defaults to /tmp/om-<kind>-<serial>-<ts>-<rand6>.png). */
  tempPngPath: (kind: string, serial: string) => string;
  /**
   * Live stream status surfaced under `stream` in /v1/state (design D6).
   * Absent → the bridge runs without streaming (backward compatible).
   * Implementations must return `supported:false` when OPENMOBILE_STREAM=off.
   */
  streamStatusProvider?: () => StreamStateView;
  /**
   * Stream subsystem for the WS routes (design D2/D3/D5). When absent, the
   * WS /v1/stream/* routes are rejected with 404 (no streaming deployed).
   * The bridge only consumes this narrow contract:
   *  - subscribeVideo → a StreamViewer the daemon will feed (handshake
   *    first, then binary AUs; the viewer's close() means session ending),
   *  - unsubscribeVideo → release the viewer,
   *  - controlActive → the ACTIVE session's control writer (null = none),
   *  - snapshot → additive /v1/state stream object (used when
   *    streamStatusProvider is absent; provider wins when both present).
   */
  streamGateway?: StreamGateway;
}

/**
 * Stream subsystem contract the WS routes consume (design D2/D3/D5).
 * Implemented by the daemon wiring in main.ts (slice 2B).
 */
export type StreamSubscribeResult =
  | { ok: true; viewerId: string }
  | {
      ok: false;
      code: "UNSUPPORTED" | "CAP_REACHED" | "NO_DEVICE";
      reason?: string;
    };

export interface StreamGateway {
  /** Current additive /v1/state stream object. */
  snapshot(): StreamStateView;
  /**
   * Register a video viewer. The bridge PASSES the socket-facing viewer; the
   * gateway (via its fanout) broadcasts into it: sendHandshake (JSON) first,
   * then sendFrame (binary AU) per access unit; when the session ends the
   * gateway's teardown calls viewer.close() (the bridge closes 4409).
   * Returns UNSUPPORTED (kill-switch off), CAP_REACHED (design D4, 8 max),
   * or NO_DEVICE (start failed) — the bridge maps these onto close codes.
   */
  subscribeVideo(viewer: StreamViewer): Promise<StreamSubscribeResult>;
  /** Release a video viewer (last release may tear the session down). */
  unsubscribeVideo(viewerId: string): void;
  /**
   * The ACTIVE session's control writer, or null when no stream is up.
   * The control route sends scrcpy bytes through `write` after validation.
   */
  controlActive(): { video: { width: number; height: number }; write: (bytes: Buffer[]) => Promise<void> } | null;
}

/** Additive `stream` object in /v1/state (design D6; locked contract delta). */
export interface StreamStateView {
  supported: boolean;
  active: boolean;
  reason?: string;
  viewers: number;
  /** Video size of the active stream (present once the handshake landed). */
  width?: number;
  height?: number;
}

export interface BridgeOptions {
  /** Optional shared secret; when set, `X-OpenMobile-Secret` must match. */
  secret?: string;
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

const JSON_CT = "application/json; charset=utf-8";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_CT },
  });
}

function error(status: number, code: string, message: string, details?: unknown): Response {
  const body: ErrorBody = {
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
  return json(status, body);
}

/** HTTP-equivalent typed error raised inside handlers. */
class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function notFound(method: string, path: string): Response {
  return error(404, "NOT_FOUND", `no route for ${method} ${path}`);
}

/** Resolve the target serial: explicit arg > ANDROID_DEVICE env > auto-detect. */
async function resolveSerial(
  deps: BridgeDeps,
  explicit?: string,
): Promise<{ serial: string; device?: Device }> {
  if (explicit) return { serial: explicit };
  const devices = await deps.adb.devices();
  const env = deps.env["ANDROID_DEVICE"];
  if (env) {
    return { serial: env, device: devices.find((d) => d.serial === env) };
  }
  if (devices.length === 0) {
    throw new HttpError(409, "NO_DEVICE", "no Android device attached");
  }
  if (devices.length > 1) {
    const serials = devices.map((d) => d.serial);
    throw new HttpError(
      409,
      "AMBIGUOUS_DEVICE",
      "multiple devices attached; pass ?device=SERIAL or set ANDROID_DEVICE",
      serials,
    );
  }
  const only = devices[0]!;
  if (only.state !== "device") {
    throw new HttpError(
      409,
      "DEVICE_OFFLINE",
      `device ${only.serial} is in state '${only.state}' (requires 'device')`,
    );
  }
  return { serial: only.serial, device: only };
}

/** Require a usable (state 'device') auto-detected target. */
async function requireUsable(deps: BridgeDeps, explicit?: string): Promise<string> {
  const { serial, device } = await resolveSerial(deps, explicit);
  if (!explicit) {
    if (!device || device.state !== "device") {
      throw new HttpError(409, "DEVICE_OFFLINE", `device ${serial} is not in state 'device'`);
    }
  }
  return serial;
}

async function requireJson(req: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "could not read request body");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "request body must be a JSON object",
    );
  }
  return parsed as Record<string, unknown>;
}

function needNumber(body: Record<string, unknown>, field: string): number {
  const v = body[field];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new HttpError(422, "VALIDATION_ERROR", `field '${field}' must be a finite number`, field);
  }
  return v;
}

function readOptionalNumber(body: Record<string, unknown>, field: string): number | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new HttpError(422, "VALIDATION_ERROR", `field '${field}' must be a finite number`, field);
  }
  return v;
}

async function handleState(deps: BridgeDeps, explicit?: string): Promise<Response> {
  // Always 200 (locked contract): enumeration failures (adb/CLI missing, etc.)
  // degrade to empty lists instead of surfacing a 500.
  const [devices, emulators] = await Promise.all([
    deps.adb.devices().catch(() => [] as Device[]),
    deps.cli.emulatorList().catch(() => [] as AVD[]),
  ]);
  let selected: Device | null = null;
  if (explicit) {
    selected = devices.find((d) => d.serial === explicit) ?? {
      serial: explicit,
      state: "device",
    };
  } else {
    const env = deps.env["ANDROID_DEVICE"];
    if (env) {
      selected = devices.find((d) => d.serial === env) ?? { serial: env, state: "device" };
    } else if (devices.length === 1) {
      selected = devices[0]!;
    }
  }
  // `frame` is reserved for future annotated-screen content; always null today.
  // `bridge` self-describes the daemon (locked contract); `schema` pins the shape.
  // `stream` is additive (design D6): present only when a provider is wired,
  // so pre-streaming deployments stay byte-identical. A streamGateway (slice
  // 2B) also supplies the snapshot when no standalone provider is present.
  const stream =
    (deps.streamStatusProvider ? deps.streamStatusProvider() : undefined) ??
    (deps.streamGateway ? deps.streamGateway.snapshot() : undefined);
  return json(200, {
    schema: "v1",
    bridge: deps.bridge,
    selected,
    frame: null,
    devices,
    emulators,
    ...(stream !== undefined ? { stream } : {}),
  });
}

async function handleScreenshot(deps: BridgeDeps, explicit: string | undefined, url: URL): Promise<Response> {
  const serial = await requireUsable(deps, explicit);
  const path = deps.tempPngPath("br", serial);
  try {
    await deps.cli.capture({ serial, outPath: path });
    const bytes = await deps.readFile(path);
    // Optional downscale/JPEG params (V2 surface live mode). Defaults stay
    // PNG-full for contract compatibility; the surface asks for a compact
    // JPEG via query params to cut transfer size and decode cost.
    const maxWidth = readOptionalPositiveInt(url.searchParams.get("maxWidth"));
    const quality = readOptionalBoundedInt(url.searchParams.get("quality"), 10, 95, 80);
    const format = url.searchParams.get("format");
    let body: Uint8Array = bytes;
    let contentType = "image/png";
    // Original capture dimensions — the surface needs them for correct
    // click→device-coordinate mapping when the image is downscaled.
    let originalWidth = bytes.length; // placeholder, replaced by sharp metadata below when re-encoding
    let originalHeight = bytes.length;
    if (format === "jpeg" || maxWidth !== undefined) {
      const sharp = (await import("sharp")).default;
      const img = sharp(bytes).rotate();
      const meta = await img.metadata();
      originalWidth = meta.width ?? 0;
      originalHeight = meta.height ?? 0;
      let pipeline = img;
      if (maxWidth !== undefined) pipeline = pipeline.resize({ width: maxWidth });
      if (format === "jpeg") {
        pipeline = pipeline.jpeg({ quality });
        contentType = "image/jpeg";
      }
      body = new Uint8Array(await pipeline.toBuffer());
    } else {
      // PNG-full path: still parse dims for the size headers (cheap metadata read).
      const sharp = (await import("sharp")).default;
      const meta = await sharp(bytes).metadata();
      originalWidth = meta.width ?? 0;
      originalHeight = meta.height ?? 0;
    }
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": contentType,
        "x-device-width": String(originalWidth),
        "x-device-height": String(originalHeight),
      },
    });
  } finally {
    // Temp PNG hygiene (D7): delete after the bytes are read — failure too.
    await rm(path, { force: true }).catch(() => {});
  }
}

/** Parse a positive int query param, undefined when absent/invalid. */
function readOptionalPositiveInt(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Parse an int bounded to [min,max], defaulting to `fallback` when absent/invalid. */
function readOptionalBoundedInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

async function handleTap(deps: BridgeDeps, explicit: string | undefined, req: Request): Promise<Response> {
  const body = await requireJson(req);
  const x = needNumber(body, "x");
  const y = needNumber(body, "y");
  const serial = await requireUsable(deps, explicit);
  await deps.adb.inputTap(serial, x, y);
  return json(200, { ok: true, x, y, serial });
}

async function handleSwipe(
  deps: BridgeDeps,
  explicit: string | undefined,
  req: Request,
): Promise<Response> {
  const body = await requireJson(req);
  const x1 = needNumber(body, "x1");
  const y1 = needNumber(body, "y1");
  const x2 = needNumber(body, "x2");
  const y2 = needNumber(body, "y2");
  const durationMs = readOptionalNumber(body, "durationMs");
  const serial = await requireUsable(deps, explicit);
  await deps.adb.inputSwipe(serial, x1, y1, x2, y2, durationMs);
  return json(200, { ok: true, serial });
}

async function handleText(deps: BridgeDeps, explicit: string | undefined, req: Request): Promise<Response> {
  const body = await requireJson(req);
  const raw = body["text"];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "field 'text' must be a non-empty string", "text");
  }
  // Validate injectability through the device-core rule before dispatching.
  let serial: string;
  try {
    escapeForAdb(raw);
  } catch (e) {
    const message = e instanceof InputError ? e.message : "text cannot be injected";
    throw new HttpError(422, "VALIDATION_ERROR", message);
  }
  serial = await requireUsable(deps, explicit);
  await deps.adb.inputText(serial, raw);
  return json(200, { ok: true, serial });
}

/** Built bridge app: REST fetch handler + WS handler table for Bun.serve. */
export interface BridgeApp {
  fetch: (req: Request, server: Bun.Server<Record<string, unknown>>) => Promise<Response>;
  websocket: Bun.WebSocketHandler<Record<string, unknown>>;
}

/** The per-connection state the WS handlers carry. */
interface WsConn {
  /** "video" or "control". */
  kind: "video" | "control";
  /** Gateway viewer id (video route) or the control writer (control route). */
  viewerId?: string;
}

/** Reject an upgrade with a close code + a JSON error body (design §WS Contract). */
function wsReject(ws: Bun.ServerWebSocket<Record<string, unknown>>, code: number, message: string): void {
  const body = { error: { code: errorCodeForClose(code), message } };
  ws.send(JSON.stringify(body));
  ws.close(code, message);
}

function errorCodeForClose(code: number): string {
  switch (code) {
    case WS_CLOSE_CODES.UNSUPPORTED:
      return "STREAM_UNSUPPORTED";
    case WS_CLOSE_CODES.NO_DEVICE:
      return "STREAM_NO_DEVICE";
    case WS_CLOSE_CODES.VIEWER_CAP:
      return "VIEWER_CAP";
    case WS_CLOSE_CODES.DEVICE_LOST:
      return "DEVICE_LOST";
    default:
      return "STREAM_ERROR";
  }
}

/**
 * Build the bridge app: REST fetch handler + WS upgrade handling on the
 * /v1/stream/* routes. `main.ts` binds it to loopback via Bun.serve with an
 * in-memory handler over the same port; tests call the fetch/upgrade paths
 * through Bun.serve directly. Backward compatible: `createBridgeHandler`,
 * the old name, is preserved as a thin wrapper delegating to the fetch half.
 */
export function createBridgeApp(deps: BridgeDeps, opts: BridgeOptions = {}): BridgeApp {
  const corsHeaders = (allowOrigin: string) => ({
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-openmobile-secret",
  });

  /** REST-only handler (no WS): the routing table for every non-upgrade req. */
  const rest = buildRestHandler(deps);

  const websocket: Bun.WebSocketHandler<Record<string, unknown>> = {
    open(ws) {
      const conn = ws.data as unknown as WsConn;
      if (conn.kind === "video") void onVideoOpen(ws);
      // control route does nothing on open (validated at upgrade)
    },
    message(ws, msg) {
      const conn = ws.data as unknown as WsConn;
      if (conn.kind === "control") void onControlMessage(ws, msg);
    },
    close(ws, code, reason) {
      const conn = ws.data as unknown as WsConn;
      if (conn.kind === "video" && conn.viewerId) {
        deps.streamGateway?.unsubscribeVideo(conn.viewerId);
      }
      void code;
      void reason;
    },
  };

  async function onVideoOpen(ws: Bun.ServerWebSocket<Record<string, unknown>>): Promise<void> {
    const gw = deps.streamGateway;
    if (!gw) {
      ws.close(WS_CLOSE_CODES.UNSUPPORTED, "streaming not deployed");
      return;
    }
    const snap = gw.snapshot();
    if (!snap.supported) {
      wsReject(ws, WS_CLOSE_CODES.UNSUPPORTED, snap.reason ?? "streaming unsupported");
      return;
    }
    // Socket-facing viewer: the gateway's fanout broadcasts INTO it. The
    // bridge maps the viewer's close() (session teardown) onto 4409, and the
    // sendHandshake/sendFrame/sendState calls onto WS text/binary frames.
    const socketViewer: StreamViewer = {
      id: crypto.randomUUID(),
      sendHandshake: (h) => {
        ws.send(JSON.stringify(h));
        return Promise.resolve();
      },
      sendFrame: (f) => {
        ws.send(f);
        return Promise.resolve();
      },
      sendState: (s) => {
        ws.send(JSON.stringify(s));
        return Promise.resolve();
      },
      get open() {
        return ws.readyState === 1; // OPEN
      },
      close: () => {
        // Session ended (device lost / stream teardown) — tell the client.
        if (ws.readyState === 1) ws.close(WS_CLOSE_CODES.DEVICE_LOST, "device lost");
      },
    };
    const result = await gw.subscribeVideo(socketViewer);
    if (!result.ok) {
      if (result.code === "CAP_REACHED") {
        wsReject(ws, WS_CLOSE_CODES.VIEWER_CAP, result.reason ?? "viewer cap reached (8)");
      } else if (result.code === "UNSUPPORTED") {
        wsReject(ws, WS_CLOSE_CODES.UNSUPPORTED, result.reason ?? "streaming unsupported");
      } else {
        wsReject(ws, WS_CLOSE_CODES.NO_DEVICE, result.reason ?? "no usable device for streaming");
      }
      return;
    }
    (ws.data as unknown as WsConn).viewerId = result.viewerId;
    // The handshake + frames flow through sendHandshake/sendFrame once the
    // daemon's session is up. Nothing more to do here.
  }

  async function onControlMessage(ws: Bun.ServerWebSocket<Record<string, unknown>>, raw: unknown): Promise<void> {
    const text = typeof raw === "string" ? raw : Buffer.from(raw as Uint8Array).toString("utf8");
    if (deps.streamGateway === undefined) {
      wsReject(ws, WS_CLOSE_CODES.UNSUPPORTED, "streaming not deployed");
      return;
    }
    const active = deps.streamGateway.controlActive();
    try {
      const result = await sendControlEvent(
        active
          ? { video: active.video, writer: (b: Buffer[]) => active.write(b) }
          : undefined,
        text,
      );
      if (result.ok) {
        ws.send(JSON.stringify({ type: "ack" }));
      } else {
        wsReject(ws, WS_CLOSE_CODES.NO_DEVICE, result.reason);
      }
    } catch (e) {
      // Validation failures (ControlError) are JSON errors, NOT closes.
      if (e instanceof ControlError) {
        const body: ControlErrorMessage = { type: "error", code: e.code, message: e.message };
        ws.send(JSON.stringify(body));
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      ws.send(JSON.stringify({ type: "error", code: "INJECTION_FAILED", message }));
    }
  }

  const app: BridgeApp = {
    fetch: async (req, server) => {
      const url = new URL(req.url);
      const path = url.pathname;
      // CORS preflight answers for BOTH REST and WS routes (browsers send
      // OPTIONS before the upgrade as well).
      const requestOrigin = req.headers.get("origin");
      const allowOrigin = requestOrigin || "*";
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
      }
      // WS upgrades: /v1/stream/video + /v1/stream/control.
      if (path === "/v1/stream/video" || path === "/v1/stream/control") {
        // Secret gate for WS upgrades exactly like REST (loopback default off).
        if (opts.secret !== undefined && opts.secret !== "") {
          const provided = req.headers.get("x-openmobile-secret");
          if (provided !== opts.secret) {
            return error(401, "UNAUTHORIZED", "missing or invalid X-OpenMobile-Secret header");
          }
        }
        // No gateway → 404 (streaming not deployed).
        if (!deps.streamGateway) {
          return notFound(req.method, path);
        }
        const kind: WsConn["kind"] = path === "/v1/stream/video" ? "video" : "control";
        if (kind === "control") {
          // Control-without-stream rejects at UPGRADE (spec: Control without
          // stream → rejected and closed, never a silent hang).
          const active = deps.streamGateway.controlActive();
          if (!active) {
            const res = error(
              409,
              "STREAM_OFF",
              "no active stream; use /v1/input REST fallback",
            );
            const headers = new Headers(res.headers);
            headers.set("access-control-allow-origin", allowOrigin);
            return new Response(res.body, { status: res.status, headers });
          }
        }
        const upgraded = server.upgrade(req, { data: { kind } as unknown as Record<string, unknown> });
        if (!upgraded) {
          const res = error(400, "BAD_REQUEST", "WebSocket upgrade failed");
          const headers = new Headers(res.headers);
          headers.set("access-control-allow-origin", allowOrigin);
          return new Response(res.body, { status: res.status, headers });
        }
        return new Response(null, { status: 101 });
      }
      // Everything else → REST.
      // Optional shared-secret gate (OFF by default: loopback is the trust
      // boundary). Same rule as the old createBridgeHandler — REST requests
      // carry X-OpenMobile-Secret when the secret is configured.
      if (opts.secret !== undefined && opts.secret !== "") {
        const provided = req.headers.get("x-openmobile-secret");
        if (provided !== opts.secret) {
          const res = error(401, "UNAUTHORIZED", "missing or invalid X-OpenMobile-Secret header");
          const headers = new Headers(res.headers);
          headers.set("access-control-allow-origin", allowOrigin);
          return new Response(res.body, { status: res.status, headers });
        }
      }
      const res = await rest(req);
      const headers = new Headers(res.headers);
      headers.set("access-control-allow-origin", allowOrigin);
      return new Response(res.body, { status: res.status, headers });
    },
    websocket,
  };
  return app;
}

/** The REST routing table (no WS): /v1/state, screenshot, input/*. */
function buildRestHandler(deps: BridgeDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const explicit = url.searchParams.get("device") ?? undefined;
    let response: Response;
    try {
      if (req.method === "GET" && path === "/v1/state") response = await handleState(deps, explicit);
      else if (req.method === "GET" && path === "/v1/screenshot") response = await handleScreenshot(deps, explicit, url);
      else if (req.method === "POST" && path === "/v1/input/tap") response = await handleTap(deps, explicit, req);
      else if (req.method === "POST" && path === "/v1/input/swipe") response = await handleSwipe(deps, explicit, req);
      else if (req.method === "POST" && path === "/v1/input/text") response = await handleText(deps, explicit, req);
      else response = notFound(req.method, path);
    } catch (e) {
      if (e instanceof HttpError) {
        response = error(e.status, e.code, e.message, e.details);
      } else {
        const message = e instanceof Error ? e.message : String(e);
        response = error(500, "INTERNAL_ERROR", message);
      }
    }
    return response;
  };
}

/** Kept for backward compatibility (existing tests / docs reference it). */
export function createBridgeHandler(deps: BridgeDeps, opts: BridgeOptions = {}): (req: Request) => Promise<Response> {
  const app = createBridgeApp(deps, opts);
  return (req) => app.fetch(req, { upgrade: () => false } as unknown as Bun.Server<Record<string, unknown>>);
}