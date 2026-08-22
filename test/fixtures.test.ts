import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { FIXTURE_VERSION, expectFixture, loadFixture, type FixtureEnvelope } from "./helpers/fixtures";
import { MemoryRunner } from "./helpers/memoryRunner";

/**
 * sha256 of the pinned scrcpy-server jar under `assets/`. The parsers in
 * `src/stream/` implement the wire protocol of THIS exact jar (design D1);
 * bump only together with `assets/README.md` provenance + wire parsers.
 */
const SCRCPY_JAR_SHA256 = "deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae";

describe("fixture helper — recorded real-output envelopes", () => {
  it("loads every recorded fixture and pins it to the CLI version", () => {
    for (const name of [
      "android-layout",
      "android-layout-diff",
      "android-emulator-list-long",
      "adb-logcat-d-t",
      "adb-devices-l",
      "adb-getprop",
    ]) {
      const env = loadFixture(name);
      expect(env.provenance?.version).toBe(FIXTURE_VERSION);
    }
  });

  it("loads the android layout fixture with the real CLI shape (string center, hyphenated keys, sparse)", () => {
    const env = loadFixture("android-layout");
    expect(env.argv).toEqual(["android", "layout", "--device=emulator-5554"]);
    expect(env.exitCode).toBe(0);
    expect(env.stdout).toContain('"center":"[640,1428]"');
    expect(env.stdout).toContain('"resource-id":"workspace"');
    expect(env.stdout).toContain('"content-desc":"Google search"');
    // Sparse JSON: no offScreen/state keys on most elements
    expect(env.stdout).not.toContain("offScreen");
  });

  it("expectFixture() records by exact argv so a wrapper can play the envelope back", async () => {
    const runner = new MemoryRunner();
    expectFixture(runner, loadFixture("adb-getprop"));
    const res = await runner.run(["adb", "-s", "emulator-5554", "shell", "getprop", "ro.build.version.sdk"]);
    expect(res.stdout.trim()).toBe("36");
    runner.assertSatisfied();
  });

  it("expectFixture() returns the runner so tests can chain further expectations", async () => {
    const runner = new MemoryRunner();
    const out = expectFixture(runner, loadFixture("android-layout"));
    expect(out).toBe(runner);
    expect(runner.optsLog).toEqual([]);
    // the envelope is recorded only; satisfaction is proven by actually running the wrapper
    expect(runner.run(["android", "layout", "--device=emulator-5554"])).resolves.toMatchObject({
      exitCode: 0,
    });
    runner.assertSatisfied();
  });

  it("rejects a fixture pinned to a different CLI version via the production loader", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-fixture-stale-"));
    try {
      writeFileSync(
        join(dir, "stale-app.json"),
        JSON.stringify({
          argv: ["android", "layout"],
          stdout: "[]",
          stderr: "",
          exitCode: 0,
          provenance: {
            tool: "android-cli",
            version: "0.9.9",
            capturedAt: "2026-01-01T00:00:00Z",
            context: "recorded by an older CLI",
          },
        } satisfies FixtureEnvelope),
      );
      // The production pin guard must reject the stale envelope AT LOAD TIME,
      // naming both the recorded version and the re-record escape hatch.
      expect(() => loadFixture("stale-app", dir)).toThrow(
        /pinned to CLI 0\.9\.9[\s\S]*FIXTURE_VERSION is 1\.0\.15985488[\s\S]*re-record/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadFixture(dir) rejects missing provenance and accepts fresh envelopes from the same directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-fixture-prov-"));
    try {
      writeFileSync(
        join(dir, "no-prov.json"),
        JSON.stringify({ argv: ["adb"], stdout: "", stderr: "", exitCode: 0 }),
      );
      expect(() => loadFixture("no-prov", dir)).toThrow(/missing provenance/);

      writeFileSync(
        join(dir, "fresh.json"),
        JSON.stringify({
          argv: ["adb", "devices"],
          stdout: "ok",
          stderr: "",
          exitCode: 0,
          provenance: {
            tool: "android-cli",
            version: FIXTURE_VERSION,
            capturedAt: "2026-01-01T00:00:00Z",
            context: "valid re-record",
          },
        } satisfies FixtureEnvelope),
      );
      expect(loadFixture("fresh", dir).stdout).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pins the bundled scrcpy-server.jar to its recorded sha256 (design D1)", () => {
    const jar = readFileSync(join(import.meta.dir, "..", "assets", "scrcpy-server.jar"));
    const digest = createHash("sha256").update(jar).digest("hex");
    // The pinned hash comes from the official v4.1 release asset; a mismatch
    // means the jar changed (upstream re-pin or accidental swap) and the
    // wire parsers may no longer match. See assets/README.md re-pin steps.
    expect(digest).toBe(SCRCPY_JAR_SHA256);
    // A jar that passes sha256 but is an empty stub would break streaming —
    // guards against accidental git-lfs pointer/zero-byte commits.
    expect(jar.length).toBeGreaterThan(100_000);
    // Must remain a valid ZIP (classes.dex inside), i.e. a real server jar.
    expect(jar.subarray(0, 2).toString("latin1")).toBe("PK");
  });
});