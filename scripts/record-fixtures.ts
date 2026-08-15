/**
 * Recorder for real-CLI-output fixtures.
 *
 * Runs canonical `android` CLI / `adb` commands against a booted emulator
 * through the production `BunCommandRunner` and writes JSON envelopes to
 * `test/fixtures/` so parser tests play back REAL output shapes.
 *
 * Manual, one-off: run `bun run record-fixtures` on a machine with the
 * Android SDK CLI (1.0.15985488) and a booted emulator, then COMMIT the
 * resulting envelopes. Recording is never part of CI.
 *
 * Re-record procedure (also in test/fixtures/README.md):
 *  1. Boot an emulator (interactive home screen) and wait for boot completion.
 *  2. Bump the CLI tool version pin if the installed CLI changed.
 *  3. `bun run record-fixtures` — overwrites the six envelopes.
 *  4. Review the diff: shape changes MUST land with matching parser changes.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BunCommandRunner } from "../src/device/runner";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "..", "test", "fixtures");

/** Tool version the fixtures are pinned to (see design D2). */
const TOOL_VERSION = "1.0.15985488";

/** Human context for each envelope; run against the Pixel_9_Pro AVD. */
type FixtureContext =
  | "layout-full"
  | "layout-diff"
  | "emulator-list-long"
  | "logcat-dump"
  | "devices-list"
  | "getprop";

interface Envelope {
  argv: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  provenance: {
    tool: "android-cli" | "adb";
    version: string;
    capturedAt: string; // ISO timestamp of the recording run
    context: FixtureContext;
  };
}

const runner = new BunCommandRunner();

async function record(
  tool: Envelope["provenance"]["tool"],
  context: FixtureContext,
  argv: string[],
): Promise<Envelope> {
  const { stdout, stderr, exitCode } = await runner.run(argv, { timeoutMs: 60_000 });
  return {
    argv,
    stdout,
    stderr,
    exitCode,
    provenance: {
      tool,
      version: TOOL_VERSION,
      capturedAt: new Date().toISOString(),
      context,
    },
  };
}

async function main(): Promise<void> {
  const serial = process.env.ANDROID_DEVICE ?? "emulator-5554";

  const envelopes: Array<{ file: string; env: Envelope }> = [
    {
      file: "android-layout.json",
      env: await record("android-cli", "layout-full", ["android", "layout", `--device=${serial}`]),
    },
    {
      file: "android-layout-diff.json",
      env: await record("android-cli", "layout-diff", ["android", "layout", `--device=${serial}`, "--diff"]),
    },
    {
      file: "android-emulator-list-long.json",
      env: await record("android-cli", "emulator-list-long", ["android", "emulator", "list", "--long"]),
    },
    {
      file: "adb-logcat-d-t.json",
      env: await record("adb", "logcat-dump", ["adb", "-s", serial, "logcat", "-d", "-t", "20", "-v", "time", "*:D"]),
    },
    {
      file: "adb-devices-l.json",
      env: await record("adb", "devices-list", ["adb", "devices", "-l"]),
    },
    {
      file: "adb-getprop.json",
      env: await record("adb", "getprop", ["adb", "-s", serial, "shell", "getprop", "ro.build.version.sdk"]),
    },
  ];

  await mkdir(FIXTURES_DIR, { recursive: true });
  for (const { file, env } of envelopes) {
    const path = join(FIXTURES_DIR, file);
    await writeFile(path, `${JSON.stringify(env, null, 2)}\n`);
    console.log(`wrote ${path}`);
  }
}

main().catch((err) => {
  console.error("fixture recording failed:", err);
  process.exit(1);
});