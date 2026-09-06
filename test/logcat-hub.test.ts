/**
 * LogcatHub replay/live pump contracts (bridge-surface-v2 Phase 4,
 * tasks 4.3–4.5, design D5).
 *
 * The hub is driven directly through its public surface with a FAKE
 * logcatFollow spawn double (no adb, no device): tests script the raw lines
 * the child would emit and observe the exact JSON frames the subscriber's
 * socket receives. Wire shapes are pinned byte-for-byte where design §WS
 * protocol fixes them.
 */
import { describe, expect, it } from "bun:test";
import {
  LOGCAT_BACKLOG_CAP,
  LOGCAT_QUEUE_DEPTH,
  LOGCAT_SUBSCRIBER_CAP,
} from "../src/stream/types";
import {
  clampBacklog,
  logcatFilterFrameSchema,
  LogcatHub,
  logcatLineMatches,
  type LogcatFilter,
  type LogcatSocket,
} from "../src/stream/logcatHub";
import {
  parseLogcatTimeLine,
  type LogcatFollowHandle,
  type LogcatFollowOptions,
} from "../src/device/adb";

// ─── Fakes ────────────────────────────────────────────────────────────────

interface FakeSpawn {
  serial: string;
  opts: LogcatFollowOptions;
  stopped: boolean;
  /** Feed one raw stdout line into the production pump (as adb would). */
  emit(line: string): void;
}

/** Recording socket double: captures every outgoing frame and close. */
class RecordingSocket implements LogcatSocket {
  readonly sent: string[] = [];
  readonly closed: { code: number; reason: string }[] = [];
  /** Liveness probe for the orphan sweep (task 4.8); flip to simulate death. */
  open = true;

  send(frameJson: string): void {
    this.sent.push(frameJson);
  }

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
  }

  /** Decoded frames. */
  frames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s) as unknown);
  }
}

function makeHub() {
  const spawns: FakeSpawn[] = [];
  const hub = new LogcatHub({
    logcatFollow(
      serial: string,
      opts: LogcatFollowOptions,
      onLine: (line: string) => void,
    ): LogcatFollowHandle {
      const rec: FakeSpawn = { serial, opts, stopped: false, emit: onLine };
      spawns.push(rec);
      return {
        stop: async () => {
          rec.stopped = true;
        },
      };
    },
  });
  return { hub, spawns };
}

/**
 * Socket double for a STALLED reader (task 4.6): every send is recorded but
 * its completion is withheld until `releaseAll()` — the pump cannot make
 * progress no matter how many lines arrive.
 */
class GatedSocket implements LogcatSocket {
  readonly sent: string[] = [];
  readonly closed: { code: number; reason: string }[] = [];
  open = true;
  private letGo!: () => void;
  private readonly gate: Promise<void> = new Promise((resolve) => (this.letGo = resolve));

  send(frameJson: string): Promise<void> {
    this.sent.push(frameJson);
    return this.gate;
  }

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
  }

  releaseAll(): void {
    this.letGo();
  }

  frames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s) as unknown);
  }
}

// ─── Line builders ────────────────────────────────────────────────────────

let lineSeq = 0;
/** A parseable `-v time` record; defaults match the all-logs default filter. */
function logLine(tag = "App", priority = "E", message?: string): string {
  lineSeq += 1;
  const ms = String(lineSeq % 1000).padStart(3, "0");
  return `08-22 14:03:11.${ms} ${priority}/${tag}( 1234): ${message ?? `msg ${lineSeq}`}`;
}

const HEADER = "--------- beginning of main";

