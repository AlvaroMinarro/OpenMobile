import { describe, expect, it } from "bun:test";
import { WS_CLOSE_CODES } from "../src/stream/types";
import {
  ControlError,
  grpcControlInjector,
  parseControlJson,
  sendControlEvent,
  type ControlInjector,
} from "../src/stream/control";
import { GrpcControlError } from "../src/device/grpc";
import type { EmulatorControl } from "../src/device/grpc";

/**
 * Control backend = gRPC unary (design D3/D5, input-channel delta). The
 * in-guest control-socket encoder is GONE: `parseControlJson` still validates
 * the frozen WS JSON contract, and `grpcControlInjector` routes the parsed
 * event onto EmulatorController in DEVICE PHYSICAL pixels. Coordinates are
 * no longer video-space — validation against the physical display happens
 * inside the gRPC control client (OUT_OF_RANGE maps back to ControlError).
 */

const VIDEO_SPACE_ERROR = new GrpcControlError(
  "OUT_OF_RANGE",
  "coordinates out of physical display space (0..1079, 0..2339)",
  { x: 430, y: 100 },
);

/** Recording EmulatorControl double; `failWith` makes every gesture throw. */
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

describe("WS close codes — RTC error-state contract (spec: Error States)", () => {
  it("carries PERMISSION_DENIED (4401) for token/allowlist blocks alongside the legacy codes", () => {
    expect(WS_CLOSE_CODES.PERMISSION_DENIED).toBe(4401);
    expect(WS_CLOSE_CODES.NO_DEVICE).toBe(4404);
    expect(WS_CLOSE_CODES.DEVICE_LOST).toBe(4409);
    expect(WS_CLOSE_CODES.VIEWER_CAP).toBe(4429);
    expect(WS_CLOSE_CODES.UNSUPPORTED).toBe(4403);
  });
});

