/**
 * Logcat live-stream hub (bridge-surface-v2 Phase 4, design D5).
 *
 * ONE long-lived `adb -s <serial> logcat -T <backlog + HEADER_SLACK> -v time`
 * spawn PER SUBSCRIBER: replay and live come from the same process, so there
 * is no gap/duplication window between the backlog cut and live pumping.
 *
 * Replay accounting (SPIKE-2 pin, test/logcat-backlog-accounting.test.ts):
 * the spawn over-fetches by HEADER_SLACK so the requested number of PARSED
 * lines is available under either header-accounting hypothesis, while the
 * server-side cut counts matching parsed lines ONLY. A force-flip guard
 * moves a subscriber to live once backlog + slack + startup-headers lines
 * have been seen without reaching the target — a device buffer holding fewer
 * matching records than requested must still reach `{"type":"live"}`.
 */
import { z } from "zod";
import {
  LOGCAT_BACKLOG_CAP,
  LOGCAT_BACKLOG_DEFAULT,
  LOGCAT_QUEUE_DEPTH,
  LOGCAT_SUBSCRIBER_CAP,
  WS_CLOSE_CODES,
} from "./types";
import {
  LOGCAT_TAG_RE,
  parseLogcatTimeLine,
  type LogcatFollowHandle,
  type LogcatFollowOptions,
  type LogcatPriority,
  type ParsedLogLine,
} from "../device/adb";

/**
 * SPIKE-2 pin (task 0.2): `-T <n>` may charge buffer headers against the
 * count on some devices — fetch this many EXTRA slots defensively.
 */
export const LOGCAT_HEADER_SLACK = 3;
/** Startup headers adb may print (main/system/crash), outside or inside `-T`. */
export const LOGCAT_MAX_STARTUP_HEADERS = 3;

/** Severity rank: V < D < I < W < E < F < S (S = silent, highest). */
const PRIORITY_RANK: Record<string, number> = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, S: 6 };

export interface LogcatFilter {
  /** Deliver only these tags; omitted/empty means ALL tags. */
  tags?: string[];
  /** Priority floor; default E (consistent with read_logcat). */
  priority?: LogcatPriority;
}

/**
 * THE stream predicate — applied IDENTICALLY to replay and live pumping
 * (spec: tag union ∩ priority floor). Unknown priorities never match.
 */
export function logcatLineMatches(line: ParsedLogLine, filter: LogcatFilter): boolean {
  const tags = filter.tags ?? [];
  if (tags.length > 0 && !tags.includes(line.tag)) return false;
  const floor = PRIORITY_RANK[filter.priority ?? "E"] ?? PRIORITY_RANK.E!;
  return (PRIORITY_RANK[line.priority] ?? -1) >= floor;
}

/** Clamp a requested backlog into [0, LOGCAT_BACKLOG_CAP], defaulting to 100. */
export function clampBacklog(raw: number | undefined): number {
  if (raw === undefined) return LOGCAT_BACKLOG_DEFAULT;
  return Math.min(LOGCAT_BACKLOG_CAP, Math.max(0, Math.trunc(raw)));
}

/**
 * adb-side whitelist mirroring the same predicate (bandwidth optimization
 * ONLY — the hub re-applies logcatLineMatches server-side so replay and live
 * filtering stay identical regardless of adb counting quirks): each
 * subscribed tag at the floor, then silence-everything-else. No tags ⇒ no
 * specs ⇒ all lines flow and only the floor applies.
 */
export function filterspecsFor(filter: LogcatFilter): string[] {
  const tags = filter.tags ?? [];
  if (tags.length === 0) return [];
  const floor = filter.priority ?? "E";
  return [...tags.map((t) => `${t}:${floor}`), "*:S"];
}

