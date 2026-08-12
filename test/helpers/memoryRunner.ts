import type { CommandResult, CommandRunner } from "../../src/device/runner";

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
 */
export class MemoryRunner implements CommandRunner {
  private expectations: Array<{ argv: string[]; result: CommandResult }> = [];
  readonly calls: string[][] = [];

  expect(argv: string[], result: Partial<CommandResult> = {}): void {
    this.expectations.push({
      argv: [...argv],
      result: { stdout: "", stderr: "", exitCode: 0, ...result },
    });
  }

  async run(argv: string[]): Promise<CommandResult> {
    this.calls.push([...argv]);
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
    if (this.expectations.length === 0) return;
    const remaining = this.expectations.map((e) => e.argv.join(" ")).join("; ");
    throw new Error(`MemoryRunner: unconsumed expected command(s): ${remaining}`);
  }

  called(...argv: string[]): boolean {
    return this.calls.some((c) => arraysEqual(c, argv));
  }
}
