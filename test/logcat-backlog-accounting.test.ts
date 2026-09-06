/**
 * SPIKE-2 / task 0.2 (bridge-surface-v2): pins the line-accounting contract
 * behind design D5's `adb logcat -T <n> -v time` spawn — how many of the
 * first emitted lines are buffer headers ("--------- beginning of ...")
 * versus parseable log lines, and therefore how much over-fetch slack the
 * LogcatHub needs so a requested backlog of N yields >= N PARSED lines.
 *
 * EVIDENCE SOURCE (confidence MEDIUM):
 *  - REAL recorded output: test/fixtures/adb-logcat-d-t.json — genuine
 *    `adb -s emulator-5554 logcat -d -t 20 -v time *:D` capture (provenance
 *    pinned by loadFixture). Measured: 24 emitted lines = 22 PARSED + 2
 *    HEADERS for a requested 20 => headers sit OUTSIDE the count and the
 *    dump even OVER-delivered by 2 parsed lines.
 *  - SYNTHESIZED: the `-T <n>` follow-mode startup emission is modeled from
 *    that same recorded line grammar (up to one header per standard buffer:
 *    main/system/crash). No device/emulator was attached at spike time, so a
 *    live `-T` capture was impossible — re-verify cheaply on the next live
 *    session before tightening further.
 *
 * PINNED CONSTANT (feeds design D5): HEADER_SLACK = 3 — one slot per
 * potential startup buffer header, so the guarantee holds even if some
 * device/logcat version charges headers against the requested count. Cost is
 * negligible: at most 3 extra buffered lines, discarded by the server-side
 * replay cut at exactly `backlog` parsed lines.
 */
import { describe, expect, it } from "bun:test";
import { loadFixture } from "./helpers/fixtures";

/** Over-fetch slots added to the requested `-T` count (design D5 pin). */
const HEADER_SLACK = 3;
/** Startup headers adb may print, one per standard selected buffer. */
const MAX_STARTUP_HEADERS = 3; // main, system, crash

type LineKind = "header" | "parsed" | "other";

const HEADER_RE = /^--------- beginning of /;
const TIME_PREFIX_RE = /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} /;
// Same priority-token family as src/device/adb.ts priorityOf (adb.ts:40).
const PRIORITY_RE = /\s([VDIWEFS])\//;

/** Shape the future D5 parser must produce per `-v time` line (task 4.2). */
interface ParsedLogLine {
  ts: string;
  priority: string;
  tag: string;
  pid: number;
  message: string;
}

/** Non-empty stdout lines of a logcat stream. */
function splitLines(stdout: string): string[] {
  return stdout.split("\n").filter((l) => l.length > 0);
}

function classifyLine(line: string): LineKind {
  if (HEADER_RE.test(line)) return "header";
  if (TIME_PREFIX_RE.test(line) && PRIORITY_RE.test(line)) return "parsed";
  return "other";
}

