/**
 * Command execution abstraction for the device core.
 *
 * The CLI and adb wrappers spawn subprocesses through a `CommandRunner` so
 * tests can substitute an in-memory record/playback double (`MemoryRunner`)
 * instead of shelling out to a real Android SDK. `BunCommandRunner` is the
 * production implementation backed by `Bun.spawn`.
 */

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  run(argv: string[]): Promise<CommandResult>;
}

/** Production runner that executes each argv via Bun.spawn, resolving PATH. */
export class BunCommandRunner implements CommandRunner {
  readonly env: Record<string, string>;

  constructor(env: Record<string, string> = process.env as Record<string, string>) {
    this.env = env;
  }

  async run(argv: string[]): Promise<CommandResult> {
    const proc = Bun.spawn(argv, {
      env: this.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }
}