/** Minimal socket surface the hub needs (Bun.ServerWebSocket satisfies it). */
export interface LogcatSocket {
  /**
   * Deliver one serialized JSON frame to the client. MAY return a promise —
   * when it does, the pump awaits it (Fanout drain precedent): a stalled
   * reader backpressures into the bounded queue instead of blocking adb.
   */
  send(frameJson: string): Promise<void> | void;
  close(code: number, reason: string): void;
  /** Server-side liveness probe; absent ⇒ treated as always open. */
  readonly open?: boolean;
}

/** Narrow spawner contract consumed by the hub (BridgeDeps.adb.logcatFollow). */
export interface LogcatFollowSpawner {
  logcatFollow(
    serial: string,
    opts: LogcatFollowOptions,
    onLine: (line: string) => void,
  ): LogcatFollowHandle;
}

/**
 * THE one filter frame a client may send after upgrade (spec: Stream Filter
 * Subscription). Strict on unknown keys; tags restricted to [A-Za-z0-9._-]+;
 * priority enum V..S; backlog must be an int ≥ 0 (oversized values are
 * CLAMPED by the hub, not rejected — spec: Cap enforced on oversized backlog).
 */
export const logcatFilterFrameSchema = z.strictObject({
  tags: z.array(z.string().regex(LOGCAT_TAG_RE)).optional(),
  priority: z.enum(["V", "D", "I", "W", "E", "F", "S"]).optional(),
  backlog: z.number().int().min(0).optional(),
});

export type LogcatFilterFrame = z.output<typeof logcatFilterFrameSchema>;

/** Tunables for hub-level teardown and watchdog behavior (tests override). */
export interface LogcatHubOptions {
  /**
   * Grace between the graceful stop (SIGTERM in production) and the SIGKILL
   * escalation for a child that refuses to die. Default 1000ms.
   */
  killGraceMs?: number;
  /**
   * Attached-device probe (production: deps.adb.devices) driving the
   * mid-stream detach watchdog (task 4.9). Absent ⇒ no watchdog.
   */
  devices?: () => Promise<{ serial: string }[]>;
  /** Watchdog poll interval in ms (default 5000; ≤0 disables the timer). */
  pollMs?: number;
}

/** Default SIGKILL grace for teardown (design D5 risk-mitigation row). */
const LOGCAT_KILL_GRACE_MS = 1_000;

/** Default interval between adb.devices() watchdog polls (design D5). */
const LOGCAT_WATCHDOG_POLL_MS = 5_000;

/**
 * Handle contract the hub consumes. Production handles expose BOTH members:
 * stop() (graceful SIGTERM) and the forceStop() SIGKILL escalation this hub
 * fires from its killGraceMs timer; members stay OPTIONAL so minimal test
 * doubles degrade gracefully — absent forceStop ⇒ no escalation armed.
 */
type KillableHandle = LogcatFollowHandle & { forceStop?(): Promise<void> | void };

export class LogcatHub {
  private readonly spawner: LogcatFollowSpawner;
  private readonly killGraceMs: number;
  private readonly devices?: () => Promise<{ serial: string }[]>;
  private readonly pollMs: number;
  /** Live subscriber registry — the cap is enforced against THIS set. */
  private readonly subscribers = new Set<LogcatSubscription>();
  /** Watchdog interval handle; started lazily, stopped when idle. */
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private checkingDevices = false;

  constructor(spawner: LogcatFollowSpawner, options: LogcatHubOptions = {}) {
    this.spawner = spawner;
    this.killGraceMs = options.killGraceMs ?? LOGCAT_KILL_GRACE_MS;
    this.devices = options.devices;
    this.pollMs = options.pollMs ?? LOGCAT_WATCHDOG_POLL_MS;
  }

  /** Current live-subscriber count (cap diagnostics). */
  get count(): number {
    return this.subscribers.size;
  }

