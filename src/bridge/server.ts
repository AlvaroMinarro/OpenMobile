import { escapeForAdb, InputError } from "../device/input";
import { tempPngPath } from "../device/temp";
import { rm } from "node:fs/promises";
import type { AVD, Device, UIElement } from "../device/types";
import { z } from "zod";
import {
  emulatorCreate as emulatorCreateHandler,
  emulatorStart as emulatorStartHandler,
  emulatorStop as emulatorStopHandler,
  getUiTree,
  type ToolResult,
} from "../tools/handlers";
import {
  emulatorCreateSchema,
  emulatorStartSchema,
  emulatorStopSchema,
} from "../tools/schemas";
import type { AndroidCli } from "../device/androidCli";
import type { AdbWrapper, LogcatFollowHandle, LogcatFollowOptions } from "../device/adb";
import type { DeviceContext } from "../tools/context";
import { LogcatHub, type LogcatSocket, type LogcatSubscription } from "../stream/logcatHub";
import {
  WS_CLOSE_CODES,
  parseClientJsep,
  type ControlErrorMessage,
  type RtcClientMessage,
  type RtcServerMessage,
  type StreamViewer,
} from "../stream/types";
import {
  sendControlEvent,
  ControlError,
  type ControlInjector,
} from "../stream/control";
import type { EmulatorControl } from "../device/grpc";
import { GrpcControlError } from "../device/grpc";
import {
  authenticateRequest,
  bearerCredential,
  isSeedCredential,
  issueToken,
  legacySecretHeader,
  parseAuthConfig,
  subprotocolCredential,
  unauthorizedResponse,
  validateCredential,
  TokenRegistry,
  type AuthConfig,
} from "./auth";

