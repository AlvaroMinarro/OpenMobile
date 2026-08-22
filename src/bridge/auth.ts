/**
 * Opt-in authentication surface for the `/v1` bridge daemon
 * (bridge-surface-v2 design D2/D6).
 *
 * One seed secret (`OPENMOBILE_BRIDGE_SECRET`) enables auth for every REST
 * route and WS upgrade. The seed is retained ONLY as a SHA-256 digest; issued
 * tokens are stored as SHA-256(token) -> expiry in daemon memory. Every
 * credential comparison goes through `constantTimeHex` (node:crypto
 * timingSafeEqual over equal-length digests) and no error path ever echoes a
 * presented credential.
 *
 * Seed unset ⇒ `enabled:false` — callers short-circuit to the legacy
 * unauthenticated behavior with zero observable drift.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Default token TTL (`OPENMOBILE_BRIDGE_TOKEN_TTL` unset), seconds. */
export const DEFAULT_TOKEN_TTL_SECONDS = 3600;
/** Server-enforced TTL cap default (`OPENMOBILE_BRIDGE_TOKEN_TTL_MAX` unset). */
export const DEFAULT_TOKEN_TTL_MAX_SECONDS = 86400;
/** Minimum mintable TTL, seconds (design D2 clamp floor). */
export const TOKEN_TTL_MIN_SECONDS = 60;
/** Random bytes per issued token (32B → 43-char base64url, RFC6455 token grammar). */
export const TOKEN_BYTES = 32;
/** Subprotocol entry prefix carrying a WS credential (design D1). */
export const SUBPROTOCOL_PREFIX = "openmobile.bearer.";

/** Parsed auth configuration. Raw secrets never live here — only digests. */
export interface AuthConfig {
  /** False when no seed is configured: every gate short-circuits off. */
  readonly enabled: boolean;
  /** SHA-256 hex of the seed secret ("" when disabled). */
  readonly seedHash: string;
  readonly ttlDefaultSeconds: number;
  readonly ttlMaxSeconds: number;
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Timing-safe equality over hex digests. Callers MUST compare hashes (not raw
 * secrets) so both buffers are equal-length before timingSafeEqual.
 */
export function constantTimeHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Parse a positive-integer seconds knob; throws on garbage (fail fast). */
function parseTtlSeconds(raw: string | undefined, fallback: number, envName: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${envName} must be an integer >= 1 (seconds), got "${raw}"`);
  }
  return n;
}

/** Build the auth surface from env. Seed missing/empty ⇒ disabled fast path. */
export function parseAuthConfig(env: Record<string, string>): AuthConfig {
  const seed = env["OPENMOBILE_BRIDGE_SECRET"] ?? "";
  const enabled = seed !== "";
  return {
    enabled,
    seedHash: enabled ? sha256Hex(seed) : "",
    ttlDefaultSeconds: parseTtlSeconds(
      env["OPENMOBILE_BRIDGE_TOKEN_TTL"],
      DEFAULT_TOKEN_TTL_SECONDS,
      "OPENMOBILE_BRIDGE_TOKEN_TTL",
    ),
    ttlMaxSeconds: parseTtlSeconds(
      env["OPENMOBILE_BRIDGE_TOKEN_TTL_MAX"],
      DEFAULT_TOKEN_TTL_MAX_SECONDS,
      "OPENMOBILE_BRIDGE_TOKEN_TTL_MAX",
    ),
  };
}

// ─── Issued-token registry (D2: SHA-256(token) -> expiry, daemon memory) ────

/** Verdict for a presented credential (design D2 error codes). */
export type CredentialVerdict = "valid" | "unauthorized" | "token_expired";

/**
 * In-memory registry of issued tokens. Stores ONLY SHA-256(token) -> expiry
 * (never raw tokens); expired entries are purged lazily during validation.
 */
export class TokenRegistry {
  private readonly entries = new Map<string, number>();

  /** Number of live entries (test observability for lazy purge). */
  get size(): number {
    return this.entries.size;
  }

  /** Register an issued token by hashing it; raw token never retained. */
  register(token: string, expiresAtMs: number): void {
    this.entries.set(sha256Hex(token), expiresAtMs);
  }

  /**
   * Validate a presented credential against issued tokens. Walks the (small)
   * registry with timing-safe digest comparison, lazily purging expired
   * entries as it goes.
   */
  validate(credential: string, nowMs: number = Date.now()): CredentialVerdict {
    const digest = sha256Hex(credential);
    let verdict: CredentialVerdict = "unauthorized";
    for (const [hash, expiresAtMs] of this.entries) {
      if (expiresAtMs <= nowMs) {
        // Lazy purge — expired entries never authenticate anything.
        if (constantTimeHex(hash, digest)) verdict = "token_expired";
        this.entries.delete(hash);
        continue;
      }
      if (constantTimeHex(hash, digest)) verdict = "valid";
    }
    return verdict;
  }
}

/** Clamp a requested TTL to [TOKEN_TTL_MIN_SECONDS, cfg.ttlMaxSeconds]. */
export function clampTtlSeconds(requested: number | undefined, cfg: AuthConfig): number {
  const v = requested ?? cfg.ttlDefaultSeconds;
  return Math.min(Math.max(v, TOKEN_TTL_MIN_SECONDS), cfg.ttlMaxSeconds);
}

/** Mint a 32-byte random base64url token (valid RFC6455 token grammar). */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** A minted token as returned by POST /v1/auth/token (design D2). */
export interface IssuedToken {
  token: string;
  /** Absolute ISO-8601 expiry timestamp. */
  expiresAt: string;
  /** Effective TTL after clamping to [TOKEN_TTL_MIN_SECONDS, cfg.ttlMaxSeconds]. */
  ttlSeconds: number;
}

/**
 * Mint + register a token: hash stored, raw token only in the return value.
 * TTL clamps to [60, cap]; default applies when no value is requested.
 */
export function issueToken(
  cfg: AuthConfig,
  registry: TokenRegistry,
  requestedTtlSeconds?: number,
  nowMs: number = Date.now(),
): IssuedToken {
  const ttlSeconds = clampTtlSeconds(requestedTtlSeconds, cfg);
  const token = generateToken();
  const expiresAtMs = nowMs + ttlSeconds * 1000;
  registry.register(token, expiresAtMs);
  return { token, expiresAt: new Date(expiresAtMs).toISOString(), ttlSeconds };
}

/** Timing-safe check that a presented credential IS the seed (admin power). */
export function isSeedCredential(cfg: AuthConfig, credential: string): boolean {
  return cfg.enabled && constantTimeHex(sha256Hex(credential), cfg.seedHash);
}

// ─── Credential carriers + the single authenticate() seam (D6) ──────────────

/** `Authorization: Bearer <cred>` carrier; null when absent or another scheme. */
export function bearerCredential(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const m = /^Bearer[ \t]+([!#$%&'*+.^`|~0-9A-Za-z_-]+)[ \t]*$/i.exec(header.trim());
  return m?.[1] ?? null;
}