describe("replay/backlog (task 4.3, post-SPIKE-2)", () => {
  it("backlog:30 with ≥30 buffered replays exactly 30 matching, then {type:live}, then live only", () => {
    const { hub, spawns } = makeHub();
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "emulator-5554");
    sub.handleFrame('{"tags":["App"],"priority":"E","backlog":30}');

    // ONE -T spawn per subscriber, sized backlog + SPIKE-2 slack.
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.serial).toBe("emulator-5554");
    expect(spawns[0]!.opts.tail).toBe(33);

    // Startup window: one buffer header + exactly 30 matching records.
    spawns[0]!.emit(HEADER);
    for (let i = 0; i < 30; i++) spawns[0]!.emit(logLine("App", "E", `buffered ${i}`));

    const frames = sock.frames();
    expect(frames).toHaveLength(31); // 30 lines + marker
    expect(frames[0]).toEqual({
      type: "line",
      ts: expect.any(String),
      priority: "E",
      tag: "App",
      pid: 1234,
      message: "buffered 0",
    });
    // Chronological replay order; nothing but matching parsed lines.
    for (let i = 0; i < 30; i++) {
      expect((frames[i] as { message?: string }).message).toBe(`buffered ${i}`);
    }
    // Boundary marker lands AFTER the 30th replayed line, BEFORE live.
    expect(frames[30]).toEqual({ type: "live" });

    // Live phase: matching lines flow unprompted, non-matching never do.
    spawns[0]!.emit(logLine("App", "W", "live below floor"));
    spawns[0]!.emit(logLine("Other", "E", "wrong tag"));
    spawns[0]!.emit(logLine("App", "E", "live hit"));
    spawns[0]!.emit(HEADER); // startup headers can straggle into live — skipped
    const liveFrames = sock.frames();
    expect(liveFrames).toHaveLength(32);
    expect((liveFrames[31] as { message?: string }).message).toBe("live hit");
    sub.cancel();
  });

  it("pins the exact wire bytes of a line frame (design §WS protocol)", () => {
    const { hub, spawns } = makeHub();
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "s1");
    sub.handleFrame('{"backlog":0}');
    spawns[0]!.emit("08-22 14:03:11.123 E/System.err( 1234): boom");
    expect(sock.sent[1]).toBe(
      '{"type":"line","ts":"08-22 14:03:11.123","priority":"E","tag":"System.err","pid":1234,"message":"boom"}',
    );
    sub.cancel();
  });

  it("clamps to [0,1000]: backlog:5000 caps the spawn at cap+slack and proceeds", () => {
    const { hub, spawns } = makeHub();
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "s1");
    sub.handleFrame('{"backlog":5000}');

    expect(spawns[0]!.opts.tail).toBe(LOGCAT_BACKLOG_CAP + 3);
    for (let i = 0; i < LOGCAT_BACKLOG_CAP; i++) spawns[0]!.emit(logLine());
    let frames = sock.frames();
    expect(frames).toHaveLength(LOGCAT_BACKLOG_CAP + 1); // capped replay + marker
    expect(frames[LOGCAT_BACKLOG_CAP]).toEqual({ type: "live" });
    spawns[0]!.emit(logLine("App", "E", "still flowing"));
    frames = sock.frames();
    expect((frames.at(-1) as { message?: string }).message).toBe("still flowing");
    sub.cancel();
  });

  it("defaults the backlog to 100 when omitted", () => {
    const { hub, spawns } = makeHub();
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "s1");
    sub.handleFrame("{}");
    expect(spawns[0]!.opts.tail).toBe(103); // 100 + HEADER_SLACK
    sub.cancel();
  });

  it("backlog:0 skips replay INSTANTLY: live marker first, no -T at all", () => {
    const { hub, spawns } = makeHub();
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "s1");
    sub.handleFrame('{"backlog":0}');

    expect(spawns[0]!.opts.tail).toBeFalsy(); // no -T pair spawned
    expect(sock.frames()).toEqual([{ type: "live" }]); // before ANY emission

    spawns[0]!.emit(logLine("App", "E", "first live"));
    const frames = sock.frames();
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ type: "live" });
    expect((frames[1] as { message?: string }).message).toBe("first live");
    sub.cancel();
  });

  it("force-flips to live when the -T window drains without reaching backlog", () => {
    const { hub, spawns } = makeHub();
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "s1");
    sub.handleFrame('{"tags":["App"],"priority":"E","backlog":30}');

    // Short buffer: only 20 matching records exist in history; the rest of
    // the window is headers/non-matching. After backlog+slack+headers lines
    // the window MUST be exhausted → marker, then genuinely-live flow.
    for (let i = 0; i < 20; i++) spawns[0]!.emit(logLine("App", "E"));
    for (let i = 0; i < 16; i++) spawns[0]!.emit(i % 2 === 0 ? HEADER : logLine("Noise", "D"));

    const markerAt = sock.frames().findIndex((f) => (f as { type: string }).type === "live");
    expect(markerAt).toBeGreaterThan(-1);
    const linesBeforeMarker = sock.frames().slice(0, markerAt);
    expect(linesBeforeMarker).toHaveLength(20); // short-buffer reality, cut honest
    spawns[0]!.emit(logLine("App", "E", "post-flip live"));
    expect((sock.frames().at(-1) as { message?: string }).message).toBe("post-flip live");
    sub.cancel();
  });

  it("cancel() terminates the child via stop()", async () => {
    const { hub, spawns } = makeHub();
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "s1");
    sub.handleFrame('{"backlog":5}');
    await sub.cancel();
    expect(spawns[0]!.stopped).toBe(true);
  });
});