  /**
   * Register a socket as a logcat subscriber. The child process spawns only
   * once the client sends its (single) filter frame. Over-cap attempts are
   * refused with a VIEWER_CAP error frame + close 4429 (design D5) and get
   * an inert subscription object back — late frames on that dead connection
   * are no-ops.
   */
  subscribe(socket: LogcatSocket, serial: string): LogcatSubscription {
    if (this.subscribers.size >= LOGCAT_SUBSCRIBER_CAP) {
      const dead = new LogcatSubscription(this.spawner, socket, serial);
      dead.rejectCapacity();
      return dead;
    }
    const sub = new LogcatSubscription(
      this.spawner,
      socket,
      serial,
      {
        onEnded: () => {
          this.subscribers.delete(sub);
          this.stopWatchdogIfIdle();
        },
        killGraceMs: this.killGraceMs,
      },
    );
    this.subscribers.add(sub);
    this.startWatchdog();
    return sub;
  }

  /**
   * Orphan sweep (task 4.8, design risk row): reap subscribers whose socket
   * is dead but whose teardown never ran (a missed close event). Reaping is
   * the SAME path as a client close — SIGTERM now, SIGKILL after the grace
   * timer — so nothing keeps an adb child alive behind a dead socket.
   */
  sweep(): void {
    for (const sub of [...this.subscribers]) {
      if (sub.isSocketClosed()) sub.cancel();
    }
  }

  /**
   * ONE watchdog poll cycle (task 4.9): every live subscriber whose serial
   * no longer appears in adb.devices() is closed 4409 DEVICE_LOST naming the
   * serial and torn down. A failing probe is "cannot verify" — transient adb
   * breakage must NEVER mass-teardown healthy subscribers. The interval
   * version runs automatically; tests may call this directly.
   */
  async checkDevices(): Promise<void> {
    if (!this.devices || this.checkingDevices || this.subscribers.size === 0) return;
    this.checkingDevices = true;
    try {
      const attached = await this.devices().catch(() => null);
      if (!attached) return;
      for (const sub of [...this.subscribers]) {
        if (!attached.some((d) => d.serial === sub.targetSerial)) sub.deviceLost();
      }
    } finally {
      this.checkingDevices = false;
    }
  }

  private startWatchdog(): void {
    if (!this.devices || this.watchTimer !== null || this.pollMs <= 0) return;
    this.watchTimer = setInterval(() => void this.checkDevices(), this.pollMs);
    // Never hold the process open just for the watchdog.
    this.watchTimer.unref?.();
  }

  private stopWatchdogIfIdle(): void {
    if (this.watchTimer !== null && this.subscribers.size === 0) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }
}

type Phase = "await-filter" | "replay" | "live" | "dead";

/** Policy-violation close for malformed/duplicate filter frames. */
const FILTER_CLOSE_CODE = 1008;

export class LogcatSubscription {
  private phase: Phase = "await-filter";
  private filter: LogcatFilter = {};
  private backlogTarget = 0;
  private delivered = 0;
  private totalLines = 0;
  private handle: LogcatFollowHandle | null = null;
  private readonly spawner: LogcatFollowSpawner;
  private readonly socket: LogcatSocket;
  private readonly serial: string;
  /** Invoked exactly once when the subscription stops being live. */
  private readonly onEnded?: () => void;
  /** Grace between SIGTERM and the SIGKILL escalation (hub policy). */
  private readonly killGraceMs: number;
  /** Depth-bounded FIFO of serialized frames (drop-oldest when full). */
  private readonly queue: string[] = [];
  /** One drain worker at a time, so frame order is preserved. */
  private draining = false;
  /** Drops since the last opportunistic `{"type":"dropped"}` notice. */
  private droppedPending = 0;

  constructor(
    spawner: LogcatFollowSpawner,
    socket: LogcatSocket,
    serial: string,
    hooks: { onEnded?: () => void; killGraceMs?: number } = {},
  ) {
    this.spawner = spawner;
    this.socket = socket;
    this.serial = serial;
    this.onEnded = hooks.onEnded;
    this.killGraceMs = hooks.killGraceMs ?? LOGCAT_KILL_GRACE_MS;
  }

