import { SpawnTimeoutError, type CommandResult, type CommandRunner, type RunOptions } from "../../src/device/runner";

/**
 * Runner double for END-TO-END stuck-spawn surfacing tests: every run()
 * rejects with the real `SpawnTimeoutError` immediately, carrying the exact
 * argv and the per-operation `SPAWN_TIMEOUTS` value the wrapper passed.
 *
 * Unlike `MemoryRunner.expectHang` (whose run NEVER settles, so only
 * `BunCommandRunner` can turn it into a timeout), this double completes the
 * timeout path in microseconds — letting handler-level tests prove that a
 * stuck spawn surfaces as an actionable tool error instead of blocking,
 * without waiting seconds for real process kills.
 */
export class TimeoutRunner implements CommandRunner {
  async run(argv: string[], opts?: RunOptions): Promise<CommandResult> {
    throw new SpawnTimeoutError(argv, opts?.timeoutMs ?? 0);
  }
}