describe("filter composition (task 4.4)", () => {
  it("tag union ∩ priority floor, IDENTICALLY for replay and live phases", () => {
    const { hub, spawns } = makeHub();
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "s1");
    sub.handleFrame('{"tags":["ActivityManager","System.err"],"priority":"W","backlog":2}');

    // argv whitelist mirrors the predicate: tag specs at the floor + silence.
    expect(spawns[0]!.opts.filterspecs).toEqual(["ActivityManager:W", "System.err:W", "*:S"]);

    // Replay phase inputs — exactly one of these may pass.
    spawns[0]!.emit(logLine("ActivityManager", "I")); // below floor
    spawns[0]!.emit(logLine("System.err", "E")); // PASSES (replay 1)
    spawns[0]!.emit(logLine("Canvas", "W")); // right priority, wrong tag
    spawns[0]!.emit(logLine("System.err", "F")); // PASSES (replay 2 → live)
    let frames = sock.frames();
    expect(frames).toHaveLength(3); // 2 lines + marker at index 2

    // Live phase: same predicate, same outcome.
    spawns[0]!.emit(logLine("ActivityManager", "I"));
    spawns[0]!.emit(logLine("Canvas", "E")); // above floor, wrong tag
    spawns[0]!.emit(logLine("System.err", "S")); // PASSES live
    frames = sock.frames();
    expect(frames).toHaveLength(4);
    const delivered = frames
      .filter((f) => (f as { type: string }).type === "line")
      .map((f) => `${(f as { tag: string }).tag}:${(f as { priority: string }).priority}`);
    expect(delivered).toEqual(["System.err:E", "System.err:F", "System.err:S"]);
    sub.cancel();
  });

  it("{} defaults deliver ALL tags at priority ≥ E", () => {
    const { hub, spawns } = makeHub();
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "s1");
    sub.handleFrame('{"backlog":0}'); // instantly live; default filter applies

    // No tags ⇒ no argv whitelist: adb emits everything, hub floors at E.
    expect(spawns[0]!.opts.filterspecs).toEqual([]);
    for (const [tag, prio] of [
      ["App", "D"],
      ["Svc", "E"],
      ["T", "F"],
      ["App", "W"],
      ["U", "S"],
      ["V", "V"],
    ] as const) {
      spawns[0]!.emit(logLine(tag, prio));
    }
    const delivered = sock
      .frames()
      .filter((f) => (f as { type: string }).type === "line")
      .map((f) => `${(f as { tag: string }).tag}:${(f as { priority: string }).priority}`);
    expect(delivered).toEqual(["Svc:E", "T:F", "U:S"]);
    sub.cancel();
  });

  it("predicate matrix: rank boundaries, unknown priorities, empty/omitted tags", () => {
    const line = (tag: string, priority: string) =>
      parseLogcatTimeLine(`08-22 14:03:11.123 ${priority}/${tag}( 1): m`)!;
    const f: LogcatFilter = { tags: ["A", "B"], priority: "W" };
    expect(logcatLineMatches(line("A", "W"), f)).toBe(true);
    expect(logcatLineMatches(line("B", "S"), f)).toBe(true);
    expect(logcatLineMatches(line("A", "I"), f)).toBe(false); // below floor
    expect(logcatLineMatches(line("C", "E"), f)).toBe(false); // outside union
    expect(logcatLineMatches(line("a", "W"), f)).toBe(false); // case-sensitive

    const floorOnly: LogcatFilter = { priority: "W" };
    expect(logcatLineMatches(line("Any", "W"), floorOnly)).toBe(true);
    expect(logcatLineMatches(line("Any", "E"), floorOnly)).toBe(true);
    expect(logcatLineMatches(line("Any", "D"), floorOnly)).toBe(false);

    const emptyTags: LogcatFilter = { tags: [], priority: "E" };
    expect(logcatLineMatches(line("Any", "E"), emptyTags)).toBe(true);

    // Junk priority tokens never reach the predicate via the parser (they are
    // skipped upstream); a hand-built record must still fail closed.
    expect(logcatLineMatches({ ts: "08-22 14:03:11.123", priority: "X", tag: "A", pid: 1, message: "m" }, f)).toBe(false);
  });

  it("clampBacklog: undefined⇒100, in-range kept, oversized capped, junk floored", () => {
    expect(clampBacklog(undefined)).toBe(100);
    expect(clampBacklog(0)).toBe(0);
    expect(clampBacklog(30)).toBe(30);
    expect(clampBacklog(999)).toBe(999);
    expect(clampBacklog(LOGCAT_BACKLOG_CAP)).toBe(LOGCAT_BACKLOG_CAP);
    expect(clampBacklog(5000)).toBe(1000);
    expect(clampBacklog(-7)).toBe(0);
  });
});

