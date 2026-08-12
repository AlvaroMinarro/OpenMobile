import { describe, expect, it } from "bun:test";
import { resolveDeviceSelection } from "../src/device/selection";
import type { Device } from "../src/device/types";

const dev = (serial: string): Device => ({ serial, state: "device" });

describe("resolveDeviceSelection — precedence: explicit > env > single-device auto-detect", () => {
  it("prefers the explicit --device argument over env and auto-detect", () => {
    const r = resolveDeviceSelection({
      explicit: "emulator-5554",
      env: "emulator-5556",
      devices: [dev("emulator-5554"), dev("emulator-5556")],
    });
    expect(r).toEqual({ ok: true, serial: "emulator-5554" });
  });

  it("uses ANDROID_DEVICE env when no explicit arg is given", () => {
    const r = resolveDeviceSelection({
      env: "emulator-5556",
      devices: [dev("emulator-5554"), dev("emulator-5556")],
    });
    expect(r).toEqual({ ok: true, serial: "emulator-5556" });
  });

  it("auto-detects the single attached device when nothing else selects", () => {
    const r = resolveDeviceSelection({ devices: [dev("emulator-5554")] });
    expect(r).toEqual({ ok: true, serial: "emulator-5554" });
  });

  it("fails ambiguously listing every serial when multiple devices and no selection", () => {
    const r = resolveDeviceSelection({
      devices: [dev("emulator-5554"), dev("emulator-5556")],
    });
    expect(r).toEqual({
      ok: false,
      reason: "ambiguous",
      serials: ["emulator-5554", "emulator-5556"],
    });
  });

  it("reports no usable devices when none are attached", () => {
    expect(resolveDeviceSelection({ devices: [] })).toEqual({
      ok: false,
      reason: "no-devices",
    });
  });
});