/**
 * The `/v1` loopback HTTP bridge daemon (SDD Phase 4 — locked D2 contract).
 *
 * Loopback (127.0.0.1) is the trust boundary; no credential is required by
 * default. With a seed configured (`OPENMOBILE_BRIDGE_SECRET` via main.ts or
 * BridgeOptions), EVERY request/upgrade must pass the single auth seam
 * (`src/bridge/auth.ts`): Bearer seed/token, legacy X-OpenMobile-Secret, or a
 * WS subprotocol credential (design D1/D6).
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
    /** adb screencap fallback for GET /v1/screenshot (Raw Screenshot spec). */
    screencap?(serial: string, localPath: string): Promise<void>;
    /** uiautomator XML dump fallback for GET /v1/ui-tree (Phase 2). */
    uiautomatorDump?(serial: string): Promise<string>;
    /**
     * Long-running `adb -s <serial> logcat -T <n> -v time` follow spawn
     * (Phase 4 / design D5, task 4.1). OPTIONAL: absent ⇒ WS /v1/logcat/ws
     * 404s (streaming-not-deployed precedent; legacy minimal test deps stay
     * green).
     */
    logcatFollow?(
      serial: string,
      opts: LogcatFollowOptions,
      onLine: (line: string) => void,
    ): LogcatFollowHandle;
  };
  cli: {
    emulatorList(): Promise<AVD[]>;
    capture(
      target: { serial: string; outPath: string },
    ): Promise<void>;
    /**
     * Lifecycle adapter deps (Phase 2 / design D3). Production wiring passes a
     * real AndroidCli, which provides them; optional here so the minimal
     * legacy fakes stay valid — absent ⇒ the route 404s
     * (streaming-not-deployed precedent).
     */
    emulatorStart?(
      name: string,
      opts?: { fps?: number; timeoutMs?: number },
    ): Promise<string>;
    emulatorStop?(name: string): Promise<void>;
    emulatorCreate?(name: string): Promise<void>;
    /** CLI layout path of the local get_ui_tree tool (GET /v1/ui-tree). */
    layout?(target: { serial: string }): Promise<UIElement[]>;
  };
  env: Record<string, string>;
  /**
   * Runtime selection override (Phase 3, design D7): set by
   * POST /v1/device/select, consulted between the explicit ?device= tier and
   * ANDROID_DEVICE by resolveSerial/handleState/ui-tree targeting. Daemon
   * memory ONLY — production wiring (main.ts) builds a fresh holder per app,
   * so a restart clears it. Optional so the minimal legacy fakes stay valid.
   */
  selectionOverride?: { current(): string | null; set(serial: string): void };
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
   * gRPC-first input surface (input-channel delta, design D3/D5): resolves a
   * serial to the emulator's EmulatorController when the running instance has
   * a per-instance pid ini; null ⇒ `adb shell input` fallback. Optional so
   * legacy minimal test deps stay valid (adb-only).
   */
  grpcControl?: (serial: string) => Promise<EmulatorControl | null>;
  /**
   * Stream subsystem for the WS routes (design D2/D3/D5). When absent, the
   * WS /v1/stream/* routes are rejected with 404 (no streaming deployed).
   * The bridge only consumes this narrow contract:
   *  - subscribeVideo → a StreamViewer the session will feed (handshake
   *    first, then the JSEP offer/ice frames; the viewer's close() means
   *    session ending → 4409),
   *  - unsubscribeVideo → release the viewer,
   *  - controlActive → the ACTIVE stream's gRPC control injector (null =
   *    none; the bridge sends validated JSON injects through it),
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
      code: "UNSUPPORTED" | "CAP_REACHED" | "NO_DEVICE" | "PERMISSION_DENIED";
      reason?: string;
    };

export interface StreamGateway {
  /** Current additive /v1/state stream object. */
  snapshot(): StreamStateView;
  /**
   * Register a video viewer. The bridge PASSES the socket-facing viewer; the
   * gateway (via its RtcSession) relays JSEP signaling into it: the
   * handshake (JSON) FIRST, then the offer/ice frames; when the session ends
   * the gateway's teardown calls viewer.close() (the bridge closes 4409).
   * Returns UNSUPPORTED (kill-switch off / capability gate), CAP_REACHED
   * (design D4, 8 max), PERMISSION_DENIED (4401) or NO_DEVICE (start
   * failed) — the bridge maps these onto close codes.
   */
  subscribeVideo(viewer: StreamViewer): Promise<StreamSubscribeResult>;
  /** Release a video viewer (last release may tear the session down). */
  unsubscribeVideo(viewerId: string): void;
  /**
   * Relay a validated client JSEP frame (answer/ice/state) into THAT
   * viewer's RTC stream. Returns false when no session/viewer exists — the
   * bridge closes the socket (4409) instead of silently dropping the frame.
   */
  relayViewerMessage(viewerId: string, msg: RtcClientMessage): boolean;
  /**
   * The ACTIVE stream's control injector, or null when no stream is up.
   * The control route validates the JSON contract and calls `inject`
   * (gRPC unary in device physical pixels, design D3/D5).
   */
  controlActive(): ControlInjector | null;
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
  /** Optional shared secret; when set, requests must carry it (legacy knob). */
  secret?: string;
  /**
   * Parsed auth surface (design D2/D6); wins over `secret` when both are
   * given. Undefined or `enabled:false` ⇒ byte-identical legacy fast path.
   */
  auth?: AuthConfig;
  /** Injected token registry (tests). Defaults to a fresh per-app instance. */
  authRegistry?: TokenRegistry;
  /**
   * `OPENMOBILE_BRIDGE_ALLOWED_ORIGINS` csv (task 1.7). While auth is
   * enabled ONLY these Origins are reflected as ACAO; unset seed ignores it.
   */
  allowedOriginsCsv?: string;
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
export class HttpError extends Error {
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

/**
 * D7 stale-selection rule: a selected serial that is no longer attached is an
 * actionable error NAMING it — never silent fallback to another device
 * (device-discovery delta; same observable shape requireUsable produces for
 * the env tier).
 */
function staleSelectionError(serial: string): HttpError {
  return new HttpError(409, "DEVICE_OFFLINE", `device ${serial} is not in state 'device'`);
}

/** Resolve the target serial: explicit arg > selection override > ANDROID_DEVICE env > auto-detect. */
async function resolveSerial(
  deps: BridgeDeps,
  explicit?: string,
): Promise<{ serial: string; device?: Device }> {
  if (explicit) return { serial: explicit };
  const devices = await deps.adb.devices();
  // Runtime override tier (design D4/D7): outranks env + auto-detect. A stale
  // serial errors naming it instead of falling through to another tier.
  const override = deps.selectionOverride?.current();
  if (override) {
    const found = devices.find((d) => d.serial === override);
    if (!found) throw staleSelectionError(override);
    return { serial: override, device: found };
  }
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
  // Runtime override tier (design D4/D7): between explicit ?device= and env.
  // Unlike routed operations, state NEVER errors on a stale serial — it keeps
  // answering 200 with the resolved (or synthesized) entry so clients can see
  // what the daemon WOULD target.
  const overrideSerial = !explicit ? deps.selectionOverride?.current() ?? null : null;
  if (explicit) {
    selected = devices.find((d) => d.serial === explicit) ?? {
      serial: explicit,
      state: "device",
    };
  } else if (overrideSerial !== null) {
    selected =
      devices.find((d) => d.serial === overrideSerial) ?? { serial: overrideSerial, state: "device" };
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
    // D4 conditional-additive sibling: present ONLY while the override tier
    // resolved `selected` (an explicit ?device= outranks it and keeps the
    // legacy shape). Absent ⇒ zero new keys ⇒ byte-identical legacy body.
    ...(overrideSerial !== null
      ? { selection: { serial: overrideSerial, source: "override" } }
      : {}),
  });
}