describe("slow consumer backpressure (task 4.6, Fanout drain pattern)", () => {
  it("stalled reader under rapid emission: bounded drop-oldest queue, newest keep flowing, socket stays open, one dropped notice", async () => {
    const { hub, spawns } = makeHub();
    const sock = new GatedSocket();
    const sub = hub.subscribe(sock, "s1");
    sub.handleFrame('{"backlog":0}'); // instantly live; marker captured by the blocked drain

    const D = LOGCAT_QUEUE_DEPTH;
    const N = D * 2 + 3; // far more than the queue can hold while stalled
    spawns[0]!.emit(logLine("App", "E", "first"));
    for (let i = 0; i < N - 1; i++) spawns[0]!.emit(logLine("App", "E", `burst ${i}`));

    // Stalled: nothing closed, nothing grown unboundedly.
    await Bun.sleep(20);
    expect(sock.closed).toEqual([]);

    sock.releaseAll();
    await Bun.sleep(20); // let the drainer flush what survived

    const frames = sock.frames();
    const lines = frames.filter((f) => (f as { type: string }).type === "line") as Array<{
      message: string;
    }>;
    // Bounded: at most DEPTH line frames survive a full stall.
    expect(lines.length).toBeLessThanOrEqual(D);
    // Drop-OLDEST: the survivors are the NEWEST emissions.
    expect(lines.at(-1)?.message).toBe(`burst ${N - 2}`);
    expect(lines[0]?.message).toBe(`burst ${N - 1 - D}`);
    // Opportunistic drop accounting: exactly ONE notice with the exact count.
    const dropped = frames.filter((f) => (f as { type: string }).type === "dropped") as Array<{
      count: number;
    }>;
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.count).toBe(N - D);
    // The notice lands AFTER the surviving lines (chronological tail).
    expect((frames.at(-1) as { type: string }).type).toBe("dropped");
    // Socket stayed open through the whole episode.
    expect(sock.closed).toEqual([]);
    // Newest keep flowing after recovery.
    spawns[0]!.emit(logLine("App", "E", "post-recovery"));
    await Bun.sleep(20);
    const last = sock.frames().at(-1) as { type: string; message?: string };
    expect(last.type).toBe("line");
    expect(last.message).toBe("post-recovery");
    sub.cancel();
  });

  it("healthy reader under the same emission rate: every line delivered, NO dropped frame", async () => {
    const { hub, spawns } = makeHub();
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "s1");
    sub.handleFrame('{"backlog":0}');
    for (let i = 0; i < LOGCAT_QUEUE_DEPTH * 3; i++) spawns[0]!.emit(logLine("App", "E", `fast ${i}`));
    const frames = sock.frames();
    const lines = frames.filter((f) => (f as { type: string }).type === "line");
    expect(lines).toHaveLength(LOGCAT_QUEUE_DEPTH * 3);
    expect(frames.some((f) => (f as { type: string }).type === "dropped")).toBe(false);
    expect(sock.closed).toEqual([]);
    sub.cancel();
  });
});

