/**
 * Command execution abstraction for the device core.
 *
 * The CLI and adb wrappers spawn subprocesses through a `CommandRunner` so
 * tests can substitute an in-memory record/playback double (`MemoryRunner`)
 * instead of shelling out to a real Android SDK. `BunCommandRunner` is the
 * production implementation backed by `Bun.spawn`.
 *
 * Every spawn can carry a per-operation timeout (`RunOptions.timeoutMs`):
 * when it fires, the process is killed and a `SpawnTimeoutError` is thrown.
 * Wrappers pass the matching `SPAWN_TIMEOUTS` entry as the default; a
 * per-call override wins.
 */

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  /** Kill the spawned process and throw `SpawnTimeoutError` after this many ms. */
  timeoutMs?: number;
}

export interface CommandRunner {
  run(argv: string[], opts?: RunOptions): Promise<CommandResult>;
}

/** Thrown when a spawned subprocess exceeds its per-operation timeout. */
export class SpawnTimeoutError extends Error {
  readonly argv: string[];
  readonly timeoutMs: number;

  constructor(argv: string[], timeoutMs: number) {
    super(`${argv.join(" ")} timed out after ${timeoutMs}ms; retry or raise the timeout`);
    this.name = "SpawnTimeoutError";
    this.argv = [...argv];
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Per-operation default spawn timeouts (ms). Sized from live-measured CLI
 * runtimes on a booted emulator with generous headroom; the outer
 * handler-level readiness budgets (`withTimeout`) stay as a second layer.
 */
export const SPAWN_TIMEOUTS = {
  /** `android layout` / `adb uiautomator dump` (live ~3.1s, 5x headroom). */
  layout: 15_000,
  /** Screen capture / screencap+pull (live ~2.2s, multi-MB PNG). */
  capture: 30_000,
  /** Bounded `adb logcat -d -t N` dump. */
  logcatDump: 15_000,
  /** `adb devices` / `getprop` / `android info`. */
  devices: 10_000,
  /** `adb shell input` ops. */
  input: 10_000,
  /** `android emulator` list / stop / create. */
  emulatorManage: 30_000,
  /** `android emulator start` blocks until ready (~21s warm; CLI internal budget ~300s). */
  emulatorStart: 120_000,
  /** `android install` / `run` deploy (mirrors the handler-level default). */
  install: 120_000,
} as const;

/** Production runner that executes each argv via Bun.spawn, resolving PATH. */
export class BunCommandRunner implements CommandRunner {
  readonly env: Record<string, string>;

  constructor(env: Record<string, string> = process.env as Record<string, string>) {
    this.env = env;
  }

  async run(argv: string[], opts: RunOptions = {}): Promise<CommandResult> {
    const proc = Bun.spawn(argv, {
      env: this.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const completed = (async (): Promise<CommandResult> => {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      return { stdout, stderr, exitCode };
    })();
    if (opts.timeoutMs === undefined) return completed;

    const timeoutMs = opts.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        completed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            proc.kill();
            reject(new SpawnTimeoutError(argv, timeoutMs));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
