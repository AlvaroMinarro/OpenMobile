/**
 * Emulator gRPC control client (design D3/D5/D6, task 1.3).
 *
 * The emulator exposes the Android-Studio control surface on loopback gRPC
 * (`EmulatorController`): input injection via unary `sendTouch`/`sendKey`,
 * display geometry via `getDisplayConfigurations`. Probe-verified LIVE on
 * emulator 36.5.11 (2026-08-16, pid 2604388): 12ms unary RTT, coordinates in
 * device PHYSICAL pixels, and — critically — OUT-OF-RANGE INPUT IS SILENTLY
 * ACCEPTED (no error). Therefore validation is CLIENT-SIDE against the
 * configured display size (design D5), with actionable errors.
 *
 * Token plumbing (design D6): each running instance writes
 * `<run-dir>/avd/running/pid_<pid>.ini` with `grpc.token` + `grpc.port` +
 * `port.serial`; the token is attached as `authorization: Bearer <token>` on
 * every call and maps to the `android-studio` allowlist issuer (probe A:
 * without it → PERMISSION_DENIED). `findEmulatorConfig` resolves a serial to
 * its per-instance endpoint; externals launches (Studio/manual) yield null →
 * callers fall back to adb input.
 *
 * Protos: vendored under `protos/` (see protos/README.md) — server reflection
 * is allowlist-blocked, so local copies are required.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

/** Vendored proto paths (protos/README.md pins the SDK version). */
export const PROTOS_DIR = join(import.meta.dir, "..", "..", "protos");
export const EMULATOR_CONTROLLER_PROTO = join(PROTOS_DIR, "emulator_controller.proto");
export const RTC_SERVICE_PROTO = join(PROTOS_DIR, "rtc_service.proto");

/**
 * Receive ceiling for JSEP streams (task 2.6): grpc-js defaults to 4MB which
 * an SDP with a rich candidate list can plausibly exceed; the emulator's own
 * client uses 64MB. Receive-only — sends stay small JSON dictionaries.
 */
export const MAX_RECEIVE_MESSAGE_LENGTH = 64 * 1024 * 1024;

/** gRPC port the emulator listens on (per-instance ini usually overrides). */
export const DEFAULT_GRPC_PORT = 8554;

/** Minimum emulator version for the gRPC control surface (36.5.11). */
export const MIN_EMULATOR_VERSION = { major: 36, minor: 5, patch: 11 } as const;
/** Version from which `-rtcfps` exists (unknown option on 36.5.11). */
export const RTCPFS_VERSION = { major: 36, minor: 6, patch: 0 } as const;
/**
 * Version that REMOVED `-rtcfps` again (live-verified on 37.1.11: the option
 * is rejected with `unknown option: -rtcfps`; the 37.x help exposes no
 * replacement). The flag is only valid in the [36.6, 37.0) window.
 */
export const RTCPFS_REMOVED_VERSION = { major: 37, minor: 0, patch: 0 } as const;

// ─── pure helpers ────────────────────────────────────────────────────────