describe("subscriber cap (task 4.7, VIEWER_CAP alignment)", () => {
  it(`admits ${LOGCAT_SUBSCRIBER_CAP} concurrent subscribers; the next one is closed 4429 VIEWER_CAP with no child spawned`, () => {
    const { hub, spawns } = makeHub();
    const socks: RecordingSocket[] = [];
    for (let i = 0; i < LOGCAT_SUBSCRIBER_CAP; i++) {
      const sock = new RecordingSocket();
      hub.subscribe(sock, "s1").handleFrame('{"backlog":0}');
      socks.push(sock);
    }
    expect(spawns).toHaveLength(LOGCAT_SUBSCRIBER_CAP);

    // The ninth concurrent subscriber is over cap: JSON error frame + close.
    const ninth = new RecordingSocket();
    const deadSub = hub.subscribe(ninth, "s1");
    expect(ninth.frames()).toEqual([
      { error: { code: "VIEWER_CAP", message: expect.any(String) } },
    ]);
    expect(ninth.closed).toEqual([{ code: 4429, reason: expect.any(String) }]);
    // The rejected connection never reaches the spawn layer…
    expect(spawns).toHaveLength(LOGCAT_SUBSCRIBER_CAP);
    // …and its subscription object is inert (late frames are no-ops).
    deadSub.handleFrame('{"backlog":0}');
    expect(ninth.sent).toHaveLength(1); // only the cap-rejection frame
    // The eight legitimate subscribers are untouched.
    for (const sock of socks) expect(sock.closed).toEqual([]);
  });

  it("frees the slot on teardown: after a subscriber cancels, a fresh subscription is fully functional", async () => {
    const { hub, spawns } = makeHub();
    const first = new RecordingSocket();
    const sub = hub.subscribe(first, "s1");
    sub.handleFrame('{"backlog":0}');

    sub.cancel();
    await Bun.sleep(10);

    const fresh = new RecordingSocket();
    const freshSub = hub.subscribe(fresh, "s1");
    freshSub.handleFrame('{"priority":"E","backlog":1}');
    expect(spawns).toHaveLength(2); // fresh subscription spawns its own child
    spawns[1]!.emit(logLine("App", "E", "fresh stream"));
    const freshLines = fresh.frames().filter((f) => (f as { type: string }).type === "line");
    expect((freshLines.at(-1) as { message?: string }).message).toBe("fresh stream");
    expect(fresh.closed).toEqual([]);
  });
});