async function handleScreenshot(deps: BridgeDeps, explicit: string | undefined, url: URL): Promise<Response> {
  const serial = await requireUsable(deps, explicit);
  const path = deps.tempPngPath("br", serial);
  try {
    try {
      await deps.cli.capture({ serial, outPath: path });
    } catch (e) {
      // Raw Screenshot spec: the android CLI capture falls back to adb
      // `screencap`. Without the fallback wired, the original error stands.
      const fallback = deps.adb.screencap;
      if (!fallback) throw e;
      await fallback(serial, path);
    }
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

/**
 * gRPC-first input mode selection (input-channel delta): when the selected
 * emulator exposes a usable EmulatorController the gesture goes through gRPC
 * unary in DEVICE PHYSICAL pixels (bounds validated client-side inside the
 * control client); `adb shell input` is the fallback when no gRPC surface
 * exists. A failing gRPC call propagates as an actionable error — NEVER a
 * silent adb fallback (Injection-failure scenario).
 */
async function injectGrpcFirst(
  deps: BridgeDeps,
  serial: string,
  grpc: (control: EmulatorControl) => Promise<void>,
  adbFallback: () => Promise<void>,
): Promise<void> {
  const control = deps.grpcControl ? await deps.grpcControl(serial) : null;
  if (control) {
    try {
      await grpc(control);
      return;
    } catch (e) {
      if (e instanceof GrpcControlError) throw new HttpError(502, e.code, e.message, e.details);
      throw e;
    }
  }
  await adbFallback();
}

async function handleTap(deps: BridgeDeps, explicit: string | undefined, req: Request): Promise<Response> {
  const body = await requireJson(req);
  const x = needNumber(body, "x");
  const y = needNumber(body, "y");
  const serial = await requireUsable(deps, explicit);
  await injectGrpcFirst(
    deps,
    serial,
    (control) => control.tap(x, y),
    () => deps.adb.inputTap(serial, x, y),
  );
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
  await injectGrpcFirst(
    deps,
    serial,
    (control) => control.swipe(x1, y1, x2, y2, durationMs),
    () => deps.adb.inputSwipe(serial, x1, y1, x2, y2, durationMs),
  );
  return json(200, { ok: true, serial });
}

async function handleText(deps: BridgeDeps, explicit: string | undefined, req: Request): Promise<Response> {
  const body = await requireJson(req);
  const raw = body["text"];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "field 'text' must be a non-empty string", "text");
  }
  const serial = await requireUsable(deps, explicit);
  await injectGrpcFirst(
    deps,
    serial,
    // gRPC path: full UTF-8 rides sendKey(KeyboardEvent{text}) — probe D;
    // there is no sendText RPC and no adb ASCII restriction.
    (control) => control.text(raw),
    async () => {
      // adb path only: validate injectability through the device-core rule.
      try {
        escapeForAdb(raw);
      } catch (e) {
        const message = e instanceof InputError ? e.message : "text cannot be injected";
        throw new HttpError(422, "VALIDATION_ERROR", message);
      }
      await deps.adb.inputText(serial, raw);
    },
  );
  return json(200, { ok: true, serial });
}

/**
 * POST /v1/auth/token (design D2): the SEED — and only the seed — mints
 * tokens; a valid issued token authenticates routes but cannot mint more.
 * Body is optional: `{"ttlSeconds":<int>}` is clamped to [60, cap].
 */
async function handleIssueToken(
  auth: AuthConfig,
  registry: TokenRegistry,
  req: Request,
): Promise<Response> {
  const credential = bearerCredential(req) ?? legacySecretHeader(req);
  if (credential === null || !isSeedCredential(auth, credential)) {
    return unauthorizedResponse("unauthorized");
  }
  const body = await readOptionalJson(req);
  const requestedTtl = readOptionalInteger(body, "ttlSeconds");
  return json(200, issueToken(auth, registry, requestedTtl));
}