/** Parse one `-v time` line into the full replay-frame shape, or null. */
function parseTimeLine(line: string): ParsedLogLine | null {
  if (classifyLine(line) !== "parsed") return null;
  // "MM-DD HH:MM:SS.mmm P/Tag(  pid): message"
  const m = /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+([VDIWEFS])\/([^(]+)\(\s*(\d+)\):\s?(.*)$/.exec(
    line,
  );
  if (!m) return null;
  return {
    ts: m[1] ?? "",
    priority: m[2] ?? "",
    tag: (m[3] ?? "").trim(),
    pid: Number(m[4]),
    message: m[5] ?? "",
  };
}

/**
 * Replay pump model: consume the startup stream in order, counting ONLY
 * parsed log lines until `backlog` have been collected; returns how many
 * were replayable and how many parsed lines remain for the live phase.
 */
function replayCut(lines: string[], backlog: number): { replayed: number; liveRemainder: number } {
  let replayed = 0;
  let liveRemainder = 0;
  for (const line of lines) {
    if (replayed >= backlog && classifyLine(line) === "parsed") liveRemainder += 1;
    else if (replayed < backlog && classifyLine(line) === "parsed") replayed += 1;
  }
  return { replayed, liveRemainder };
}

/**
 * Model `logcat -T <requested> -v time` startup emission:
 *  - "headers-free" (fixture-proven shape): H header lines are EXTRA, then
 *    exactly `requested` parsed lines.
 *  - "headers-charged" (defensive folklore shape): the H header lines
 *    consume part of the requested budget first.
 */
function simulateStartup(
  requested: number,
  headerCount: number,
  hypothesis: "headers-free" | "headers-charged",
): string[] {
  const headers = Array.from({ length: headerCount }, (_, i) => `--------- beginning of buf${i}`);
  const parsedBudget =
    hypothesis === "headers-free" ? requested : Math.max(0, requested - headerCount);
  const parsed = Array.from({ length: parsedBudget }, (_, i) => {
    const mm = String((i % 60) + 1).padStart(2, "0");
    return `08-22 14:03:${mm}.123 I/Tag${i}(  ${1000 + i}): synthesized line ${i}`;
  });
  return [...headers, ...parsed];
}

describe("logcat -T backlog accounting (task 0.2 / SPIKE-2, design D5)", () => {
  it("REAL fixture (-t 20 -v time): headers sit OUTSIDE the count; 22 parsed lines delivered for a requested 20", () => {
    const fixture = loadFixture("adb-logcat-d-t");
    const lines = splitLines(fixture.stdout);
    const kinds = lines.map(classifyLine);

    const headers = kinds.filter((k) => k === "header").length;
    const parsed = kinds.filter((k) => k === "parsed").length;
    const other = kinds.filter((k) => k === "other").length;

    // Recorded reality: 2 buffer headers ("main", "system"), zero junk.
    expect(headers).toBe(2);
    expect(other).toBe(0);
    // Over-delivery: requested 20, parsed 22 — under-delivery did NOT occur.
    expect(parsed).toBe(22);
    expect(parsed).toBeGreaterThanOrEqual(20);
    // Headers are additive on the wire: emitted = parsed + headers.
    expect(lines.length).toBe(parsed + headers);

    // Every parsed line must survive the FULL replay-frame parse.
    for (const line of lines) {
      const frame = parseTimeLine(line);
      if (classifyLine(line) === "parsed") {
        expect(frame).not.toBeNull();
        expect(frame?.priority ?? "").toMatch(/^[VDIWEFS]$/);
        expect(frame?.pid ?? NaN).toBeGreaterThan(0);
      } else {
        expect(frame).toBeNull();
      }
    }
  });

  it("synthesized -T startup streams: headers-free yields exactly N parsed; headers-charged yields N-H", () => {
    for (const n of [10, 20, 50]) {
      const free = simulateStartup(n, MAX_STARTUP_HEADERS, "headers-free");
      const freeKinds = free.map(classifyLine);
      expect(freeKinds.filter((k) => k === "header")).toHaveLength(MAX_STARTUP_HEADERS);
      expect(freeKinds.filter((k) => k === "parsed")).toHaveLength(n);

      const charged = simulateStartup(n, MAX_STARTUP_HEADERS, "headers-charged");
      const chargedKinds = charged.map(classifyLine);
      expect(chargedKinds.filter((k) => k === "header")).toHaveLength(MAX_STARTUP_HEADERS);
      expect(chargedKinds.filter((k) => k === "parsed")).toHaveLength(Math.max(0, n - MAX_STARTUP_HEADERS));
    }
  });

  it(`pinned HEADER_SLACK=${HEADER_SLACK}: requesting backlog+slack yields >=N parsed under EITHER accounting`, () => {
    for (const n of [10, 20, 50]) {
      for (const hypothesis of ["headers-free", "headers-charged"] as const) {
        // The hub spawns with the over-fetch slack applied...
        const stream = simulateStartup(n + HEADER_SLACK, MAX_STARTUP_HEADERS, hypothesis);
        // ...and cuts replay at exactly N PARSED lines server-side.
        const { replayed, liveRemainder } = replayCut(stream, n);
        expect(replayed).toBe(n); // the D5 guarantee, both hypotheses
        expect(liveRemainder).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("negative proof: slack 0 satisfies only headers-free — why the constant is non-zero despite the fixture", () => {
    // Fixture-proven world: headers are free, so no slack needed.
    const free = replayCut(simulateStartup(30, MAX_STARTUP_HEADERS, "headers-free"), 30);
    expect(free.replayed).toBe(30);

    // Defensive folklore world: without slack the replay comes up short
    // by exactly the number of startup headers.
    const charged = replayCut(simulateStartup(30, MAX_STARTUP_HEADERS, "headers-charged"), 30);
    expect(charged.replayed).toBe(30 - MAX_STARTUP_HEADERS);
    expect(charged.replayed).toBeLessThan(30);

    // Derivation: minimal slack satisfying BOTH worlds == MAX_STARTUP_HEADERS.
    let minimalSlack = 0;
    while (
      replayCut(simulateStartup(30 + minimalSlack, MAX_STARTUP_HEADERS, "headers-charged"), 30)
        .replayed < 30
    ) {
      minimalSlack += 1;
    }
    expect(minimalSlack).toBe(MAX_STARTUP_HEADERS);
    expect(HEADER_SLACK).toBe(minimalSlack); // pin stays at the derived value
  });
});