describe("client-close teardown + orphan sweep (task 4.8)", () => {
  /** Spawner double exposing SIGTERM/SIGKILL accounting + gated stop. */
  function makeSignalHub(hubOpts?: ConstructorParameters<typeof LogcatHub>[1]) {
    const spawns: Array<{
      serial: string;
      opts: LogcatFollowOptions;
      sigterm: boolean;
      sigkill: boolean;
      resolveStop: () => void;
    }> = [];
    const hub = new LogcatHub(
      {
        logcatFollow(serial: string, opts: LogcatFollowOptions): LogcatFollowHandle {
          const rec = {
            serial,
            opts,
            sigterm: false,
            sigkill: false,
            resolveStop: () => {},
          };
          spawns.push(rec);
          return {
            stop: () =>
              new Promise<void>((resolve) => {
                rec.sigterm = true; // graceful stop STARTS (SIGTERM sent)
                rec.resolveStop = resolve;
              }),
            // SIGKILL escalation surface the hub MAY use after its grace timer.
            forceStop: () => {
              rec.sigkill = true;
            },
          } as LogcatFollowHandle;
        },
      },
      hubOpts,
    );
    return { hub, spawns };
  }

  it("SIGTERM first, then SIGKILL once the grace timer expires on a wedged child", async () => {
    const { hub, spawns } = makeSignalHub({ killGraceMs: 20 });
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "s1");
    sub.handleFrame('{"backlog":0}');
    expect(spawns[0]!.sigterm).toBe(false);

    sub.cancel();
    expect(spawns[0]!.sigterm).toBe(true); // SIGTERM immediately
    await Bun.sleep(10);
    expect(spawns[0]!.sigkill).toBe(false); // grace not yet expired

    await Bun.sleep(40);
    expect(spawns[0]!.sigkill).toBe(true); // escalated after the grace timer
    expect(sock.closed).toEqual([]); // teardown never touches the CLIENT socket
  });

  it("never escalates when the child exits before the grace timer fires", async () => {
    const { hub, spawns } = makeSignalHub({ killGraceMs: 30 });
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "s1");
    sub.handleFrame('{"backlog":0}');

    sub.cancel();
    spawns[0]!.resolveStop(); // child reaped promptly
    await Bun.sleep(60);
    expect(spawns[0]!.sigterm).toBe(true);
    expect(spawns[0]!.sigkill).toBe(false);
  });

  it("sweep reaps dead sockets the close event missed: SIGTERM→grace→SIGKILL, slot freed", async () => {
    const { hub, spawns } = makeSignalHub({ killGraceMs: 20 });
    const sock = new RecordingSocket();
    sock.open = false; // died WITHOUT the route's close handler running
    const sub = hub.subscribe(sock, "s1");
    sub.handleFrame('{"backlog":0}');
    expect(hub.count).toBe(1);

    hub.sweep();
    expect(spawns[0]!.sigterm).toBe(true);
    await Bun.sleep(50);
    expect(spawns[0]!.sigkill).toBe(true);
    expect(hub.count).toBe(0); // registry entry removed by the reap
  });

  it("sibling subscribers are unaffected by one teardown; fresh subscriptions stay fully functional", async () => {
    const { hub, spawns } = makeHub();
    const a = new RecordingSocket();
    const b = new RecordingSocket();
    const subA = hub.subscribe(a, "s1");
    const subB = hub.subscribe(b, "s2");
    subA.handleFrame('{"backlog":0}');
    subB.handleFrame('{"backlog":0}');

    subA.cancel();
    spawns[1]!.emit(logLine("App", "E", "sibling lives"));
    const bLines = b.frames().filter((f) => (f as { type: string }).type === "line");
    expect((bLines.at(-1) as { message?: string }).message).toBe("sibling lives");
    expect(b.closed).toEqual([]);

    const c = new RecordingSocket();
    hub.subscribe(c, "s3").handleFrame('{"backlog":0}');
    expect(spawns).toHaveLength(3);
    spawns[2]!.emit(logLine("App", "E", "brand new"));
    const cLines = c.frames().filter((f) => (f as { type: string }).type === "line");
    expect((cLines.at(-1) as { message?: string }).message).toBe("brand new");
  });
});