  /**
   * WS message entry point: the ONE filter frame this connection accepts.
   * Anything malformed (bad JSON, schema violation) yields an actionable
   * error frame followed by a policy close — and never spawns a child. A
   * SECOND frame on an already-negotiated connection is the same protocol
   * violation, and tears the just-started stream down with it.
   */
  handleFrame(text: string): void {
    if (this.phase !== "await-filter") {
      this.reject("protocol violation: exactly one filter frame is allowed per connection");
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      this.reject("filter frame is not valid JSON");
      return;
    }
    const parsedFrame = logcatFilterFrameSchema.safeParse(body);
    if (!parsedFrame.success) {
      const issue = parsedFrame.error.issues[0];
      this.reject(issue ? `invalid filter frame: ${issue.message}` : "invalid filter frame");
      return;
    }
    this.start(parsedFrame.data);
  }

  /** Client disconnect / route teardown: stop reading, release the child. */
  cancel(): void {
    if (this.phase === "dead") return;
    this.phase = "dead";
    this.teardownChild();
  }

  /**
   * Over-cap refusal (task 4.7): VIEWER_CAP error frame + close 4429, the
   * same code the video fanout uses for its viewer cap. The subscription is
   * born dead — no child is ever spawned for it.
   */
  rejectCapacity(): void {
    this.phase = "dead";
    this.socket.send(
      JSON.stringify({
        error: { code: "VIEWER_CAP", message: "logcat subscriber cap reached (8)" },
      }),
    );
    this.socket.close(WS_CLOSE_CODES.VIEWER_CAP, "logcat subscriber cap reached (8)");
  }

  /** Error frame (design §WS protocol) + policy close + child release. */
  private reject(message: string): void {
    if (this.phase === "dead") return;
    this.phase = "dead";
    this.socket.send(JSON.stringify({ type: "error", code: "validation_error", message }));
    this.socket.close(FILTER_CLOSE_CODE, message);
    this.teardownChild();
  }

  /**
   * Server-side liveness probe for the orphan sweep (task 4.8): true when
   * the socket reports itself closed. Sockets without a probe are assumed
   * alive.
   */
  isSocketClosed(): boolean {
    return this.socket.open === false;
  }

  /** The serial this subscription streams from (watchdog lookup key). */
  get targetSerial(): string {
    return this.serial;
  }

  /**
   * Mid-stream detach (task 4.9): the watchdog proved the serial is gone —
   * close 4409 with an actionable reason NAMING the serial (spec: Device
   * loss mid-stream, never a silent hang) and release the child. A natural
   * child exit at detach converges on this same close path via the poll.
   */
  deviceLost(): void {
    if (this.phase === "dead") return;
    this.phase = "dead";
    this.socket.close(WS_CLOSE_CODES.DEVICE_LOST, `device lost: ${this.serial}`);
    this.teardownChild();
  }

  private teardownChild(): void {
    const handle = this.handle as KillableHandle | null;
    this.handle = null;
    if (handle) {
      // Graceful stop FIRST — SIGTERM in production adb terms.
      const stopped = handle.stop();
      // SIGKILL escalation after the grace timer, ONLY while the graceful
      // stop is still outstanding; a promptly reaped child never sees it.
      if (handle.forceStop) {
        const killer = setTimeout(() => {
          void handle.forceStop?.();
        }, this.killGraceMs);
        void (async () => {
          try {
            await stopped;
          } catch {
            // read-loop errors surface through stop(); nothing to escalate
          } finally {
            clearTimeout(killer);
          }
        })();
      }
    }
    // Registry removal happens exactly once, at the dead transition.
    this.onEnded?.();
  }

