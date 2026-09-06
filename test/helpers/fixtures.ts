import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryRunner } from "./memoryRunner";

/** CLI version the recorded fixtures are pinned to (see test/fixtures/README.md). */
export const FIXTURE_VERSION = "1.0.15985488";

export interface FixtureEnvelope {
  argv: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  provenance?: {
    tool: string;
    version: string;
    capturedAt: string;
    context: string;
  };
}

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");

const cache = new Map<string, FixtureEnvelope>();

/**
 * Load a recorded CLI-output fixture envelope by file name (without the .json
 * extension). Panics on missing files, malformed JSON, or envelopes without
 * full provenance — a fixture without provenance is not fit for parser tests.
 * A `version` that differs from FIXTURE_VERSION is rejected with the re-record
 * instruction, so a CLI upgrade cannot silently invalidate recorded shapes.
 *
 * `dir` defaults to the committed `test/fixtures/` set; tests pass a temp
 * directory to exercise the rejection branches against crafted envelopes.
 */
export function loadFixture(name: string, dir: string = FIXTURES_DIR): FixtureEnvelope {
  const cached = cache.get(name);
  if (cached) return cached;

  const raw = readFileSync(join(dir, `${name}.json`), "utf8");
  const env = JSON.parse(raw) as FixtureEnvelope;
  if (!Array.isArray(env.argv) || typeof env.stdout !== "string") {
    throw new Error(`fixture ${name}.json: envelope must carry argv[] and stdout`);
  }
  const prov = env.provenance;
  if (!prov || prov.tool === undefined || prov.version === undefined || prov.capturedAt === undefined) {
    throw new Error(`fixture ${name}.json: envelope missing provenance`);
  }
  if (prov.version !== FIXTURE_VERSION) {
    throw new Error(
      `fixture ${name}.json: pinned to CLI ${prov.version}, but FIXTURE_VERSION is ${FIXTURE_VERSION}; re-record or bump the pin`,
    );
  }
  cache.set(name, env);
  return env;
}

/**
 * Fixture-backed MemoryRunner: record every fixture command by its EXACT argv
 * (the envelopes are self-describing) and return the runner for further
 * expectations and `assertSatisfied()`.
 */
export function expectFixture(runner: MemoryRunner, fixture: FixtureEnvelope): MemoryRunner {
  runner.expect(fixture.argv, {
    stdout: fixture.stdout,
    stderr: fixture.stderr,
    exitCode: fixture.exitCode,
  });
  return runner;
}