describe("mid-stream device loss (task 4.9, watchdog over adb.devices)", () => {
  function makeWatchedHub(devices: () => Promise<Array<{ serial: string }>>, pollMs?: number) {
    const spawns: FakeSpawn[] = [];
    const hub = new LogcatHub(
      {
        logcatFollow(
          serial: string,
          opts: LogcatFollowOptions,
          onLine: (line: string) => void,
        ): LogcatFollowHandle {
          const rec: FakeSpawn = { serial, opts, stopped: false, emit: onLine };
          spawns.push(rec);
          return {
            stop: async () => {
              rec.stopped = true;
            },
          };
        },
      },
      { devices, ...(pollMs !== undefined ? { pollMs } : {}) },
    );
    return { hub, spawns };
  }

  it("detach mid-stream closes 4409 with a reason NAMING the serial, stops the child, frees the slot", async () => {
    let attached = [{ serial: "emulator-5554" }, { serial: "emulator-5556" }];
    const { hub, spawns } = makeWatchedHub(async () => attached);
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "emulator-5556");
    sub.handleFrame('{"backlog":0}');
    spawns[0]!.emit(logLine("App", "E", "streaming fine"));

    attached = [{ serial: "emulator-5554" }]; // the watched device vanished
    await hub.checkDevices();

    expect(sock.closed).toEqual([
      { code: 4409, reason: expect.stringContaining("emulator-5556") },
    ]);
    expect(spawns[0]!.stopped).toBe(true);
    expect(hub.count).toBe(0);
    // The still-attached sibling subscriber is untouched.
  });

  it("the same close path serves a NATURAL child exit: once the device is gone from adb.devices(), 4409 fires", async () => {
    // Whether the logcat child died because adb killed it at detach or the
    // watchdog noticed first, the ONLY named mechanism is the devices() poll
    // — both realities converge here: serial gone ⇒ close 4409 + teardown.
    let attached = [{ serial: "emulator-5554" }];
    const { hub, spawns } = makeWatchedHub(async () => attached);
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "emulator-5554");
    sub.handleFrame('{"backlog":0}');
    spawns[0]!.emit(logLine()); // prove live flow first
    expect(sock.frames().some((f) => (f as { type: string }).type === "line")).toBe(true);

    attached = []; // full detach (child would die on its own too)
    await hub.checkDevices();
    expect(sock.closed).toEqual([{ code: 4409, reason: expect.stringContaining("emulator-5554") }]);
    expect(spawns[0]!.stopped).toBe(true);
  });

  it("attached serials are never touched by a poll cycle", async () => {
    const attached = [{ serial: "emulator-5554" }];
    const { hub, spawns } = makeWatchedHub(async () => attached);
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "emulator-5554");
    sub.handleFrame('{"backlog":0}');
    await hub.checkDevices();
    await hub.checkDevices(); // repeated polls stay harmless
    expect(sock.closed).toEqual([]);
    expect(hub.count).toBe(1);
    spawns[0]!.emit(logLine("App", "E", "still flowing"));
    const lines = sock.frames().filter((f) => (f as { type: string }).type === "line");
    expect((lines.at(-1) as { message?: string }).message).toBe("still flowing");
  });

  it("a failing devices() probe is 'cannot verify' — never a mass teardown", async () => {
    const { hub, spawns } = makeWatchedHub(async () => {
      throw new Error("adb not found");
    });
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "s1");
    sub.handleFrame('{"backlog":0}');
    await hub.checkDevices();
    expect(sock.closed).toEqual([]);
    expect(spawns[0]!.stopped).toBe(false);
  });

  it("the watchdog INTERVAL drives the same poll cycle without test nudging", async () => {
    const attached: Array<{ serial: string }> = [{ serial: "emulator-5554" }];
    const { hub, spawns } = makeWatchedHub(async () => attached, 10); // 10ms poll
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "emulator-5554");
    sub.handleFrame('{"backlog":0}');

    attached.length = 0; // detach while streaming
    await Bun.sleep(80);

    expect(sock.closed).toEqual([{ code: 4409, reason: expect.stringContaining("emulator-5554") }]);
    expect(spawns[0]!.stopped).toBe(true);
  });
});