  private start(frame: LogcatFilterFrame): void {
    this.filter = { tags: frame.tags, priority: frame.priority };
    this.backlogTarget = clampBacklog(frame.backlog);
    // SPIKE-2: over-fetch by HEADER_SLACK whenever history was requested.
    const tail = this.backlogTarget > 0 ? this.backlogTarget + LOGCAT_HEADER_SLACK : 0;
    const opts: LogcatFollowOptions = { tail, filterspecs: filterspecsFor(this.filter) };
    this.handle = this.spawner.logcatFollow(this.serial, opts, (line) => this.onRawLine(line));
    if (this.backlogTarget === 0) this.goLive();
    else this.phase = "replay";
  }

  private onRawLine(line: string): void {
    if (this.phase === "dead") return;
    this.totalLines += 1;
    if (this.phase === "live") {
      const parsed = parseLogcatTimeLine(line);
      if (parsed && logcatLineMatches(parsed, this.filter)) this.deliverLine(parsed);
      return;
    }
    // Replay phase: deliver matching parsed lines toward the target…
    const parsed = parseLogcatTimeLine(line);
    if (parsed && logcatLineMatches(parsed, this.filter)) {
      this.deliverLine(parsed);
      this.delivered += 1;
      if (this.delivered >= this.backlogTarget) this.goLive();
      return;
    }
    // …and force-flip once the whole -T window has drained without reaching
    // it (short device buffer): every kind of line proves the window moved.
    if (
      this.totalLines >=
      this.backlogTarget + LOGCAT_HEADER_SLACK + LOGCAT_MAX_STARTUP_HEADERS
    ) {
      this.goLive();
    }
  }

  private goLive(): void {
    if (this.phase === "live" || this.phase === "dead") return;
    this.phase = "live";
    this.enqueue(JSON.stringify({ type: "live" }));
  }

  /**
   * Backpressure boundary (task 4.6, Fanout drain precedent): frames land in
   * a depth-bounded FIFO and ONE drain worker delivers them in order. When
   * the reader stalls, the OLDEST queued frame is dropped so the newest keep
   * flowing; the cumulative count is reported opportunistically in a single
   * `{"type":"dropped","count":n}` notice once the queue catches up. The
   * socket is never closed for being slow (spec: Slow consumer stays
   * connected).
   */
  private enqueue(frameJson: string): void {
    if (this.phase === "dead") return;
    if (this.queue.length >= LOGCAT_QUEUE_DEPTH) {
      this.queue.shift(); // drop oldest
      this.droppedPending += 1;
    }
    this.queue.push(frameJson);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        while (this.queue.length > 0 && this.socketOpen() && this.phase !== "dead") {
          const frame = this.queue.shift()!;
          // Sync fast path: a synchronously-buffered transport (real Bun WS)
          // delivers WITHOUT yielding — frame order and call-frame timing
          // stay identical to the pre-queue behavior. Only a genuinely
          // pending send promise (stalled reader) suspends the worker.
          const result = this.socket.send(frame);
          if (result instanceof Promise) await result;
        }
        if (this.droppedPending > 0 && this.socketOpen() && this.phase !== "dead") {
          const count = this.droppedPending;
          this.droppedPending = 0;
          // Flush the notice, then loop again: lines enqueued while it was
          // in flight must still be delivered after it.
          const notice = this.socket.send(JSON.stringify({ type: "dropped", count }));
          if (notice instanceof Promise) await notice;
          continue;
        }
        break;
      }
    } finally {
      this.draining = false;
    }
  }

  private socketOpen(): boolean {
    return this.socket.open !== false;
  }

  /** Key order mirrors the design §WS protocol example byte-for-byte. */
  private deliverLine(parsed: ParsedLogLine): void {
    this.enqueue(
      JSON.stringify({
        type: "line",
        ts: parsed.ts,
        priority: parsed.priority,
        tag: parsed.tag,
        pid: parsed.pid,
        message: parsed.message,
      }),
    );
  }
}