describe("grpcControlInjector — JSON inject → gRPC unary (design D3/D5)", () => {
  it("injects a tap via sendTouch in physical px (no video-space mapping)", async () => {
    const control = fakeControl();
    const injector = grpcControlInjector(control);
    await injector.inject({ type: "inject", event: "tap", x: 540, y: 1200 });
    expect(control.calls).toEqual(["tap(540,1200)"]);
  });

  it("injects a swipe with the duration preserved", async () => {
    const control = fakeControl();
    const injector = grpcControlInjector(control);
    await injector.inject({ type: "inject", event: "swipe", x1: 540, y1: 1800, x2: 540, y2: 400, durationMs: 300 });
    expect(control.calls).toEqual(["swipe(540,1800,540,400,300)"]);
  });

  it("injects text via sendKey(KeyboardEvent{text}) — full UTF-8, no sendText RPC (probe D)", async () => {
    const control = fakeControl();
    const injector = grpcControlInjector(control);
    await injector.inject({ type: "inject", event: "text", text: "hola ñ" });
    expect(control.calls).toEqual(["text(hola ñ)"]);
  });

  it("injects a key keycode via sendKey", async () => {
    const control = fakeControl();
    const injector = grpcControlInjector(control);
    await injector.inject({ type: "inject", event: "key", keycode: 4 });
    expect(control.calls).toEqual(["keyCode(4,0)"]);
  });

  it("maps gRPC OUT_OF_RANGE onto a ControlError with the same code", async () => {
    const control = fakeControl({ failWith: VIDEO_SPACE_ERROR });
    const injector = grpcControlInjector(control);
    const err = await injector.inject({ type: "inject", event: "tap", x: 430, y: 100 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ControlError);
    expect((err as ControlError).code).toBe("OUT_OF_RANGE");
    expect((err as ControlError).message).toContain("(0..1079, 0..2339)");
  });

  it("maps a gRPC device-offline failure onto an actionable ControlError (never a silent drop)", async () => {
    const control = fakeControl({
      failWith: new GrpcControlError("DEVICE_OFFLINE", "emulator gRPC unreachable: connection refused"),
    });
    const injector = grpcControlInjector(control);
    const err = await injector.inject({ type: "inject", event: "tap", x: 1, y: 2 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ControlError);
    expect((err as ControlError).code).toBe("DEVICE_OFFLINE");
  });

  it("rejects an unknown event type with UNSUPPORTED_EVENT", async () => {
    const injector = grpcControlInjector(fakeControl());
    const err = await injector.inject({ event: "poke" } as never).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ControlError);
    expect((err as ControlError).code).toBe("UNSUPPORTED_EVENT");
  });
});

describe("sendControlEvent — WS control route entrypoint (injector-backed)", () => {
  it("parses, injects through the active injector, and acknowledges", async () => {
    const control = fakeControl();
    const injector: ControlInjector = grpcControlInjector(control);
    const result = await sendControlEvent(
      injector,
      JSON.stringify({ type: "inject", event: "tap", x: 10, y: 20 }),
    );
    expect(result.ok).toBe(true);
    expect(control.calls).toEqual(["tap(10,20)"]);
  });

  it("returns the typed STREAM_OFF result when no injector is active", async () => {
    const result = await sendControlEvent(undefined, JSON.stringify({ type: "inject", event: "tap", x: 1, y: 2 }));
    expect(result).toEqual({
      ok: false,
      code: "STREAM_OFF",
      reason: "no active stream; use /v1/input REST fallback",
    });
  });

  it("throws ControlError on a malformed message (validation failures are NOT closes)", async () => {
    const err = await sendControlEvent(grpcControlInjector(fakeControl()), "not json").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ControlError);
    expect((err as ControlError).code).toBe("INVALID_JSON");
  });

  it("propagates injector failures as ControlError (injection failure scenario)", async () => {
    const control = fakeControl({ failWith: new GrpcControlError("PERMISSION_DENIED", "denied", undefined, 4401) });
    const err = await sendControlEvent(
      grpcControlInjector(control),
      JSON.stringify({ type: "inject", event: "tap", x: 1, y: 2 }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ControlError);
    expect((err as ControlError).code).toBe("PERMISSION_DENIED");
  });
});

describe("parseControlJson — WS /v1/stream/control contract shapes (frozen)", () => {
  it("accepts the documented inject shapes (tap, swipe, text, key)", () => {
    const tap = parseControlJson(JSON.stringify({ type: "inject", event: "tap", x: 215, y: 480 }));
    expect(tap.ok).toBe(true);
    if (tap.ok) expect(tap.event).toEqual({ type: "inject", event: "tap", x: 215, y: 480 });

    const swipe = parseControlJson(
      JSON.stringify({ type: "inject", event: "swipe", x1: 0, y1: 0, x2: 1, y2: 1, durationMs: 80 }),
    );
    expect(swipe.ok).toBe(true);
    if (swipe.ok) expect(swipe.event).toEqual({ type: "inject", event: "swipe", x1: 0, y1: 0, x2: 1, y2: 1, durationMs: 80 });

    const text = parseControlJson(JSON.stringify({ type: "inject", event: "text", text: "hi" }));
    expect(text.ok).toBe(true);

    const key = parseControlJson(JSON.stringify({ type: "inject", event: "key", keycode: 3 }));
    expect(key.ok).toBe(true);
    if (key.ok) expect(key.event).toEqual({ type: "inject", event: "key", keycode: 3 });
  });

  it("rejects unknown types / unknown events / malformed payloads (Unknown inject type)", () => {
    expect(parseControlJson("not json").ok).toBe(false);
    expect(parseControlJson(JSON.stringify({ type: "other", x: 1 })).ok).toBe(false);
    expect(parseControlJson(JSON.stringify({ type: "inject", event: "poke" })).ok).toBe(false);
    expect(parseControlJson(JSON.stringify({ type: "inject", event: "tap" })).ok).toBe(false); // missing x/y
    expect(parseControlJson(JSON.stringify({ type: "inject", event: "key" })).ok).toBe(false); // missing keycode
    expect(parseControlJson(JSON.stringify({ type: "inject", event: "text" })).ok).toBe(false); // missing text
  });
});
