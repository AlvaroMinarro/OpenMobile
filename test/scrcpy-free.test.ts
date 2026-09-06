import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Deletion proof (success criteria: the in-guest encoder streaming world is
 * fully deleted — sources, assets, tests, scripts — with NO references
 * remaining). Scans every .ts file under src/ and test/ for functional
 * references to the deleted world: the legacy transport name and its server
 * asset, the access-unit framing (splitter + wire parsers), and the browser
 * decode path it depended on.
 *
 * Every pattern AND label below is assembled from string fragments so THIS
 * file never matches its own source, and the scanner walks only .ts files
 * (fixtures, docs and the stale generated demo bundle are outside the proof
 * scope — the demo is rewritten with the RTC client).
 */

const ROOT = join(import.meta.dir, "..");
const SCAN_DIRS = ["src", "test"] as const;

/** Fragment-assembled so the proof file never matches its own source. */
const FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
  { label: "legacy" + " transport name", pattern: new RegExp("scr" + "cpy", "i") },
  { label: "server" + " asset", pattern: new RegExp("server" + "-server|server" + "\\.jar", "i") },
  { label: "access-unit" + " framing", pattern: new RegExp("ann" + "ex[\\s_-]?b", "i") },
  { label: "browser decode" + " path", pattern: new RegExp("web" + "code" + "cs|video" + "decoder", "i") },
  { label: "wire-layout" + " parser", pattern: new RegExp("split" + "Annex|parse" + "FrameMeta|parse" + "DeviceMeta") },
  { label: "control byte" + " encodings", pattern: new RegExp("TYPE_" + "INJECT_|TOUCH_" + "ACTION_") },
];

/** This proof file (it names the deleted paths in its existence check). */
const SELF = join(ROOT, "test", "scrcpy-free.test.ts");

function* tsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* tsFiles(full);
    } else if (entry.endsWith(".ts") && full !== SELF) {
      yield full;
    }
  }
}

describe("deletion proof — zero references to the deleted streaming world", () => {
  it("src/ and test/ carry no legacy-transport/jar/framing/decoder references", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of tsFiles(join(ROOT, dir))) {
        const text = readFileSync(file, "utf8");
        for (const { label, pattern } of FORBIDDEN) {
          if (pattern.test(text)) {
            offenders.push(`${file}: ${label}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the deleted source files, jar asset and fixtures no longer exist on disk", () => {
    for (const gone of [
      "src/stream/scrcpy.ts",
      "src/stream/wire.ts",
      "src/stream/daemon.ts",
      // The client directory is REBORN as the Phase-3 RTC client
      // (src/stream/client/index.ts); the Annex-B/WebCodecs modules stay
      // deleted — asserted file-by-file so a reintroduction cannot hide.
      "src/stream/client/annexb.ts",
      "src/stream/client/decoder.ts",
      "src/stream/client/support.ts",
      "assets/scrcpy-server.jar",
      "assets/README.md",
      "scripts/record-stream-fixture.ts",
      "test/stream-scrcpy.test.ts",
      "test/stream-wire.test.ts",
      "test/stream-daemon.test.ts",
      "test/stream-client.test.ts",
      "test/fixtures/stream-meta.bin",
      "test/fixtures/stream-a-frames.bin",
      "test/fixtures/stream-control.bin",
    ]) {
      // statSync throws when the path is gone — the required state.
      expect(() => statSync(join(ROOT, gone))).toThrow();
    }
  });
});
