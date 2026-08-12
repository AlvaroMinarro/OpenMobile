import { escapeForAdb, InputError } from "../device/input";
import type { AVD, Device } from "../device/types";

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
  return json(200, { schema: "v1", bridge: deps.bridge, selected, frame: null, devices, emulators });
}

async function handleScreenshot(deps: BridgeDeps, explicit?: string): Promise<Response> {
  const serial = await requireUsable(deps, explicit);
  const path = `/tmp/om-br-${serial}-${Date.now()}.png`;
  await deps.cli.capture({ serial, outPath: path });
  const bytes = await deps.readFile(path);
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "image/png" },
  });
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

/** Build the HTTP handler. Testable directly; `main.ts` binds it to loopback. */
export function createBridgeHandler(deps: BridgeDeps, opts: BridgeOptions = {}): (req: Request) => Promise<Response> {
  return async (req) => {
    // Optional shared-secret gate (OFF by default: loopback is the trust boundary).
    if (opts.secret !== undefined && opts.secret !== "") {
      const provided = req.headers.get("x-openmobile-secret");
      if (provided !== opts.secret) {
        return error(401, "UNAUTHORIZED", "missing or invalid X-OpenMobile-Secret header");
      }
    }
    const url = new URL(req.url);
    const path = url.pathname;
    const explicit = url.searchParams.get("device") ?? undefined;
    try {
      if (req.method === "GET" && path === "/v1/state") return await handleState(deps, explicit);
      if (req.method === "GET" && path === "/v1/screenshot")
        return await handleScreenshot(deps, explicit);
      if (req.method === "POST" && path === "/v1/input/tap")
        return await handleTap(deps, explicit, req);
      if (req.method === "POST" && path === "/v1/input/swipe")
        return await handleSwipe(deps, explicit, req);
      if (req.method === "POST" && path === "/v1/input/text")
        return await handleText(deps, explicit, req);
      return notFound(req.method, path);
    } catch (e) {
      if (e instanceof HttpError) {
        return error(e.status, e.code, e.message, e.details);
      }
      const message = e instanceof Error ? e.message : String(e);
      return error(500, "INTERNAL_ERROR", message);
    }
  };
}