import { describe, expect, it } from "bun:test";
import {
  MAX_VIEWERS,
  WS_CLOSE_CODES,
  parseClientJsep,
  parseJsepPayload,
  type RtcClientMessage,
  type RtcServerMessage,
} from "../src/stream/types";

/**
 * JSEP signaling contract types + the client-frame parser (task 2.4). The
 * shapes are pinned to the design's WS contract (handshake/offer/answer/ice/
 * state server→client; answer/ice/state client→server) and the verbatim gRPC
 * JSEP dictionary relay (probe B): {"start":{}}, {"sdp","type"},
 * {"candidate","sdpMid","sdpMLineIndex"}, {"bye":true}.
 */

describe("JSEP WS message shapes (Signaling Channel requirement)", () => {
  it("server→client messages match the design contract exactly", () => {
    const handshake: RtcServerMessage = { type: "handshake", rtcId: "guid-1", fps: 60, codecs: ["VP8"] };
    const offer: RtcServerMessage = { type: "offer", sdp: "v=0" };
    const answer: RtcServerMessage = { type: "answer", sdp: "v=0" };
    const ice: RtcServerMessage = {
      type: "ice",
      candidate: { candidate: "candidate:1 1 UDP 2130706431 127.0.0.1 1111 typ host", sdpMid: "0", sdpMLineIndex: 0 },
    };
    const state: RtcServerMessage = { type: "state", state: "streaming" };
    const connecting: RtcServerMessage = { type: "state", state: "connecting" };
    const errored: RtcServerMessage = { type: "state", state: "error", reason: "device_lost" };
    expect([handshake, offer, answer, ice, state, connecting, errored].map((m) => m.type)).toEqual([
      "handshake",
      "offer",
      "answer",
      "ice",
      "state",
      "state",
      "state",
    ]);
  });

  it("client→server messages are the answer/ice/state subset", () => {
    const answer: RtcClientMessage = { type: "answer", sdp: "v=0" };
    const ice: RtcClientMessage = { type: "ice", candidate: { candidate: "candidate:1", sdpMid: "0" } };
    const streaming: RtcClientMessage = { type: "state", state: "streaming" };
    expect([answer.type, ice.type, streaming.type]).toEqual(["answer", "ice", "state"]);
  });

  it("keeps the 4429 VIEWER_CAP (ours, design D2) and pins the close-code table", () => {
    expect(MAX_VIEWERS).toBe(8);
    expect(WS_CLOSE_CODES).toMatchObject({
      UNSUPPORTED: 4403,
      PERMISSION_DENIED: 4401,
      NO_DEVICE: 4404,
      DEVICE_LOST: 4409,
      VIEWER_CAP: 4429,
      BAD_MESSAGE: 4400,
    });
  });
});

describe("parseClientJsep — the signaling WS input validation (Malformed signaling)", () => {
  it("accepts a valid answer frame", () => {
    const parsed = parseClientJsep('{"type":"answer","sdp":"v=0 answer"}');
    expect(parsed).toEqual({ ok: true, msg: { type: "answer", sdp: "v=0 answer" } });
  });

  it("accepts a valid ice frame and relays the candidate dictionary verbatim", () => {
    const candidate = {
      candidate: "candidate:1 1 UDP 2130706431 127.0.0.1 1111 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    };
    const parsed = parseClientJsep(JSON.stringify({ type: "ice", candidate }));
    expect(parsed).toEqual({ ok: true, msg: { type: "ice", candidate } });
  });

  it("accepts the state:streaming frame (client reports peer connected)", () => {
    expect(parseClientJsep('{"type":"state","state":"streaming"}')).toEqual({
      ok: true,
      msg: { type: "state", state: "streaming" },
    });
  });

  it("rejects non-JSON frames with a BAD_MESSAGE error body", () => {
    const parsed = parseClientJsep("this is not json");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe("BAD_MESSAGE");
  });

  it("rejects unknown types (never a silent hang)", () => {
    const parsed = parseClientJsep('{"type":"offer","sdp":"client cannot offer"}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("offer");
  });

  it("rejects non-object frames and missing required fields", () => {
    expect(parseClientJsep("[1,2]").ok).toBe(false);
    expect(parseClientJsep('{"type":"answer"}').ok).toBe(false); // no sdp
    expect(parseClientJsep('{"type":"answer","sdp":""}').ok).toBe(false); // empty sdp
    expect(parseClientJsep('{"type":"ice"}').ok).toBe(false); // no candidate
    expect(parseClientJsep('{"type":"ice","candidate":"not-a-dict"}').ok).toBe(false);
    expect(parseClientJsep('{"type":"state","state":"error"}').ok).toBe(false); // client may only report streaming
  });
});

describe("parseJsepPayload — verbatim gRPC JSEP dictionary decode (probe B)", () => {
  it("decodes start / sdp / candidate / bye payloads", () => {
    expect(parseJsepPayload('{"start":{}}')).toEqual({ start: {} });
    expect(parseJsepPayload('{"type":"offer","sdp":"v=0"}')).toEqual({ type: "offer", sdp: "v=0" });
    expect(
      parseJsepPayload('{"candidate":"candidate:1","sdpMid":"0","sdpMLineIndex":0}'),
    ).toEqual({ candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 });
    expect(parseJsepPayload('{"bye":true}')).toEqual({ bye: true });
  });

  it("returns null for malformed payloads (relay skips, never crashes)", () => {
    expect(parseJsepPayload("not json")).toBeNull();
    expect(parseJsepPayload('{"unknown":1}')).toBeNull();
    expect(parseJsepPayload('{"sdp":"v=0"}')).toBeNull(); // sdp without type
    expect(parseJsepPayload('{"bye":false}')).toBeNull(); // not a real bye
  });
});
