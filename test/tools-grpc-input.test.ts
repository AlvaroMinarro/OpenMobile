import { describe, expect, it } from "bun:test";
import { AndroidCli } from "../src/device/androidCli";
import { AdbWrapper } from "../src/device/adb";
import { GrpcControlError } from "../src/device/grpc";
import type { EmulatorControl } from "../src/device/grpc";
import { inputText, pressKey, swipe, tap } from "../src/tools/handlers";
import { tapSchema, swipeSchema } from "../src/tools/schemas";
import type { DeviceContext } from "../src/tools/context";
import { MemoryRunner } from "./helpers/memoryRunner";

const textOf = (res: { content: Array<{ type: string; text?: string }> }): string =>
  res.content.find((c) => c.type === "text")?.text ?? "";

/**
 * gRPC-first input injection (input-channel delta, design D3/D5): when the
 * selected emulator exposes a usable EmulatorController the handlers inject
 * via gRPC unary in DEVICE PHYSICAL pixels; `adb shell input` is the fallback
 * when there is no gRPC surface (physical devices, external launch without a
 * pid ini). A failing gRPC call is an actionable error — never a silent
 * fallback (Injection-failure spec scenario).
 */

/** Recording EmulatorControl double; `failWith` makes the NEXT gesture throw. */
function fakeControl(opts: { failWith?: GrpcControlError } = {}): EmulatorControl & { calls: string[] } {
  const calls: string[] = [];
  const wrap = async (name: string, fn: () => Promise<void>): Promise<void> => {
    if (opts.failWith) throw opts.failWith;
    calls.push(name);
  };
  return {
    calls,
    tap: (x, y) => wrap(`tap(${x},${y})`, async () => {}),
    swipe: (x1, y1, x2, y2, durationMs) => wrap(`swipe(${x1},${y1},${x2},${y2},${durationMs})`, async () => {}),
    text: (t) => wrap(`text(${t})`, async () => {}),
    keyPress: (k) => wrap(`key(${k})`, async () => {}),
    keyCode: (c, t) => wrap(`keyCode(${c},${t})`, async () => {}),
    reportDisplaySize: () => undefined,
    refreshDisplay: async () => ({ width: 1080, height: 2400 }),
  };
}

function makeCtx(
  runner: MemoryRunner,
  control: (EmulatorControl & { calls: string[] }) | null = null,
  grpcControl?: (serial: string) => Promise<EmulatorControl | null>,
): DeviceContext & { control?: EmulatorControl & { calls: string[] } } {
  return {
    cli: new AndroidCli(runner),
    adb: new AdbWrapper(runner),
    env: {},
    baselineEstablished: new Set<string>(),
    timeoutMs: 200,
    tempPngPath: () => `/tmp/om-test-${Date.now()}.png`,
    ...(grpcControl
      ? { grpcControl, control }
      : {}),
  } as DeviceContext & { control?: EmulatorControl & { calls: string[] } };
}

