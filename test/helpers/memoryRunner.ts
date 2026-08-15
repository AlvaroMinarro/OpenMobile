import type { CommandResult, CommandRunner, RunOptions } from "../../src/device/runner";

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * In-memory command runner (record/playback) used to test the CLI and adb
 * wrappers without a real Android SDK.
 *
 * Recording: state the expected `argv` for each command with the `CommandResult`
 * it should return. Playback: after exercising the code under test,
 * `assertSatisfied()` fails if any recorded command was never invoked, and a
 * recorded command that is in fact invoked returns the programmed result —
 * proving the wrapper built the correct command line.
 *
 * Timeout doubles: `expectHang(argv)` records a command whose run NEVER
 * resolves, simulating a hung subprocess. `RunOptions` are never enforced here
 * (timeout enforcement lives in `BunCommandRunner`) but every call's options
 * are logged in `optsLog` so tests can assert the wrappers wired the right
 * per-operation `SPAWN_TIMEOUTS` entry.
 */
export class MemoryRunner implements CommandRunner {
  private expectations: Array<{ argv: string[]; result: CommandResult }> = [];
  private hangs: string[][] = [];
  readonly calls: string[][] = [];
  readonly optsLog: Array<RunOptions | undefined> = [];

  expect(argv: string[], result: Partial<CommandResult> = {}): void {
    this.expectations.push({
      argv: [...argv],
      result: { stdout: "", stderr: "", exitCode: 0, ...result },
    });
  }

  /** Record an argv whose run never resolves (simulates a hung subprocess). */
  expectHang(argv: string[]): void {
    this.hangs.push([...argv]);
  }

  async run(argv: string[], opts?: RunOptions): Promise<CommandResult> {
    this.calls.push([...argv]);
    this.optsLog.push(opts);
    const hangIdx = this.hangs.findIndex((h) => arraysEqual(h, argv));
    if (hangIdx !== -1) {
      this.hangs.splice(hangIdx, 1);
      return new Promise<CommandResult>(() => {});
    }
    const idx = this.expectations.findIndex((e) => arraysEqual(e.argv, argv));
    if (idx === -1) {
      const unexpected = argv.join(" ");
      const recorded = this.expectations.map((e) => e.argv.join(" ")).join(" | ");
      throw new Error(
        `MemoryRunner: unexpected command "${unexpected}". Recorded but uncalled: ${recorded || "(none)"}`,
      );
    }
    const [found] = this.expectations.splice(idx, 1);
    if (!found) throw new Error(`MemoryRunner: missing expectation for "${argv.join(" ")}"`);
    return found.result;
  }

  assertSatisfied(): void {
    const remaining = [
      ...this.expectations.map((e) => e.argv.join(" ")),
      ...this.hangs.map((h) => `${h.join(" ")} (hang)`),
    ];
    if (remaining.length === 0) return;
    throw new Error(`MemoryRunner: unconsumed expected command(s): ${remaining.join("; ")}`);
  }

  called(...argv: string[]): boolean {
    return this.calls.some((c) => arraysEqual(c, argv));
  }
}
