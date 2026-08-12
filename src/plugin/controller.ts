import { buildSnapshot, hasUsableDevice, sha256, type BridgeState } from "./snapshot";

/**
 * Feedback-loop throttler/deduplicator (SDD Phase 5 — decision D4).
 *
 * Turns a stream of hook events (session.idle / tool.execute.after) into a
 * single, content-change-only push:
 *   - **2000ms debounce** — rapid tool bursts coalesce to ≤1 push (trailing edge).
 *   - **content-hash dedupe** — a push is skipped unless the snapshot bytes differ.
 *   - **skip when no device** — no push when there is no usable selected device.
 *   - **bridge-down tolerance** — a failed fetch logs via `onError` and skips,
 *     never throwing into the OpenCode hook machinery.
 *
 * The push function is injected so this class stays UI/runtime-agnostic and
 * fully unit-testable without the real OpenCode runtime.
 */
export interface FeedbackLoopDeps {
  /** Debounce window in ms (default 2000 per design D4). */
  throttleMs?: number;
  /** Fetch the bridge `/v1/state`. May throw when the bridge is down. */
  fetchState: () => Promise<BridgeState>;
  /** Deliver a compact snapshot into the session (noReply). */
  push: (snapshot: string) => Promise<void>;
  /** Content hasher (defaults to SHA-256). Overridable for tests. */
  hash?: (s: string) => Promise<string>;
  /** Error sink for non-fatal failures (bridge down). */
  onError?: (err: unknown) => void;
}

export class FeedbackLoop {
  private readonly throttleMs: number;
  private readonly fetchState: () => Promise<BridgeState>;
  private readonly pushFn: (snapshot: string) => Promise<void>;
  private readonly hash: (s: string) => Promise<string>;
  private readonly onError: (err: unknown) => void;

  private lastHash = "";
  private currentSnapshot: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(deps: FeedbackLoopDeps) {
    this.throttleMs = deps.throttleMs ?? 2000;
    this.fetchState = deps.fetchState;
    this.pushFn = deps.push;
    this.hash = deps.hash ?? sha256;
    this.onError = deps.onError ?? (() => {});
  }

  /**
   * Event-hook entry (session.idle / tool.execute.after). Non-blocking — it
   * resets the debounce timer and returns immediately so hooks stay cheap.
   */
  onData(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.throttleMs);
  }

  /** Last successfully-built snapshot, for compaction persistence. */
  lastSnapshot(): string | null {
    return this.currentSnapshot;
  }

  /** Fetch → build → maybe-push, guarded by dedupe + skip rules. */
  async flush(): Promise<void> {
    if (this.flushing) return; // coalesce concurrent flushes
    this.flushing = true;
    try {
      let state: BridgeState;
      try {
        state = await this.fetchState();
      } catch (err) {
        this.onError(err); // bridge down → log + skip, never crash
        return;
      }
      if (!hasUsableDevice(state)) return; // no selected device → skip push
      const snapshot = buildSnapshot(state);
      if (snapshot === null) return;
      const h = await this.hash(snapshot);
      if (h === this.lastHash) return; // content unchanged → dedupe
      this.lastHash = h;
      this.currentSnapshot = snapshot;
      await this.pushFn(snapshot);
    } finally {
      this.flushing = false;
    }
  }
}
