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

/** gRPC port the emulator listens on (per-instance ini usually overrides). */
export const DEFAULT_GRPC_PORT = 8554;

/** Minimum emulator version for the gRPC control surface (36.5.11). */
export const MIN_EMULATOR_VERSION = { major: 36, minor: 5, patch: 11 } as const;
/** Version from which `-rtcfps` exists (unknown option on 36.5.11). */
export const RTCPFS_VERSION = { major: 36, minor: 6, patch: 0 } as const;

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
    return { token: ini["grpc.token"]!, port: Number.isInteger(port) ? port : DEFAULT_GRPC_PORT };
  }
  return null;
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