/** requireJson variant tolerating an EMPTY body (issuance body is optional). */
async function readOptionalJson(req: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "could not read request body");
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(422, "VALIDATION_ERROR", "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Optional integer field; 422 VALIDATION_ERROR when present but malformed. */
function readOptionalInteger(body: Record<string, unknown>, field: string): number | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new HttpError(422, "VALIDATION_ERROR", `field '${field}' must be an integer`, field);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Lifecycle + UI-tree route adapters (Phase 2, design D3)
//
// HTTP-specific semantics live at THIS seam; the MCP handlers stay byte-stable
// as the single semantic source. Each adapter validates with the tool's own
// zod schema, runs its cheap emulatorList() pre-checks, then delegates through
// an assembled DeviceContext and maps surviving handler failures onto status
// codes via ONE function (toolFailureToHttp).
// ---------------------------------------------------------------------------

/** Outer readiness timeout for delegated handlers (mirrors createContext). */
const TOOL_TIMEOUT_MS = 120_000;

/**
 * Assemble the DeviceContext the tools handlers expect from the bridge deps.
 * The two casts are isolated HERE on purpose: production deps are real
 * AndroidCli/AdbWrapper instances (bridge/main.ts), so the optional lifecycle
 * members exist at runtime; requireCap() 404s before any delegation otherwise.
 */
function assembleToolContext(deps: BridgeDeps): DeviceContext {
  return {
    cli: deps.cli as unknown as AndroidCli,
    adb: deps.adb as unknown as AdbWrapper,
    env: deps.env,
    baselineEstablished: new Set<string>(),
    timeoutMs: TOOL_TIMEOUT_MS,
    readFile: deps.readFile,
    tempPngPath: deps.tempPngPath,
  };
}

/** Capability guard: absent dep ⇒ 404 (streaming-not-deployed precedent). */
function requireCap<T>(fn: T | undefined, what: string): T {
  if (!fn) throw new HttpError(404, "NOT_FOUND", `${what} not deployed on this bridge`);
  return fn;
}

/**
 * Body parser for the lifecycle routes. The local-bridge delta spec pins
 * malformed OR schema-invalid bodies of THESE routes to 422 `validation_error`
 * (lowercase code per spec; legacy routes keep their uppercase conventions).
 */
async function requireLifecycleJson(req: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await req.text());
  } catch {
    throw new HttpError(422, "validation_error", "request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(422, "validation_error", "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Validate a parsed body against the tool's own zod schema (422 on failure). */
function parseLifecycleBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at '${issue.path.map(String).join(".")}'` : "";
    throw new HttpError(
      422,
      "validation_error",
      issue ? `invalid request body: ${issue.message}${where}` : "invalid request body",
    );
  }
  return result.data;
}

/** Names of the known AVDs for error `details.available`. */
const avdNames = (avds: AVD[]): string[] => avds.map((a) => a.name);

/**
 * Design D3 — THE ONE handler-failure→HTTP mapping. The boot-timeout text of
 * tools/handlers.ts emulator_start is pinned HERE and only here, so any
 * wording drift is a one-line contract fix away from breaking every route:
 *   /did not reach 'device' state within .*\(serial (\S+), last observed state: (\S+)\)/
 * Matching failure ⇒ 504 `boot_timeout` {name, serial, lastState}; ANY other
 * handler failure ⇒ 500 INTERNAL_ERROR with the message verbatim.
 */
const BOOT_TIMEOUT_RE = /did not reach 'device' state within .*\(serial (\S+), last observed state: (\S+)\)/;

export function toolFailureToHttp(avdName: string | undefined, message: string): HttpError {
  const m = BOOT_TIMEOUT_RE.exec(message);
  if (m) {
    const name = avdName ?? /^emulator (\S+) did not reach/.exec(message)?.[1];
    return new HttpError(504, "boot_timeout", message, {
      ...(name !== undefined ? { name } : {}),
      serial: m[1] as string,
      lastState: m[2] as string,
    });
  }
  return new HttpError(500, "INTERNAL_ERROR", message);
}

/**
 * Delegate to an MCP handler and translate its ToolResult into a Response.
 * Success payloads pass through byte-shape-equal to the local tool output.
 */
async function runLifecycleTool(
  deps: BridgeDeps,
  run: (ctx: DeviceContext) => Promise<ToolResult>,
  avdName: string | undefined,
): Promise<Response> {
  const result = await run(assembleToolContext(deps));
  const block = result.content[0];
  if (result.isError) {
    // ONE mapping function for every surviving handler failure (design D3).
    const message = block?.type === "text" ? block.text : "tool failed without a message";
    throw toolFailureToHttp(avdName, message);
  }
  if (!block || block.type !== "text") {
    throw new HttpError(500, "INTERNAL_ERROR", "handler returned no payload");
  }
  try {
    return json(200, JSON.parse(block.text) as unknown);
  } catch {
    throw new HttpError(500, "INTERNAL_ERROR", "handler returned a non-JSON payload");
  }
}

/** POST /v1/emulator/start — delegate to the emulator_start tool handler. */
async function handleBridgeEmulatorStart(deps: BridgeDeps, req: Request): Promise<Response> {
  requireCap(deps.cli.emulatorStart, "emulator start");
  const args = parseLifecycleBody(emulatorStartSchema, await requireLifecycleJson(req));
  // D3 cheap pre-check: an explicitly unknown AVD fails BEFORE any launch,
  // listing what exists (spec: Unknown AVD listed → 404 avd_not_found).
  if (args.name !== undefined) {
    const available = await deps.cli.emulatorList();
    if (!available.some((a) => a.name === args.name)) {
      throw new HttpError(
        404,
        "avd_not_found",
        `unknown AVD '${args.name}'; available AVDs: ${avdNames(available).join(", ") || "(none)"}`,
        { available: avdNames(available) },
      );
    }
  }
  return runLifecycleTool(deps, (ctx) => emulatorStartHandler(ctx, args), args.name);
}

/**
 * POST /v1/emulator/stop — D3 pre-checks first: unknown AVD ⇒ 404
 * avd_not_found + details.available. Idempotence (task 2.4) is a ROUTE-layer
 * concern backed by per-daemon memory (`confirmedStops`, restart clears it):
 * a known NOT-running AVD is answered without issuing another CLI stop — the
 * first such answer mirrors the handler's success bytes, repeats add
 * alreadyStopped:true.
 */
async function handleBridgeEmulatorStop(
  deps: BridgeDeps,
  req: Request,
  confirmedStops: Set<string>,
): Promise<Response> {
  requireCap(deps.cli.emulatorStop, "emulator stop");
  const args = parseLifecycleBody(emulatorStopSchema, await requireLifecycleJson(req));
  const available = await deps.cli.emulatorList();
  const target = available.find((a) => a.name === args.name);
  if (!target) {
    throw new HttpError(
      404,
      "avd_not_found",
      `unknown AVD '${args.name}'; available AVDs: ${avdNames(available).join(", ") || "(none)"}`,
      { available: avdNames(available) },
    );
  }
  if (!target.running) {
    // Known-stopped AVD: settled at the route layer, ZERO CLI stop issued.
    if (confirmedStops.has(args.name)) {
      return json(200, { stopped: args.name, alreadyStopped: true });
    }
    confirmedStops.add(args.name);
    return json(200, { stopped: args.name });
  }
  const res = await runLifecycleTool(deps, (ctx) => emulatorStopHandler(ctx, args), args.name);
  confirmedStops.add(args.name);
  return res;
}

/**
 * GET /v1/ui-tree — read-only adapter over the local get_ui_tree tool
 * (task 2.5): same {serial, empty, tree} payload, with an empty hierarchy
 * signalled IN-BAND (200 empty:true) by the handler itself — never an HTTP
 * error.
 */
async function handleBridgeUiTree(deps: BridgeDeps, explicit?: string): Promise<Response> {
  requireCap(deps.cli.layout, "ui tree");
  requireCap(deps.adb.uiautomatorDump, "ui tree");
  // Query param is already string|undefined — matches get_ui_tree args exactly.
  // Selection override tier (design D4/D7): get_ui_tree treats its device arg
  // as the EXPLICIT tier, so the override rides there — above ANDROID_DEVICE
  // and auto-detect inside the handler. A stale override fails HERE (naming
  // the serial) instead of surfacing as a CLI 500; the handler trusts its
  // explicit arg without re-enumerating, so the cheap pre-check is required.
  let target = explicit;
  if (target === undefined) {
    const override = deps.selectionOverride?.current();
    if (override) {
      const devices = await deps.adb.devices();
      if (!devices.some((d) => d.serial === override)) throw staleSelectionError(override);
      target = override;
    }
  }
  return runLifecycleTool(deps, (ctx) => getUiTree(ctx, { device: target }), undefined);
}

/** POST /v1/device/select body schema: {serial} against the attached list. */
const deviceSelectSchema = z.object({ serial: z.string().min(1) });

/**
 * POST /v1/device/select (task 3.3, design D7): validate the requested serial
 * against the ATTACHED device list, then record it as the runtime selection
 * override in daemon memory (main.ts holder). An unknown serial is a 404
 * naming what IS attached — never stored.
 */
async function handleDeviceSelect(deps: BridgeDeps, req: Request): Promise<Response> {
  const override = requireCap(deps.selectionOverride, "device select");
  const args = parseLifecycleBody(deviceSelectSchema, await requireLifecycleJson(req));
  const devices = await deps.adb.devices();
  const attached = devices.map((d) => d.serial);
  if (!attached.includes(args.serial)) {
    throw new HttpError(
      404,
      "device_not_found",
      `unknown device '${args.serial}'; attached devices: ${attached.join(", ") || "(none)"}`,
      { attached },
    );
  }
  override.set(args.serial);
  return json(200, { selected: args.serial });
}

/** POST /v1/emulator/create — duplicate name rejected BEFORE any CLI create. */
async function handleBridgeEmulatorCreate(deps: BridgeDeps, req: Request): Promise<Response> {
  requireCap(deps.cli.emulatorCreate, "emulator create");
  const args = parseLifecycleBody(emulatorCreateSchema, await requireLifecycleJson(req));
  const available = await deps.cli.emulatorList();
  if (available.some((a) => a.name === args.name)) {
    throw new HttpError(
      409,
      "avd_exists",
      `AVD '${args.name}' already exists; choose a different name (nothing was created)`,
    );
  }
  return runLifecycleTool(deps, (ctx) => emulatorCreateHandler(ctx, args), args.name);
}

/** Built bridge app: REST fetch handler + WS handler table for Bun.serve. */
export interface BridgeApp {
  fetch: (req: Request, server: Bun.Server<Record<string, unknown>>) => Promise<Response>;
  websocket: Bun.WebSocketHandler<Record<string, unknown>>;
}

/** The per-connection state the WS handlers carry. */
interface WsConn {
  /** "video", "control", or "logcat" (Phase 4 / design D5). */
  kind: "video" | "control" | "logcat";
  /** Gateway viewer id (video route) or the control writer (control route). */
  viewerId?: string;
  /** logcat route: target serial resolved ONCE at upgrade time. */
  serial?: string;
  /** logcat route: subscription registered at open (inert dead sub if over cap). */
  subscription?: LogcatSubscription;
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
  // Single auth surface (design D6): parsed config wins over the raw legacy
  // knob; both funnel into ONE TokenRegistry + ONE authenticate() seam.
  const authCfg: AuthConfig | undefined =
    opts.auth ?? (opts.secret ? parseAuthConfig({ OPENMOBILE_BRIDGE_SECRET: opts.secret }) : undefined);
  const authRegistry = opts.authRegistry ?? new TokenRegistry();
  const authEnabled = authCfg?.enabled === true;

  // CORS narrowing (task 1.7 / design D6): OPENMOBILE_BRIDGE_ALLOWED_ORIGINS
  // is a csv allow-list honored ONLY while auth is enabled — default none ⇒
  // no ACAO reflection at all. Seed unset keeps the legacy requestOrigin||"*".
  const allowedOrigins = new Set(
    (opts.allowedOriginsCsv ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o !== ""),
  );

  /** Legacy: reflect any Origin (or "*"). Auth on: only allow-listed ones. */
  const resolveAllowOrigin = (requestOrigin: string | null): string | undefined => {
    if (!authEnabled) return requestOrigin || "*";
    return requestOrigin !== null && allowedOrigins.has(requestOrigin) ? requestOrigin : undefined;
  };

  const corsHeaders = (allowOrigin: string | undefined) => ({
    ...(allowOrigin !== undefined ? { "access-control-allow-origin": allowOrigin } : {}),
    "access-control-allow-methods": "GET, POST, OPTIONS",
    ...(authEnabled
      ? { "access-control-allow-headers": "content-type, authorization, x-openmobile-secret" }
      : { "access-control-allow-headers": "content-type, x-openmobile-secret" }),
  });

  /** REST-only handler (no WS): the routing table for every non-upgrade req. */
  const rest = buildRestHandler(deps, { auth: authCfg, registry: authRegistry });

  /**
   * Logcat hub (Phase 4 / design D5): ONE per-daemon instance so the
   * subscriber registry (cap 8, VIEWER_CAP) and the detach watchdog live for
   * the whole app lifetime. Built ONLY when the optional adb.logcatFollow
   * capability is wired — otherwise the route 404s before any upgrade.
   */
  const logcatHub = deps.adb.logcatFollow
    ? new LogcatHub(
        { logcatFollow: (serial, opts, onLine) => deps.adb.logcatFollow!(serial, opts, onLine) },
        { devices: () => deps.adb.devices() },
      )
    : null;

  const websocket: Bun.WebSocketHandler<Record<string, unknown>> = {
    open(ws) {
      const conn = ws.data as unknown as WsConn;
      if (conn.kind === "video") void onVideoOpen(ws);
      else if (conn.kind === "logcat" && conn.serial && logcatHub) {
        conn.subscription = logcatHub.subscribe(logcatSocketAdapter(ws), conn.serial);
      }
      // control route does nothing on open (validated at upgrade)
    },
    message(ws, msg) {
      const conn = ws.data as unknown as WsConn;
      if (conn.kind === "control") void onControlMessage(ws, msg);
      else if (conn.kind === "video") onVideoMessage(ws, msg);
      else if (conn.kind === "logcat") {
        const text =
          typeof msg === "string" ? msg : Buffer.from(msg as Uint8Array).toString("utf8");
        conn.subscription?.handleFrame(text);
      }
    },
    close(ws, code, reason) {
      const conn = ws.data as unknown as WsConn;
      if (conn.kind === "video" && conn.viewerId) {
        deps.streamGateway?.unsubscribeVideo(conn.viewerId);
      }
      if (conn.kind === "logcat") {
        // Client disconnect tears down THAT subscriber's child (spec: Stream
        // Teardown); siblings are independent subscriptions and unaffected.
        conn.subscription?.cancel();
      }
      void code;
      void reason;
    },
  };

  /** Bridge a Bun server socket onto the hub's narrow LogcatSocket surface. */
  function logcatSocketAdapter(ws: Bun.ServerWebSocket<Record<string, unknown>>): LogcatSocket {
    return {
      send: (frameJson: string) => {
        if (ws.readyState === 1) ws.send(frameJson);
      },
      close: (code: number, reason: string) => {
        ws.close(code, reason);
      },
      get open() {
        return ws.readyState === 1;
      },
    };
  }

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
    // Socket-facing viewer: the gateway (via its RtcSession) relays JSEP
    // signaling INTO it — every frame is a JSON text message (the WS MUST
    // NOT carry binary video frames; media flows browser↔emulator over
    // loopback UDP, design D1). The viewer's close() (session teardown /
    // device loss) maps onto 4409.
    const socketViewer: StreamViewer = {
      id: crypto.randomUUID(),
      sendMessage: (msg: RtcServerMessage) => {
        ws.send(JSON.stringify(msg));
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
    // Track the viewer id on the connection BEFORE the (async) subscription:
    // if the WS closes while subscribeVideo is in flight (tab reload, rapid
    // connect-close), the close handler below must still unsubscribe it —
    // otherwise a dead viewer holds a cap slot + manager refcount forever.
    (ws.data as unknown as WsConn).viewerId = socketViewer.id;
    const result = await gw.subscribeVideo(socketViewer);
    if (!result.ok) {
      if (result.code === "CAP_REACHED") {
        wsReject(ws, WS_CLOSE_CODES.VIEWER_CAP, result.reason ?? "viewer cap reached (8)");
      } else if (result.code === "UNSUPPORTED") {
        wsReject(ws, WS_CLOSE_CODES.UNSUPPORTED, result.reason ?? "streaming unsupported");
      } else if (result.code === "PERMISSION_DENIED") {
        wsReject(ws, WS_CLOSE_CODES.PERMISSION_DENIED, result.reason ?? "emulator gRPC denied RtcService");
      } else {
        wsReject(ws, WS_CLOSE_CODES.NO_DEVICE, result.reason ?? "no usable device for streaming");
      }
      return;
    }
    // The handshake + offer + ice frames flow through sendMessage once the
    // viewer's RTC stream is up. Client frames arrive in message() below.
  }

  /**
   * Client→server JSEP signaling on the video WS (task 2.7). Malformed or
   * unknown frames produce a JSON error body + close (spec: Malformed
   * signaling — never a silent hang); valid frames relay into the viewer's
   * RTC stream, and a frame for a stream that is gone closes 4409.
   */
  function onVideoMessage(ws: Bun.ServerWebSocket<Record<string, unknown>>, raw: unknown): void {
    const text = typeof raw === "string" ? raw : Buffer.from(raw as Uint8Array).toString("utf8");
    const parsed = parseClientJsep(text);
    if (!parsed.ok) {
      wsReject(ws, WS_CLOSE_CODES.BAD_MESSAGE, parsed.message);
      return;
    }
    const viewerId = (ws.data as unknown as WsConn).viewerId;
    const gw = deps.streamGateway;
    if (!gw || !viewerId || !gw.relayViewerMessage(viewerId, parsed.msg)) {
      wsReject(ws, WS_CLOSE_CODES.DEVICE_LOST, "no active rtc stream for this viewer");
    }
  }

  async function onControlMessage(ws: Bun.ServerWebSocket<Record<string, unknown>>, raw: unknown): Promise<void> {
    const text = typeof raw === "string" ? raw : Buffer.from(raw as Uint8Array).toString("utf8");
    if (deps.streamGateway === undefined) {
      wsReject(ws, WS_CLOSE_CODES.UNSUPPORTED, "streaming not deployed");
      return;
    }
    const active = deps.streamGateway.controlActive();
    try {
      const result = await sendControlEvent(active, text);
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
      // OPTIONS before the upgrade as well). Narrowed to allow-listed origins
      // while auth is enabled (task 1.7); undefined ⇒ NO ACAO header at all.
      const requestOrigin = req.headers.get("origin");
      const allowOrigin = resolveAllowOrigin(requestOrigin);
      const stamped = (res: Response): Response => {
        if (allowOrigin === undefined) return res;
        const headers = new Headers(res.headers);
        headers.set("access-control-allow-origin", allowOrigin);
        return new Response(res.body, { status: res.status, headers });
      };
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
      }
      // WS upgrades: /v1/stream/video + /v1/stream/control + /v1/logcat/ws.
      if (path === "/v1/stream/video" || path === "/v1/stream/control" || path === "/v1/logcat/ws") {
        // Single auth seam for upgrades exactly like REST (design D6). Browsers
        // cannot set custom headers, so after the header-carrier check fails,
        // the subprotocol entry `openmobile.bearer.<cred>` is validated here
        // (design D1): on success it is echoed EXACTLY once into
        // server.upgrade({headers}) — SPIKE-1 verdict echo-ok; on failure a
        // 401 Response is returned WITHOUT calling server.upgrade().
        let denial = authenticateRequest(authCfg, authRegistry, req);
        let protoEcho: Record<string, string> | undefined;
        if (denial && authCfg) {
          const sub = subprotocolCredential(req);
          if (sub) {
            const verdict = validateCredential(authCfg, authRegistry, sub.credential);
            if (verdict === "valid") {
              denial = null;
              protoEcho = { "sec-websocket-protocol": sub.entry };
            } else {
              // Present-but-bad subprotocol credential reports ITS verdict
              // (expired ⇒ token_expired), never echoes the credential.
              denial = unauthorizedResponse(verdict === "token_expired" ? "token_expired" : "unauthorized");
            }
          }
        }
        if (denial) {
          return denial;
        }
        const isLogcat = path === "/v1/logcat/ws";
        // No capability → 404 (streaming-not-deployed precedent).
        if (isLogcat && !deps.adb.logcatFollow) {
          return notFound(req.method, path);
        }
        if (!isLogcat && !deps.streamGateway) {
          return notFound(req.method, path);
        }
        let kind: WsConn["kind"];
        let serial: string | undefined;
        if (isLogcat) {
          kind = "logcat";
          // Target resolution ONCE at upgrade (same tiers as REST routes:
          // ?device= > override > ANDROID_DEVICE > auto). A resolution error
          // (no device / ambiguous / stale override) is an HTTP error at the
          // upgrade seam — never a socket that hangs then dies.
          try {
            serial = await requireUsable(deps, url.searchParams.get("device") ?? undefined);
          } catch (e) {
            if (e instanceof HttpError) {
              return stamped(error(e.status, e.code, e.message, e.details));
            }
            throw e;
          }
        } else {
          kind = path === "/v1/stream/video" ? "video" : "control";
          if (kind === "control") {
            // Control-without-stream rejects at UPGRADE (spec: Control without
            // stream → rejected and closed, never a silent hang).
            const active = deps.streamGateway!.controlActive();
            if (!active) {
              return stamped(error(
                409,
                "STREAM_OFF",
                "no active stream; use /v1/input REST fallback",
              ));
            }
          }
        }
        const upgraded = server.upgrade(req, {
          data: { kind, ...(serial !== undefined ? { serial } : {}) } as unknown as Record<string, unknown>,
          ...(protoEcho ? { headers: protoEcho } : {}),
        });
        if (!upgraded) {
          return stamped(error(400, "BAD_REQUEST", "WebSocket upgrade failed"));
        }
        return new Response(null, { status: 101 });
      }
      // Everything else → REST.
      // Single auth seam (design D6): one gate before dispatch, accepting
      // Bearer seed/token or the legacy X-OpenMobile-Secret header.
      const denial = authenticateRequest(authCfg, authRegistry, req);
      if (denial) {
        return stamped(denial);
      }
      const res = await rest(req);
      return stamped(res);
    },
    websocket,
  };
  return app;
}

/** The REST routing table (no WS): /v1/state, screenshot, input/*, auth/token. */
function buildRestHandler(
  deps: BridgeDeps,
  restCtx: { auth?: AuthConfig; registry?: TokenRegistry } = {},
): (req: Request) => Promise<Response> {
  // Per-daemon stop-idempotence memory (task 2.4): lives in the app closure —
  // NOT per request — so repeats are recognized and a daemon restart clears it.
  const confirmedStops = new Set<string>();
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
      // Lifecycle adapters (Phase 2 / design D3): served regardless of auth
      // state — the single seam in app.fetch gates them like every /v1 route.
      else if (req.method === "POST" && path === "/v1/emulator/start") response = await handleBridgeEmulatorStart(deps, req);
      else if (req.method === "POST" && path === "/v1/emulator/stop") response = await handleBridgeEmulatorStop(deps, req, confirmedStops);
      else if (req.method === "POST" && path === "/v1/emulator/create") response = await handleBridgeEmulatorCreate(deps, req);
      else if (req.method === "GET" && path === "/v1/ui-tree") response = await handleBridgeUiTree(deps, explicit);
      // Selection override (Phase 3 / design D7): served regardless of auth
      // state — gated by the seam only when auth is enabled.
      else if (req.method === "POST" && path === "/v1/device/select") response = await handleDeviceSelect(deps, req);
      // Token issuance (design D2): registered ONLY when auth is enabled —
      // seed unset keeps the byte-identical legacy NOT_FOUND surface.
      else if (req.method === "POST" && path === "/v1/auth/token") {
        response =
          restCtx.auth?.enabled && restCtx.registry
            ? await handleIssueToken(restCtx.auth, restCtx.registry, req)
            : notFound(req.method, path);
      } else response = notFound(req.method, path);
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