describe("input gRPC-first — tap", () => {
  it("routes a tap through gRPC unary and never touches adb", async () => {
    const runner = new MemoryRunner();
    const control = fakeControl();
    const ctx = makeCtx(runner, control, async () => control);
    const res = await tap(ctx, { x: 540, y: 1200, device: "emulator-5554" });
    expect(res.isError).toBeFalsy();
    expect(control.calls).toEqual(["tap(540,1200)"]); // physical px, verbatim
    expect(runner.called("adb", "-s", "emulator-5554", "shell", "input", "tap", "540", "1200")).toBe(false);
    runner.assertSatisfied();
  });

  it("falls back to `adb shell input tap` when there is no gRPC surface", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", "emulator-5554", "shell", "wm", "size"], {
      stdout: "Physical size: 1080x2400\n",
    });
    runner.expect(["adb", "-s", "emulator-5554", "shell", "input", "tap", "540", "1200"], {});
    const ctx = makeCtx(runner);
    const res = await tap(ctx, { x: 540, y: 1200, device: "emulator-5554" });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({
      injected: "tap",
      x: 540,
      y: 1200,
      serial: "emulator-5554",
    });
    runner.assertSatisfied();
  });

  it("surfaces a gRPC out-of-range error stating the valid physical range", async () => {
    const runner = new MemoryRunner();
    const control = fakeControl({
      failWith: new GrpcControlError(
        "OUT_OF_RANGE",
        "coordinates out of physical display space (0..1079, 0..2339)",
        { x: 5000, y: 10 },
      ),
    });
    const ctx = makeCtx(runner, control, async () => control);
    const res = await tap(ctx, { x: 5000, y: 10, device: "emulator-5554" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("out of physical display space (0..1079, 0..2339)");
    // Never a silent drop, never an adb retry after a validation failure.
    expect(runner.called("adb", "-s", "emulator-5554", "shell", "input", "tap", "5000", "10")).toBe(false);
  });

  it("returns an actionable error when gRPC fails — no silent adb fallback", async () => {
    const runner = new MemoryRunner();
    const control = fakeControl({
      failWith: new GrpcControlError("DEVICE_OFFLINE", "emulator gRPC unreachable: connection refused"),
    });
    const ctx = makeCtx(runner, control, async () => control);
    const res = await tap(ctx, { x: 10, y: 10, device: "emulator-5554" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("gRPC unreachable");
  });
});

describe("input gRPC-first — swipe / text / key", () => {
  it("routes a swipe through gRPC (physical px, duration preserved)", async () => {
    const runner = new MemoryRunner();
    const control = fakeControl();
    const ctx = makeCtx(runner, control, async () => control);
    const res = await swipe(ctx, { x1: 540, y1: 1800, x2: 540, y2: 400, durationMs: 300, device: "emulator-5554" });
    expect(res.isError).toBeFalsy();
    expect(control.calls).toEqual(["swipe(540,1800,540,400,300)"]);
    runner.assertSatisfied();
  });

  it("falls back to `adb shell input swipe` when there is no gRPC surface", async () => {
    const runner = new MemoryRunner();
    runner.expect(
      ["adb", "-s", "emulator-5554", "shell", "input", "swipe", "540", "1800", "540", "400", "300"],
      {},
    );
    const ctx = makeCtx(runner);
    const res = await swipe(ctx, { x1: 540, y1: 1800, x2: 540, y2: 400, durationMs: 300, device: "emulator-5554" });
    expect(res.isError).toBeFalsy();
    runner.assertSatisfied();
  });

  it("routes text through gRPC sendKey(KeyboardEvent{text}) — no sendText RPC (probe D)", async () => {
    const runner = new MemoryRunner();
    const control = fakeControl();
    const ctx = makeCtx(runner, control, async () => control);
    const res = await inputText(ctx, { text: "hello world", device: "emulator-5554" });
    expect(res.isError).toBeFalsy();
    expect(control.calls).toEqual(["text(hello world)"]);
    runner.assertSatisfied();
  });

  it("falls back to `adb shell input text` when there is no gRPC surface", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", "emulator-5554", "shell", "input", "text", "hello"], {});
    const ctx = makeCtx(runner);
    const res = await inputText(ctx, { text: "hello", device: "emulator-5554" });
    expect(res.isError).toBeFalsy();
    runner.assertSatisfied();
  });

  it("maps known navigation keys to W3C gRPC names (probe D: GoHome)", async () => {
    const runner = new MemoryRunner();
    const control = fakeControl();
    const ctx = makeCtx(runner, control, async () => control);
    const home = await pressKey(ctx, { key: "home", device: "emulator-5554" });
    expect(home.isError).toBeFalsy();
    expect(control.calls).toContain("key(GoHome)");
    control.calls.length = 0;
    const back = await pressKey(ctx, { key: "back", device: "emulator-5554" });
    expect(back.isError).toBeFalsy();
    expect(control.calls).toContain("key(GoBack)");
    runner.assertSatisfied(); // adb never touched for mapped keys
  });

  it("falls back to adb keyevent for keys outside the gRPC name map", async () => {
    const runner = new MemoryRunner();
    const control = fakeControl();
    runner.expect(["adb", "-s", "emulator-5554", "shell", "input", "keyevent", "187"], {});
    const ctx = makeCtx(runner, control, async () => control);
    const res = await pressKey(ctx, { key: "app_switch", device: "emulator-5554" });
    expect(res.isError).toBeFalsy();
    expect(control.calls).toEqual([]); // unmapped key never sent over gRPC
    runner.assertSatisfied();
  });

  it("falls back to adb keyevent when there is no gRPC surface at all", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", "emulator-5554", "shell", "input", "keyevent", "4"], {});
    const ctx = makeCtx(runner);
    const res = await pressKey(ctx, { key: "back", device: "emulator-5554" });
    expect(res.isError).toBeFalsy();
    runner.assertSatisfied();
  });
});

describe("schemas — physical-px contract surfaced in descriptions", () => {
  it("documents tap/swipe coordinates as device physical pixels", () => {
    expect(tapSchema.shape["x"]?.description).toMatch(/physical/i);
    expect(tapSchema.shape["y"]?.description).toMatch(/physical/i);
    expect(swipeSchema.shape["x1"]?.description).toMatch(/physical/i);
  });
});