export interface EmulatorVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Parse `Android emulator version X.Y.Z.W (build N)` → X.Y.Z. */
export function parseEmulatorVersion(raw: string): EmulatorVersion | null {
  const m = /Android emulator version (\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Version gate: is `v` >= `min` (same-or-newer, semantic comparison). */
export function isAtLeast(v: EmulatorVersion, min: EmulatorVersion): boolean {
  if (v.major !== min.major) return v.major > min.major;
  if (v.minor !== min.minor) return v.minor > min.minor;
  return v.patch >= min.patch;
}

/** Parse a pid ini into its key/value map (CRLF tolerant). */
export function parsePidIni(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** `emulator-5554` → `5554`; null for anything else (physical devices). */
export function adbPort(serial: string): string | null {
  const m = /^emulator-(\d+)$/.exec(serial);
  return m ? m[1]! : null;
}

/** Per-instance gRPC endpoint resolution (serial → ini lookup). */
export interface EmulatorGrpcConfig {
  token: string;
  port: number;
  /** `emulator.version=X.Y.Z.W` from the ini (absent in some ini layouts). */
  emulatorVersion?: string;
}

/** Default run dir where the emulator writes per-pid ini files. */
export function defaultRunDir(): string {
  return (
    process.env["OPENMOBILE_AVD_RUN_DIR"] ??
    `/run/user/${typeof process.getuid === "function" ? process.getuid() : 1000}/avd/running`
  );
}

/** Resolve `serial` → its per-instance {token, port} from the pid ini files. */
export function findEmulatorConfig(runDir: string, serial: string): EmulatorGrpcConfig | null {
  const wanted = adbPort(serial);
  if (!wanted) return null;
  let names: string[];
  try {
    names = readdirSync(runDir).filter((n) => /^pid_\d+\.ini$/.test(n));
  } catch {
    return null; // no run dir (no emulator launched by us) → not controllable
  }
  for (const name of names) {
    let ini: Record<string, string>;
    try {
      ini = parsePidIni(readFileSync(join(runDir, name), "utf8"));
    } catch {
      continue; // torn write mid-launch — skip, another pid file may match
    }
    if (ini["port.serial"] !== wanted || !ini["grpc.token"]) continue;
    const port = Number(ini["grpc.port"]);
    return {
      token: ini["grpc.token"]!,
      port: Number.isInteger(port) ? port : DEFAULT_GRPC_PORT,
      ...(ini["emulator.version"] !== undefined ? { emulatorVersion: ini["emulator.version"] } : {}),
    };
  }
  return null;
}

/** Resolved RTC capability for one serial (the gateway's capability probe). */
export interface ResolvedRtcCapability {
  supported: boolean;
  reason?: string;
  endpoint?: { addr: string; token: string };
}

/**
 * Resolve the RTC streaming capability for a serial (task 2.8):
 *  - no per-instance pid ini (externally launched / physical device) →
 *    `grpc_permission_denied` (spec: Externally launched emulator — control
 *    keeps working, video degrades; there is NO second video path),
 *  - version parsed from the ini below 36.5.11 → a reason naming the
 *    requirement + the upgrade path (spec: Version gate),
 *  - an ini without a version field is accepted (it cannot be proven below
 *    the gate; the gRPC call itself fails closed if the service is missing).
 */
export function resolveRtcCapability(runDir: string, serial: string): ResolvedRtcCapability {
  const cfg = findEmulatorConfig(runDir, serial);
  if (!cfg) return { supported: false, reason: "grpc_permission_denied" };
  if (cfg.emulatorVersion !== undefined) {
    const version = parseEmulatorVersion(`Android emulator version ${cfg.emulatorVersion}`);
    if (version && !isAtLeast(version, MIN_EMULATOR_VERSION)) {
      return {
        supported: false,
        reason:
          `emulator ${version.major}.${version.minor}.${version.patch} lacks native RTC ` +
          `(requires >= 36.5.11; upgrade the Android emulator)`,
      };
    }
  }
  return { supported: true, endpoint: { addr: `localhost:${cfg.port}`, token: cfg.token } };
}

// ─── typed errors (mapped onto WS close codes by the bridge) ─────────────

export type GrpcControlErrorCode =
  | "OUT_OF_RANGE"
  | "UNSUPPORTED_CHAR"
  | "UNSUPPORTED_EVENT"
  | "PERMISSION_DENIED"
  | "DEVICE_OFFLINE"
  | "INJECTION_FAILED";

/** Actionable control error. `wsCloseCode` carries the spec close code when
 *  the failure maps onto one (4401 PERMISSION_DENIED). */
export class GrpcControlError extends Error {
  readonly code: GrpcControlErrorCode;
  readonly wsCloseCode?: number;
  readonly details?: unknown;

  constructor(code: GrpcControlErrorCode, message: string, details?: unknown, wsCloseCode?: number) {
    super(message);
    this.name = "GrpcControlError";
    this.code = code;
    this.details = details;
    this.wsCloseCode = wsCloseCode;
  }
}

/** Map a grpc-js ServiceError onto our typed error (never a silent drop). */
function mapGrpcError(e: unknown): GrpcControlError {
  const err = e as { code?: number; message?: string };
  const message = err?.message ?? String(e);
  switch (err?.code) {
    case grpc.status.PERMISSION_DENIED:
      // Token/allowlist rejects the method (external launch, stale token).
      return new GrpcControlError("PERMISSION_DENIED", `emulator gRPC denied access: ${message}`, undefined, 4401);
    case grpc.status.UNAVAILABLE:
      return new GrpcControlError("DEVICE_OFFLINE", `emulator gRPC unreachable: ${message}`);
    case grpc.status.DEADLINE_EXCEEDED:
      return new GrpcControlError("INJECTION_FAILED", `emulator gRPC timed out: ${message}`);
    default:
      return new GrpcControlError("INJECTION_FAILED", `emulator gRPC injection failed: ${message}`);
  }
}

// ─── the control surface ─────────────────────────────────────────────────

export interface DisplaySize {
  width: number;
  height: number;
}

/** Input gestures the bridge/tools consume (physical-px space). */
export interface EmulatorControl {
  /** Tap at a physical pixel (validates against the device display first). */
  tap(x: number, y: number): Promise<void>;
  /** Swipe from (x1,y1) to (x2,y2); durationMs paces the MOVE steps. */
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<void>;
  /** Type UTF-8 text via sendKey(KeyboardEvent{text}) (design D3). */
  text(text: string): Promise<void>;
  /** Press a W3C key name (sendKey{key}) — probe D: GoHome. */
  keyPress(key: string): Promise<void>;
  /** Send a raw keycode in the given codeType (Usb=0, Evdev=1, XKB=2…). */
  keyCode(code: number, codeType?: number): Promise<void>;
  /** Current cached display size (physical px) once resolved. */
  reportDisplaySize(): DisplaySize | undefined;
  /** Refresh the display size from getDisplayConfigurations (main display). */
  refreshDisplay(): Promise<DisplaySize>;
}

interface TouchLike {
  x: number;
  y: number;
  identifier: number;
  pressure: number;
}

/** proto-loader options mirroring the probe (keepCase + defaults). */
const LOAD_OPTS = { includeDirs: [PROTOS_DIR], keepCase: true, defaults: true };

/**
 * A client-cancelled stream emits a CANCELLED error event that has no reader
 * once the iterator is gone — swallow it so teardown never crashes the
 * process with an unhandled stream error (idempotent noop listener).
 */
function swallowCancellation(stream: grpc.ClientReadableStream<unknown>): void {
  (stream as unknown as { on?: (ev: string, cb: () => void) => void }).on?.("error", () => {});
}

let serviceHolder:
  | { EmulatorController: new (addr: string, creds: grpc.ChannelCredentials) => grpc.Client }
  | undefined;
let loading: Promise<typeof serviceHolder> | undefined;

/** Load the vendored EmulatorController package once (reflection is blocked). */
function loadControllerPackage(): Promise<typeof serviceHolder> {
  if (serviceHolder) return Promise.resolve(serviceHolder);
  loading ??= protoLoader.load(EMULATOR_CONTROLLER_PROTO, LOAD_OPTS).then((pkg) => {
    const grpcObj = grpc.loadPackageDefinition(pkg) as unknown as {
      android: { emulation: { control: { EmulatorController: new (a: string, c: grpc.ChannelCredentials) => grpc.Client } } };
    };
    serviceHolder = { EmulatorController: grpcObj.android.emulation.control.EmulatorController };
    return serviceHolder;
  });
  return loading;
}

/**
 * gRPC-backed control client. Construction is inert; display geometry is
 * resolved lazily on the first gesture (or explicitly via refreshDisplay).
 */
export class GrpcEmulatorControl implements EmulatorControl {
  private readonly addr: string;
  private readonly token: string;
  private display: DisplaySize | undefined;

  constructor(addr: string, token: string, display?: DisplaySize) {
    this.addr = addr;
    this.token = token;
    this.display = display;
  }

  reportDisplaySize(): DisplaySize | undefined {
    return this.display;
  }

  private metadata(): grpc.Metadata {
    const meta = new grpc.Metadata();
    meta.add("authorization", `Bearer ${this.token}`);
    return meta;
  }

  /** ONE gRPC unary call against the vendored EmulatorController surface. */
  private async unary(method: "sendTouch" | "sendKey" | "getDisplayConfigurations", request: unknown): Promise<unknown> {
    await loadControllerPackage();
    const { EmulatorController } = serviceHolder!;
    const client = new EmulatorController(this.addr, grpc.credentials.createInsecure());
    const meta = this.metadata();
    const rpc = (client as unknown as Record<
      string,
      (req: unknown, m: grpc.Metadata, cb: (e: grpc.ServiceError | null, r?: unknown) => void) => void
    >)[method]?.bind(client);
    if (!rpc) throw new GrpcControlError("INJECTION_FAILED", `unsupported gRPC method: ${method}`);
    return new Promise<unknown>((resolve, reject) => {
      rpc(request as never, meta, (e, r) => (e ? reject(mapGrpcError(e)) : resolve(r)));
    }).finally(() => {
      client.close();
    });
  }

  async refreshDisplay(): Promise<DisplaySize> {
    await loadControllerPackage();
    try {
      const res = await this.unary("getDisplayConfigurations", {}) as {
        displays?: Array<{ width?: number; height?: number; display?: number }>;
      };
      const main = (res.displays ?? []).find((d) => (d.display ?? 0) === 0) ?? res.displays?.[0];
      if (!main || !main.width || !main.height) {
        throw new GrpcControlError("INJECTION_FAILED", "emulator reported no display configuration");
      }
      this.display = { width: main.width, height: main.height };
      return this.display;
    } catch (e) {
      if (e instanceof GrpcControlError) throw e;
      throw mapGrpcError(e);
    }
  }

  /** Client-side bounds check against the PHYSICAL display (design D5). */
  private async assertInBounds(x: number, y: number): Promise<void> {
    if (!this.display) await this.refreshDisplay();
    const d = this.display!;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= d.width || y >= d.height) {
      throw new GrpcControlError(
        "OUT_OF_RANGE",
        `coordinates out of physical display space (0..${d.width - 1}, 0..${d.height - 1})`,
        { x, y },
      );
    }
  }

  /** ONE unary sendTouch carrying the current contact set (protocol B). */
  private async sendTouch(touches: TouchLike[]): Promise<void> {
    await this.unary("sendTouch", { touches, display: 0 });
  }

  /** ONE unary sendKey. */
  private async sendKey(req: Record<string, unknown>): Promise<void> {
    await this.unary("sendKey", req);
  }

  async tap(x: number, y: number): Promise<void> {
    await this.assertInBounds(x, y);
    // DOWN (pressure 1) then UP (pressure 0) — the identifier must be closed.
    await this.sendTouch([{ x, y, identifier: 1, pressure: 1 }]);
    await this.sendTouch([{ x, y, identifier: 1, pressure: 0 }]);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 100): Promise<void> {
    await this.assertInBounds(x1, y1);
    await this.assertInBounds(x2, y2);
    const steps = Math.max(1, Math.min(20, Math.round(durationMs / 16)));
    await this.sendTouch([{ x: x1, y: y1, identifier: 1, pressure: 1 }]);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = Math.round(x1 + (x2 - x1) * t);
      const y = Math.round(y1 + (y2 - y1) * t);
      await this.sendTouch([{ x, y, identifier: 1, pressure: 1 }]);
    }
    await this.sendTouch([{ x: x2, y: y2, identifier: 1, pressure: 0 }]);
  }

  async text(text: string): Promise<void> {
    if (text.length === 0) {
      throw new GrpcControlError("UNSUPPORTED_CHAR", "text to inject must not be empty");
    }
    // No sendText RPC exists in 36.5.11 — text rides sendKey(KeyboardEvent{text})
    // (probe D, design D3); eventType keypress = keydown+keyup per char.
    await this.sendKey({ text, eventType: 2, codeType: 0 });
  }

  async keyPress(key: string): Promise<void> {
    if (key.length === 0) {
      throw new GrpcControlError("UNSUPPORTED_EVENT", "key name must not be empty");
    }
    await this.sendKey({ key, eventType: 2 }); // keypress
  }

  async keyCode(code: number, codeType = 0): Promise<void> {
    if (!Number.isInteger(code) || code < 0) {
      throw new GrpcControlError("OUT_OF_RANGE", "keyCode must be a non-negative integer", code);
    }
    await this.sendKey({ keyCode: code, codeType, eventType: 2 });
  }
}

// ─── RtcService v1 transport stubs (design D2, task 2.6) ─────────────────

/** One wire JSEP message off the server stream (envelope, verbatim). */
export interface JsepWireMessage {
  id: { guid: string };
  message: string;
}

interface RtcServiceHolder {
  Rtc: new (addr: string, creds: grpc.ChannelCredentials, options?: Record<string, unknown>) => grpc.Client;
}

let rtcHolder: RtcServiceHolder | undefined;
let rtcLoading: Promise<RtcServiceHolder> | undefined;

/** Load the vendored Rtc package once (reflection is allowlist-blocked). */
function loadRtcPackage(): Promise<RtcServiceHolder> {
  if (rtcHolder) return Promise.resolve(rtcHolder);
  rtcLoading ??= protoLoader.load(RTC_SERVICE_PROTO, LOAD_OPTS).then((pkg) => {
    const grpcObj = grpc.loadPackageDefinition(pkg) as unknown as {
      android: { emulation: { control: { Rtc: RtcServiceHolder["Rtc"] } } };
    };
    rtcHolder = { Rtc: grpcObj.android.emulation.control.Rtc };
    return rtcHolder;
  });
  return rtcLoading;
}

/**
 * gRPC-backed RtcService v1 client (the transport half of the RTC adapter,
 * design D2). One persistent channel for the whole session lifetime — unlike
 * the control surface, the JSEP receive stream MUST stay open per stream.
 *
 * The `authorization: Bearer <token>` metadata rides EVERY call (probe A:
 * without it → PERMISSION_DENIED, external-launch degradation path).
 */
export class GrpcRtcClient {
  private readonly addr: string;
  private readonly token: string;
  private rtc: grpc.Client | undefined;
  private ctrl: grpc.Client | undefined;
  /** Open server-stream calls per guid, so teardown can cancel them. */
  private readonly streams = new Map<string, grpc.ClientReadableStream<unknown>>();
  /** Guids whose cancel was requested before the stream finished opening. */
  private readonly cancelledGuids = new Set<string>();
  private closed = false;

  constructor(addr: string, token: string) {
    this.addr = addr;
    this.token = token;
  }

  private metadata(): grpc.Metadata {
    const meta = new grpc.Metadata();
    meta.add("authorization", `Bearer ${this.token}`);
    return meta;
  }

  private async ensureRtc(): Promise<grpc.Client> {
    if (this.rtc) return this.rtc;
    const { Rtc } = await loadRtcPackage();
    this.rtc = new Rtc(this.addr, grpc.credentials.createInsecure(), {
      "grpc.max_receive_message_length": MAX_RECEIVE_MESSAGE_LENGTH,
    });
    return this.rtc;
  }

  /** getStatus lives on EmulatorController — a second client over the same
   *  endpoint powers the watchdog probe (task 2.3). */
  private async ensureCtrl(): Promise<grpc.Client> {
    if (this.ctrl) return this.ctrl;
    await loadControllerPackage();
    const { EmulatorController } = serviceHolder!;
    this.ctrl = new EmulatorController(this.addr, grpc.credentials.createInsecure());
    return this.ctrl;
  }

  /** requestRtcStream → the per-stream opaque guid (RtcId). */
  async requestRtcStream(): Promise<string> {
    const client = await this.ensureRtc();
    const rpc = (client as unknown as Record<string, (req: unknown, m: grpc.Metadata, cb: (e: grpc.ServiceError | null, r?: unknown) => void) => void>)["requestRtcStream"]?.bind(client);
    if (!rpc) throw new GrpcControlError("INJECTION_FAILED", "unsupported gRPC method: requestRtcStream");
    const res = await new Promise<{ guid?: string }>((resolve, reject) => {
      rpc({}, this.metadata(), (e, r) => (e ? reject(mapGrpcError(e)) : resolve((r ?? {}) as { guid?: string })));
    });
    if (!res.guid) {
      throw new GrpcControlError("INJECTION_FAILED", "requestRtcStream returned no guid");
    }
    return res.guid;
  }

  /**
   * receiveJsepMessages — the BLOCKING server stream for one guid (v1:
   * `receiveJsepMessages(RtcId) returns (stream JsepMsg)`). The returned
   * iterable yields wire envelopes verbatim; `cancelReceive` ends it
   * (a cancelled stream ends the iteration — never a dangling read).
   */
  receiveJsepMessages(guid: string): AsyncIterable<JsepWireMessage> {
    const self = this;
    const iterate = async function* () {
      let stream: grpc.ClientReadableStream<unknown>;
      try {
        stream = await self.openStream(guid);
      } catch (e) {
        if (self.closed) return; // teardown raced the lazy open — clean end
        throw mapGrpcError(e);
      }
      if (self.closed || self.cancelledGuids.has(guid)) {
        self.streams.delete(guid);
        swallowCancellation(stream);
        stream.cancel();
        return;
      }
      try {
        for await (const raw of stream) {
          yield raw as JsepWireMessage;
        }
      } catch (e) {
        const code = (e as { code?: number }).code;
        if (code === grpc.status.CANCELLED) return; // teardown cancel — clean end
        throw mapGrpcError(e);
      } finally {
        self.streams.delete(guid);
      }
    };
    return {
      [Symbol.asyncIterator]: () => iterate(),
    };
  }

  /** Raw server-stream call, tracked for cancellation. */
  private async openStream(guid: string): Promise<grpc.ClientReadableStream<unknown>> {
    if (this.closed) {
      throw new GrpcControlError("DEVICE_OFFLINE", "rtc client is closed; no new receive stream");
    }
    const client = await this.ensureRtc();
    const rpc = (client as unknown as Record<
      string,
      (req: unknown, m: grpc.Metadata) => grpc.ClientReadableStream<unknown>
    >)["receiveJsepMessages"]?.bind(client);
    if (!rpc) throw new GrpcControlError("INJECTION_FAILED", "unsupported gRPC method: receiveJsepMessages");
    const stream = rpc({ guid }, this.metadata());
    this.streams.set(guid, stream);
    return stream;
  }

  /** sendJsepMessage — one JSEP dictionary (verbatim JSON payload). */
  async sendJsepMessage(guid: string, payload: string): Promise<void> {
    const client = await this.ensureRtc();
    const rpc = (client as unknown as Record<string, (req: unknown, m: grpc.Metadata, cb: (e: grpc.ServiceError | null, r?: unknown) => void) => void>)["sendJsepMessage"]?.bind(client);
    if (!rpc) throw new GrpcControlError("INJECTION_FAILED", "unsupported gRPC method: sendJsepMessage");
    await new Promise<void>((resolve, reject) => {
      rpc({ id: { guid }, message: payload }, this.metadata(), (e) => (e ? reject(mapGrpcError(e)) : resolve()));
    });
  }

  /** Watchdog probe: getStatus on EmulatorController (task 2.3). Throws a
   *  mapped GrpcControlError when the emulator is unreachable (DEVICE_OFFLINE)
   *  or denies the call (PERMISSION_DENIED → 4401). */
  async probe(): Promise<void> {
    const client = await this.ensureCtrl();
    const rpc = (client as unknown as Record<string, (req: unknown, m: grpc.Metadata, cb: (e: grpc.ServiceError | null, r?: unknown) => void) => void>)["getStatus"]?.bind(client);
    if (!rpc) throw new GrpcControlError("INJECTION_FAILED", "unsupported gRPC method: getStatus");
    await new Promise<void>((resolve, reject) => {
      rpc({}, this.metadata(), (e) => (e ? reject(mapGrpcError(e)) : resolve()));
    });
  }

  /** Cancel the receive stream for one guid (viewer teardown / bye). */
  cancelReceive(guid: string): void {
    this.cancelledGuids.add(guid);
    const stream = this.streams.get(guid);
    if (!stream) return;
    this.streams.delete(guid);
    swallowCancellation(stream);
    try {
      stream.cancel();
    } catch {
      // Already finished — nothing to cancel.
    }
  }

  /** Tear down the channel (session stop). Cancels every open stream. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const guid of [...this.streams.keys()]) this.cancelReceive(guid);
    this.rtc?.close();
    this.ctrl?.close();
    this.rtc = undefined;
    this.ctrl = undefined;
  }
}