/** Legacy `X-OpenMobile-Secret: <seed>` carrier; null when absent/empty. */
export function legacySecretHeader(req: Request): string | null {
  const value = req.headers.get("x-openmobile-secret");
  return value ? value : null;
}

/**
 * Scan `sec-websocket-protocol` for an EXACT entry `openmobile.bearer.<cred>`
 * (design D1). Returns the matched entry (echoed verbatim on success) plus its
 * credential, or null. Query params are deliberately never consulted.
 */
export function subprotocolCredential(
  req: Request,
): { entry: string; credential: string } | null {
  const header = req.headers.get("sec-websocket-protocol");
  if (!header) return null;
  for (const part of header.split(",")) {
    const entry = part.trim();
    if (!entry.startsWith(SUBPROTOCOL_PREFIX)) continue;
    const credential = entry.slice(SUBPROTOCOL_PREFIX.length);
    if (credential.length > 0) return { entry, credential };
  }
  return null;
}

/**
 * Validate any presented credential: timing-safe seed-hash compare first,
 * then the issued-token registry. Never echoes the credential.
 */
export function validateCredential(
  cfg: AuthConfig,
  registry: TokenRegistry,
  credential: string,
  nowMs: number = Date.now(),
): CredentialVerdict {
  if (!cfg.enabled) return "valid"; // disabled fast path — callers gate on enabled
  if (constantTimeHex(sha256Hex(credential), cfg.seedHash)) return "valid";
  return registry.validate(credential, nowMs);
}

/** Fixed-message 401; codes/messages never contain presented credentials. */
export function unauthorizedResponse(code: "unauthorized" | "token_expired"): Response {
  const message =
    code === "token_expired"
      ? "token has expired; mint a fresh one via POST /v1/auth/token"
      : "missing or invalid credentials";
  return new Response(JSON.stringify({ error: { code, message } }), {
    status: 401,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * THE single auth seam (design D6): one invocation in fetch before dispatch
 * and one before any server.upgrade(). Returns a 401 Response on denial,
 * null when the request may proceed (or when auth is disabled — byte-identical
 * fast path). Accepts `Authorization: Bearer <seed|token>` or the legacy
 * `X-OpenMobile-Secret: <seed>` header.
 */
export function authenticateRequest(
  cfg: AuthConfig | undefined,
  registry: TokenRegistry,
  req: Request,
): Response | null {
  if (!cfg?.enabled) return null;
  const credential = bearerCredential(req) ?? legacySecretHeader(req);
  if (credential === null) return unauthorizedResponse("unauthorized");
  const verdict = validateCredential(cfg, registry, credential);
  if (verdict === "valid") return null;
  return unauthorizedResponse(verdict === "token_expired" ? "token_expired" : "unauthorized");
}
