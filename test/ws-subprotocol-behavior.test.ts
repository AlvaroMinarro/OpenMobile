/**
 * Pins Bun.serve's WebSocket subprotocol behavior on the wire (design D1,
 * bridge-surface-v2 task 0.1 / SPIKE-1 — promoted from throwaway spike to a
 * permanent regression guard: if a Bun upgrade changes subprotocol semantics,
 * these tests fail loudly BEFORE task 1.5 builds on stale assumptions).
 *
 * Pinned facts (observed on Bun 1.4.0, 2026-08-22):
 *  (a) `server.upgrade(req, { headers })` emits an explicit
 *      `sec-websocket-protocol` response header EXACTLY ONCE — VERDICT:
 *      echo-ok, no duplication.
 *  (b) With no explicit header, Bun AUTO-SELECTS and echoes the FIRST
 *      client-offered subprotocol; against an empty offer it selects none.
 *      Therefore "select none" is impossible while the client offers any
 *      protocol, and relying on auto-negotiation alone would let the 101
 *      agree a protocol entry that was never validated (e.g. a client
 *      offering ["chat", "openmobile.bearer.T"] gets "chat" echoed). D1's
 *      explicit echo of the VALIDATED entry stays mandatory.
 *  (c) An explicit header REPLACES auto-selection (never duplicates it), even
 *      when the value was not among the client's offers.
 *
 * Method: a browser-style `WebSocket` client hides handshake responses, so
 * ground truth here is a RAW TCP client writing a RFC 6455 upgrade request
 * and parsing the literal 101 bytes (duplicate headers included); the
 * platform client complements it by exposing negotiated `ws.protocol`.
 */
import { describe, expect, it } from "bun:test";
import { connect, type Socket } from "node:net";

/** Client-requested subprotocols used across the probes. */
const CLIENT_PROTOCOLS = ["chat", "openmobile.bearer.T"];
/** The credential-shaped entry the bridge echoes per design D1. */
const CREDENTIAL_ENTRY = "openmobile.bearer.T";

interface HandshakeResponse {
  statusLine: string;
  /** Lowercased header name -> every raw value seen (duplicates preserved). */
  headers: Map<string, string[]>;
  /** Bytes after the blank line: first WS frames the server pushed. */
  tail: Buffer;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Parse accumulated handshake bytes into status line + header map + tail. */
function parseHandshakeBytes(all: Buffer): HandshakeResponse {
  const idx = all.indexOf("\r\n\r\n");
  if (idx < 0) throw new Error(`rawHandshake: closed before headers: "${all.toString("latin1")}"`);
  const headEnd = idx + 4;
  const lines = all.subarray(0, headEnd).toString("latin1").split("\r\n");
  const headers = new Map<string, string[]>();
  for (const line of lines.slice(1)) {
    const hIdx = line.indexOf(":");
    if (hIdx <= 0) continue;
    const name = line.slice(0, hIdx).trim().toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), line.slice(hIdx + 1).trim()]);
  }
  return { statusLine: lines[0] ?? "", headers, tail: all.subarray(headEnd) };
}

/** Perform a raw RFC 6455 handshake and capture the verbatim 101 bytes. */
function rawHandshake(port: number, protocols: string[], graceMs = 300): Promise<HandshakeResponse> {
  return new Promise<HandshakeResponse>((resolve, reject) => {
    let socket: Socket | undefined;
    const chunks: Buffer[] = [];
    let headEnd = -1;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      fn();
    };

    // Hard watchdog: a hung handshake must fail fast, never stall `bun test`.
    const watchdog = setTimeout(() => {
      finish(() => {
        socket?.destroy();
        reject(new Error("rawHandshake: no complete response"));
      });
    }, 4000);

    const settleWhenReady = () => {
      if (headEnd < 0) return;
      // Give the server a short grace window to push its first WS frame.
      setTimeout(() => {
        finish(() => {
          socket?.destroy();
          resolve(parseHandshakeBytes(Buffer.concat(chunks)));
        });
      }, graceMs);
    };

    socket = connect({ host: "127.0.0.1", port }, () => {
      // Exactly 16 random-ish bytes -> 24-char base64 key per RFC 6455 §4.1.
      const key = Buffer.from("0123456789abcdef", "utf8").toString("base64");
      const req = [
        "GET /ws HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        protocols.length > 0 ? `Sec-WebSocket-Protocol: ${protocols.join(", ")}` : undefined,
        "",
        "",
      ]
        .filter((l) => l !== undefined)
        .join("\r\n");
      socket?.write(req);
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (headEnd < 0) {
        const idx = Buffer.concat(chunks).indexOf("\r\n\r\n");
        headEnd = idx >= 0 ? idx + 4 : -1;
      }
      settleWhenReady();
    });
    socket.on("error", (err: Error) => {
      finish(() => {
        socket?.destroy();
        reject(err);
      });
    });
    socket.on("close", () => {
      // Server hung up: settle with whatever arrived so assertions can see it.
      finish(() => resolve(parseHandshakeBytes(Buffer.concat(chunks))));
    });
  });
}

interface ProbeServer {
  port: number;
  /** What the server-side Request saw for `sec-websocket-protocol`. */
  seenRequestProtocol(): string | null;
  serverOpenCount(): number;
  stop(): void;
}

/**
 * Real Bun.serve whose fetch always upgrades, optionally passing explicit
 * 101-response headers into `server.upgrade()` (design D1's mechanism).
 * On open it pushes a text frame so probes can prove the socket works.
 */
