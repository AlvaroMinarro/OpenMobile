import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GrpcRtcClient,
  defaultRunDir,
  findEmulatorConfig,
  parsePidIni,
  resolveRtcCapability,
} from "../src/device/grpc";

/**
 * LIVE conformance (task 2.10) — probe-b2 elevated: a real RtcService v1
 * offer/answer/ICE round-trip against a RUNNING emulator. GATED: skipped
 * unless OPENMOBILE_RTC_LIVE=1 AND a bridge-launched emulator with a pid ini
 * is reachable (ANDROID_DEVICE or the single emulator-* ini). Never faked:
 * without a live emulator these tests simply do not run.
 *
 * Scope note: the wire-level round-trip proven here is requestRtcStream →
 * start/offer (VP8 m-line) → answer/ICE accepted by the service → bye ends
 * cleanly. The full BROWSER-side RTCPeerConnection round-trip (media
 * flowing over loopback UDP) is exercised by the PR3 demo page
 * (examples/stream.html) against a live bridge — a fabricated SDP answer
 * cannot negotiate media, so this test verifies the WIRE contract, not
 * media.
 */

const LIVE = process.env["OPENMOBILE_RTC_LIVE"] === "1";
const itLive = LIVE ? it : it.skip;

/** The serial to test: ANDROID_DEVICE, else the single emulator pid ini. */
function liveSerial(): string | null {
  const env = process.env["ANDROID_DEVICE"];
  if (env) return env;
  const dir = defaultRunDir();
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^pid_\d+\.ini$/.test(n));
  } catch {
    return null;
  }
  const serials = new Set<string>();
  for (const name of names) {
    try {
      const ini = parsePidIni(readFileSync(join(dir, name), "utf8"));
      if (ini["port.serial"]) serials.add(`emulator-${ini["port.serial"]}`);
    } catch {
      // torn ini — skip
    }
  }
  const list = [...serials];
  return list.length === 1 ? list[0]! : null;
}

describe("live RtcService v1 conformance (OPENMOBILE_RTC_LIVE=1)", () => {
  itLive("requestRtcStream → start/offer (VP8) → answer/ICE accepted → bye", async () => {
    const serial = liveSerial();
    if (!serial) {
      console.warn("[rtc-live] no bridge-launched emulator found; skipping live round-trip");
      return;
    }
    const dir = defaultRunDir();
    const cfg = findEmulatorConfig(dir, serial);
    if (!cfg) {
      console.warn(`[rtc-live] no pid ini for ${serial}; skipping`);
      return;
    }
    const cap = resolveRtcCapability(dir, serial);
    expect(cap.supported).toBe(true);
    const client = new GrpcRtcClient(cap.endpoint!.addr, cap.endpoint!.token);
    try {
      // 1. requestRtcStream issues a live guid.
      const guid = await client.requestRtcStream();
      expect(guid.length).toBeGreaterThan(0);
      // 2. The blocking receive stream yields start, then the offer.
      const payloads: string[] = [];
      const iter = client.receiveJsepMessages(guid)[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([
          iter.next(),
          new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5000)),
        ]);
        if (next === "timeout") throw new Error("no JSEP message within 5s — is the emulator streaming?");
        if (next.done) break;
        payloads.push(next.value.message);
        const parsed = JSON.parse(next.value.message) as { type?: string; sdp?: string };
        if (parsed.type === "offer") break;
      }
      expect(payloads[0]).toContain("start");
      const offer = payloads.find((p) => p.includes('"offer"'));
      expect(offer).toBeDefined();
      expect(offer!).toContain("m=video");
      // 3. The service ACCEPTS the answer + ICE dictionaries (wire round-trip).
      const answerSdp = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=probe\r\n";
      await client.sendJsepMessage(guid, JSON.stringify({ type: "answer", sdp: answerSdp }));
      await client.sendJsepMessage(
        guid,
        JSON.stringify({ candidate: "candidate:1 1 UDP 2130706431 127.0.0.1 1111 typ host", sdpMid: "0", sdpMLineIndex: 0 }),
      );
      // 4. bye ends the negotiation cleanly.
      await client.sendJsepMessage(guid, JSON.stringify({ bye: true }));
      client.cancelReceive(guid);
    } finally {
      client.close();
    }
  }, 20_000);
});