describe("filter frame validation (task 4.5)", () => {
  it("malformed {backlog:\"many\"} yields ONE error frame then close 1008, spawning nothing", () => {
    const { hub, spawns } = makeHub();
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "s1");
    sub.handleFrame('{"backlog":"many"}');

    expect(sock.sent).toHaveLength(1);
    expect(sock.frames()[0]).toEqual({
      type: "error",
      code: "validation_error",
      message: expect.any(String),
    });
    expect(sock.closed).toEqual([{ code: 1008, reason: expect.any(String) }]);
    expect(spawns).toHaveLength(0);
  });

  it("rejects non-JSON text with the same error frame + close 1008", () => {
    const { hub, spawns } = makeHub();
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "s1");
    sub.handleFrame("this is not json");
    expect(sock.frames()[0]).toMatchObject({ type: "error", code: "validation_error" });
    expect(sock.closed[0]?.code).toBe(1008);
    expect(spawns).toHaveLength(0);
  });

  it("rejects non-object JSON frames", () => {
    for (const raw of ['"hi"', "[1,2]", "null"]) {
      const { hub, spawns } = makeHub();
      const sock = new RecordingSocket();
      const sub = hub.subscribe(sock, "s1");
      sub.handleFrame(raw);
      expect(sock.frames()[0]).toMatchObject({ type: "error", code: "validation_error" });
      expect(sock.closed[0]?.code).toBe(1008);
      expect(spawns).toHaveLength(0);
    }
  });

  it("rejects hostile tag entries before any spawn", () => {
    const { hub, spawns } = makeHub();
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "s1");
    sub.handleFrame('{"tags":["ok","bad;rm -rf"]}');
    expect(sock.frames()[0]).toMatchObject({ type: "error", code: "validation_error" });
    expect(sock.closed[0]?.code).toBe(1008);
    expect(spawns).toHaveLength(0);
  });

  it("rejects float and negative backlogs (int ≥ 0 only)", () => {
    for (const raw of ['{"backlog":1.5}', '{"backlog":-3}']) {
      const { hub, spawns } = makeHub();
      const sock = new RecordingSocket();
      const sub = hub.subscribe(sock, "s1");
      sub.handleFrame(raw);
      expect(sock.frames()[0]).toMatchObject({ type: "error", code: "validation_error" });
      expect(sock.closed[0]?.code).toBe(1008);
      expect(spawns).toHaveLength(0);
    }
  });

  it("rejects priorities outside the V..S enum and unknown frame keys (strict)", () => {
    for (const raw of ['{"priority":"X"}', '{"bogus":1}', '{"tags":"App"}']) {
      const { hub, spawns } = makeHub();
      const sock = new RecordingSocket();
      const sub = hub.subscribe(sock, "s1");
      sub.handleFrame(raw);
      expect(sock.frames()[0]).toMatchObject({ type: "error", code: "validation_error" });
      expect(sock.closed[0]?.code).toBe(1008);
      expect(spawns).toHaveLength(0);
    }
  });

  it("enforces EXACTLY ONE filter frame per connection: second frame ⇒ error + close 1008 + child stopped", async () => {
    const { hub, spawns } = makeHub();
    const sock = new RecordingSocket();
    const sub = hub.subscribe(sock, "s1");
    sub.handleFrame('{"backlog":5}');
    expect(spawns).toHaveLength(1);

    sub.handleFrame('{"backlog":9}');
    const last = sock.frames().at(-1) as { type: string; code?: string; message?: string };
    expect(last).toEqual({ type: "error", code: "validation_error", message: expect.any(String) });
    expect(sock.closed).toEqual([{ code: 1008, reason: expect.any(String) }]);
    await Bun.sleep(10);
    expect(spawns[0]!.stopped).toBe(true); // dead socket must not keep adb alive
  });

  it("pins the zod frame grammar directly (the WS branch reuses this schema)", () => {
    expect(logcatFilterFrameSchema.safeParse({}).success).toBe(true);
    expect(
      logcatFilterFrameSchema.safeParse({ tags: ["ActivityManager"], priority: "W", backlog: 30 })
        .success,
    ).toBe(true);
    expect(logcatFilterFrameSchema.safeParse({ tags: [] }).success).toBe(true);
    expect(logcatFilterFrameSchema.safeParse({ backlog: "many" }).success).toBe(false);
    expect(logcatFilterFrameSchema.safeParse({ tags: ["a b"] }).success).toBe(false);
    expect(logcatFilterFrameSchema.safeParse({ priority: "X" }).success).toBe(false);
    expect(logcatFilterFrameSchema.safeParse([]).success).toBe(false);
  });
});