function startProbeServer(upgradeHeaders?: Record<string, string>): ProbeServer {
  let seenProtocol: string | null = null;
  let opens = 0;
  const server = Bun.serve<Record<string, unknown>>({
    port: 0,
    fetch(req, srv) {
      seenProtocol = req.headers.get("sec-websocket-protocol");
      const upgraded = srv.upgrade(req, {
        data: {},
        ...(upgradeHeaders ? { headers: upgradeHeaders } : {}),
      });
      if (!upgraded) return new Response("upgrade refused", { status: 400 });
      return undefined;
    },
    websocket: {
      open(ws) {
        opens += 1;
        ws.send("om-probe-ok");
      },
      message() {},
    },
  });
  return {
    // Bun assigns the real ephemeral port once listening; type says `?`.
    port: server.port ?? 0,
    seenRequestProtocol: () => seenProtocol,
    serverOpenCount: () => opens,
    stop: () => server.stop(true),
  };
}

describe("Bun.serve WS subprotocol behavior pinned for design D1 (task 0.1 / SPIKE-1)", () => {
  it("(a) explicit sec-websocket-protocol via upgrade({headers}) lands exactly once [VERDICT echo-ok]", async () => {
    const probe = startProbeServer({ "sec-websocket-protocol": CREDENTIAL_ENTRY });
    try {
      const res = await withTimeout(
        rawHandshake(probe.port, CLIENT_PROTOCOLS),
        5000,
        "(a) explicit-echo handshake",
      );
      expect(res.statusLine).toContain("101");
      // The server must have seen BOTH requested protocols in its request.
      expect(probe.seenRequestProtocol()).toBe(CLIENT_PROTOCOLS.join(", "));
      // THE VERDICT: exactly one protocol header whose value is our echo —
      // never duplicated next to Bun's own auto-selection.
      const protoValues = res.headers.get("sec-websocket-protocol") ?? [];
      expect(protoValues).toEqual([CREDENTIAL_ENTRY]);
      // Sanity: the 101 carries the accept key (real upgrade, not a stub).
      expect(res.headers.get("sec-websocket-accept")).toBeDefined();
    } finally {
      probe.stop();
    }
  });

  it("(b) Bun AUTO-negotiates: echoes the FIRST offered protocol when the server passes none", async () => {
    const probe = startProbeServer(); // server passes NO explicit protocol header
    try {
      // Single-entry offer: the credential entry itself gets auto-echoed.
      const single = await withTimeout(
        rawHandshake(probe.port, [CREDENTIAL_ENTRY]),
        5000,
        "(b) single-offer handshake",
      );
      expect(single.statusLine).toContain("101");
      expect(single.headers.get("sec-websocket-protocol")).toEqual([CREDENTIAL_ENTRY]);

      // Multi-entry offer: Bun picks the FIRST offered ("chat"), NOT the
      // credential entry — why D1 must validate explicitly and echo its OWN
      // choice, never trusting the runtime's automatic selection.
      const multi = await withTimeout(
        rawHandshake(probe.port, CLIENT_PROTOCOLS),
        5000,
        "(b) multi-offer handshake",
      );
      expect(multi.statusLine).toContain("101");
      expect(multi.headers.get("sec-websocket-protocol")).toEqual(["chat"]);

      // Platform-client view of the single-entry case: ws.protocol carries
      // the auto-selected entry exactly as browsers would observe it.
      const negotiated = await withTimeout(
        new Promise<string>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${probe.port}/ws`, [CREDENTIAL_ENTRY]);
          ws.addEventListener("open", () => {
            resolve(ws.protocol);
            ws.close();
          });
          ws.addEventListener("error", () => reject(new Error("platform client failed")));
        }),
        5000,
        "(b) platform client",
      );
      expect(negotiated).toBe(CREDENTIAL_ENTRY);
    } finally {
      probe.stop();
    }
  });

  it("(c) select-none is only possible against an EMPTY offer; explicit header overrides any selection", async () => {
    const probe = startProbeServer(); // passes no protocol header by default
    try {
      // Empty offer -> nothing to select: 101 with NO protocol header, and
      // the accepted socket is fully usable (open fired, text frame pushed:
      // first tail byte is the 0x81 FIN+text opcode).
      const emptyOffer = await withTimeout(
        rawHandshake(probe.port, []),
        5000,
        "(c) empty-offer handshake",
      );
      expect(emptyOffer.statusLine).toContain("101");
      expect(emptyOffer.headers.has("sec-websocket-protocol")).toBe(false);
      expect(probe.serverOpenCount()).toBe(1);
      expect(emptyOffer.tail.length).toBeGreaterThan(0);
      expect(emptyOffer.tail[0]).toBe(0x81);
      expect(emptyOffer.tail.toString("latin1")).toContain("om-probe-ok");

      // Non-empty offer + no explicit header -> Bun ALWAYS selects (first
      // entry): the server cannot decline selection while offers exist.
      const autoSelected = await withTimeout(
        rawHandshake(probe.port, CLIENT_PROTOCOLS),
        5000,
        "(c) auto-select handshake",
      );
      expect(autoSelected.statusLine).toContain("101");
      expect(autoSelected.headers.get("sec-websocket-protocol")).toEqual(["chat"]);
    } finally {
      probe.stop();
    }
  });

  it("(d) explicit header REPLACES auto-selection even for a non-offered value (no duplication)", async () => {
    const probe = startProbeServer({ "sec-websocket-protocol": "custom.proto.v9" });
    try {
      const res = await withTimeout(
        rawHandshake(probe.port, CLIENT_PROTOCOLS),
        5000,
        "(d) override handshake",
      );
      expect(res.statusLine).toContain("101");
      expect(res.headers.get("sec-websocket-protocol")).toEqual(["custom.proto.v9"]);
    } finally {
      probe.stop();
    }
  });
});
