import { FeedbackLoop } from "./controller";
import { buildSnapshot, type BridgeState } from "./snapshot";

/**
 * Headless OpenCode feedback-loop plugin (SDD Phase 5 — decision D4).
 *
 * The plugin is intentionally THIN — it is a relay. All device work lives in
 * the MCP tools / bridge daemon. On `session.idle` and `tool.execute.after`
 * it pulls a compact snapshot from the LOCAL BRIDGE (`GET /v1/state`, NOT MCP
 * tools — no MCP client wiring, per spec non-goal) and pushes it into the
 * session via `client.session.prompt({ noReply: true, ... })` without
 * triggering a reply. Pushes are debounced (2000ms) and content-hash deduped
 * by {@link FeedbackLoop}, and skipped entirely when no device is selected.
 *
 * On `experimental.session.compacting` the current snapshot is carried across
 * compaction via `output.context.push()`.
 *
 * Config (env):
 *   OPENMOBILE_BRIDGE_PORT   (default 8765)
 *   OPENMOBILE_BRIDGE_SECRET (optional shared secret; sent as X-OpenMobile-Secret)
 *
 * NOTE: The OpenCode hook names / signatures below follow the documented shape
 * (`async ({ project, client, $, directory, worktree }) => hooks`) and need
 * live verification against the installed OpenCode version (see design Open
 * Questions).
 */

export interface PluginContext {
  project?: string;
  client?: unknown;
  $?: unknown;
  directory?: string;
  worktree?: string;
}

/** Session-client surface the plugin needs — typed loosely (@opencode-ai/plugin not installed). */
export interface SessionClient {
  session?: {
    prompt?: (req: {
      sessionID?: string;
      prompt: string;
      noReply?: boolean;
      parts?: unknown[];
    }) => Promise<unknown>;
  };
}

export interface PluginHooks {
  "session.idle": () => void;
  "tool.execute.after": () => void;
  "experimental.session.compacting": (args: unknown) => Promise<void>;
}

/** Bridge `GET /v1/state` URL honouring the `OPENMOBILE_BRIDGE_PORT` knob. */
export function bridgeStateUrl(env: Record<string, string | undefined> = process.env): string {
  const port = env["OPENMOBILE_BRIDGE_PORT"] ?? "8765";
  return `http://127.0.0.1:${port}/v1/state`;
}

function resolveSecret(env: Record<string, string | undefined> = process.env): string | undefined {
  const s = env["OPENMOBILE_BRIDGE_SECRET"];
  return s && s.trim() !== "" ? s : undefined;
}

/**
 * Build the push closure that forwards a snapshot into the session without
 * triggering a reply. Exported for tests; used by the plugin factory.
 */
export function createPush(
  client: SessionClient | undefined,
  sessionID?: string,
): (snapshot: string) => Promise<void> {
  return async (snapshot: string) => {
    const prompt = client?.session?.prompt;
    if (!prompt) throw new Error("[openmobile-plugin] session.prompt unavailable");
    await prompt({
      ...(sessionID ? { sessionID } : {}),
      prompt: snapshot,
      noReply: true,
      parts: [],
    });
  };
}

/**
 * Assemble the hook set bound to a live client + loop. Exported separately so
 * the headless hook wiring is testable without the real OpenCode runtime.
 */
export function makePluginHooks(
  client: SessionClient | undefined,
  loop: FeedbackLoop,
): PluginHooks {
  return {
    "session.idle": () => loop.onData(),
    "tool.execute.after": () => loop.onData(),
    "experimental.session.compacting": async (args: unknown) => {
      const snap = loop.lastSnapshot();
      if (!snap) return;
      const a = (args ?? {}) as {
        context?: { push?: (part: unknown) => void };
        output?: { context?: { push?: (part: unknown) => void } };
      };
      const ctx = a.context ?? a.output?.context;
      try {
        // Carry current device state so it survives compaction.
        ctx?.push?.({ type: "text", text: snap });
      } catch {
        // non-fatal: compaction must never crash the session
      }
    },
  };
}

/** Optional dependency overrides for tests. */
export interface PluginDeps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  throttleMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * Default export: the OpenCode plugin entrypoint. Shape:
 *   async ({ project, client, $, directory, worktree }) => hooks
 */
export default async function plugin(
  opts: PluginContext,
  deps: PluginDeps = {},
): Promise<PluginHooks> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const client = (opts.client ?? {}) as SessionClient;
  const url = bridgeStateUrl(env);
  const secret = resolveSecret(env);
  // sessionID is only available when the runtime surfaces it on the client/
  // session instance; otherwise it is omitted (client is session-bound anyway).
  const sessionID =
    (opts.$ as { id?: string } | undefined)?.id ??
    (client as { sessionID?: string }).sessionID;

  const loop = new FeedbackLoop({
    throttleMs: deps.throttleMs,
    fetchState: async (): Promise<BridgeState> => {
      const headers: Record<string, string> = {};
      if (secret) headers["X-OpenMobile-Secret"] = secret;
      const res = await fetchImpl(url, { headers });
      if (!res.ok) {
        throw new Error(`[openmobile-plugin] bridge ${url} -> HTTP ${res.status}`);
      }
      return (await res.json()) as BridgeState;
    },
    push: createPush(client, sessionID),
    onError: deps.onError,
  });

  return makePluginHooks(client, loop);
}
