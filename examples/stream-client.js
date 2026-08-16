// src/stream/client/annexb.ts
function classifyNal(nal) {
  const h = nal[0];
  if (h === undefined || (h & 128) !== 0)
    return "slice";
  const type = h & 31;
  if (type === 7)
    return "sps";
  if (type === 8)
    return "pps";
  if (type === 5)
    return "idr";
  return "slice";
}

class AnnexBSplitter {
  pending = new Uint8Array(0);
  push(chunk) {
    if (this.pending.length === 0) {
      this.pending = chunk;
      return;
    }
    const next = new Uint8Array(this.pending.length + chunk.length);
    next.set(this.pending, 0);
    next.set(chunk, this.pending.length);
    this.pending = next;
  }
  drain(segmentEnd = false) {
    const out = [];
    const n = this.pending.length;
    let cursor = 0;
    let i = 0;
    while (i + 2 < n && cursor < n) {
      const a = this.pending[i];
      const b = this.pending[i + 1];
      const c = this.pending[i + 2];
      if (a === 0 && b === 0 && c === 1) {
        const codeLen = i > 0 && this.pending[i - 1] === 0 ? 4 : 3;
        const codeStart = i + 3 - codeLen;
        if (cursor < codeStart) {
          out.push(this.pending.slice(cursor, codeStart));
        }
        cursor = codeStart + codeLen;
        i = cursor;
        continue;
      }
      i++;
    }
    const tail = this.pending.slice(cursor);
    if (segmentEnd) {
      if (cursor < n)
        out.push(tail);
      this.pending = new Uint8Array(0);
      return out;
    }
    this.pending = tail;
    return out;
  }
}

// src/stream/client/decoder.ts
var defaultChunkFactory = (init) => {
  const Ctor = globalThis.EncodedVideoChunk;
  if (Ctor)
    return new Ctor(init);
  return { type: init.type, timestamp: init.timestamp, data: init.data };
};
var frameFree = (frame) => {
  const f = frame;
  if (f && typeof f.close === "function" && !f.closed) {
    try {
      f.close();
    } catch {}
  }
};

class DecoderSession {
  decoder;
  canvas;
  onFirstFrame;
  chunk;
  pts = 0;
  configured = false;
  firstDelivered = false;
  constructor(deps) {
    this.decoder = deps.decoder;
    this.canvas = deps.canvas ?? null;
    this.onFirstFrame = deps.onFirstFrame ?? null;
    this.chunk = deps.chunkFactory ?? defaultChunkFactory;
    this.decoder.onoutput = (frame) => this.draw(frame);
    this.decoder.onerror = (e) => {
      deps.onError?.(e?.message ?? "decoder error");
    };
  }
  async configure(hs) {
    const sps = decodeB64(hs.sps);
    const pps = decodeB64(hs.pps);
    const desc = new Uint8Array(4 + sps.length + 4 + pps.length);
    desc.set([0, 0, 0, 1], 0);
    desc.set(sps, 4);
    desc.set([0, 0, 0, 1], 4 + sps.length);
    desc.set(pps, 4 + sps.length + 4);
    this.decoder.configure({
      codec: avc1Codec(sps),
      codedWidth: hs.width,
      codedHeight: hs.height,
      description: desc,
      optimizeForLatency: true
    });
    this.configured = true;
  }
  decode(nal) {
    if (!this.configured)
      return;
    this.pts += 1;
    const data = new Uint8Array(4 + nal.data.length);
    data.set([0, 0, 0, 1], 0);
    data.set(nal.data, 4);
    this.decoder.decode(this.chunk({
      type: nal.type === "idr" ? "key" : "delta",
      timestamp: this.pts * 1000,
      data
    }));
  }
  async close() {
    if (this.decoder.state === "closed") {
      this.configured = false;
      return;
    }
    if (this.configured) {
      try {
        await this.decoder.flush();
      } catch {}
    }
    this.decoder.close();
    this.configured = false;
  }
  draw(frame) {
    if (!this.firstDelivered) {
      this.firstDelivered = true;
      try {
        this.onFirstFrame?.();
      } catch {}
    }
    const raw = this.canvas?.getContext("2d");
    const ctx = typeof raw === "object" && raw !== null ? raw : null;
    if (this.canvas && ctx && typeof ctx.drawImage === "function") {
      try {
        ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
      } catch {}
    }
    frameFree(frame);
  }
}
function avc1Codec(sps) {
  const p = sps[1] ?? 0;
  const c = sps[2] ?? 0;
  const l = sps[3] ?? 0;
  return `avc1.${hex2(p)}${hex2(c)}${hex2(l)}`;
}
function decodeB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0;i < bin.length; i++)
    out[i] = bin.charCodeAt(i);
  return out;
}
function hex2(n) {
  return n.toString(16).padStart(2, "0");
}

// src/stream/client/support.ts
function isStreamSupported() {
  const g = globalThis;
  if (typeof g.VideoDecoder !== "function")
    return false;
  const Ctor = g.VideoDecoder;
  try {
    const probe = new Ctor({ output: () => {}, error: () => {} });
    probe?.close?.();
    return true;
  } catch {
    return false;
  }
}

// src/stream/client/index.ts
var defaultSocketFactory = (url) => new WebSocket(url);
function toBytes(data) {
  if (data instanceof Uint8Array)
    return data;
  if (data instanceof ArrayBuffer)
    return new Uint8Array(data);
  return null;
}
function createStreamClient(opts) {
  const deps = opts.deps ?? {};
  const videoUrl = opts.url;
  const controlUrl = videoUrl.replace(/\/video$/, "/control");
  const videoSock = (deps.createVideoSocket ?? defaultSocketFactory)(videoUrl);
  const controlSock = (deps.createControlSocket ?? defaultSocketFactory)(controlUrl);
  const splitter = new AnnexBSplitter;
  const status = (s) => opts.onStatus(s);
  let session = null;
  let controlOpen = false;
  let closed = false;
  let started = false;
  let onMessage;
  const size = { current: null };
  const onVideoJson = (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object")
      return;
    const m = msg;
    if (m.type === "handshake") {
      const hs = m;
      if (hs.codec !== "h264") {
        status({ phase: "error", message: `unsupported codec: ${String(hs.codec)}` });
        return;
      }
      size.current = { width: hs.width, height: hs.height };
      session?.configure(hs).then(() => status({ phase: "handshake" })).catch((e) => status({ phase: "error", message: e instanceof Error ? e.message : "decoder configure failed" }));
      return;
    }
    if (m.type === "state") {
      const st = m;
      onMessage?.(st);
      if (st.state === "error") {
        status({ phase: "error", message: st.reason ?? "stream error" });
      }
    }
  };
  const onVideoBinary = (data) => {
    const bytes = toBytes(data);
    if (!bytes)
      return;
    splitter.push(bytes);
    for (const nal of splitter.drain(true)) {
      session?.decode({ type: classifyNal(nal), data: nal });
    }
  };
  const onControlJson = (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    onMessage?.(msg);
  };
  const api = {
    open() {
      if (closed || started)
        return Promise.resolve();
      started = true;
      const supported = deps.support ? deps.support() : isStreamSupported();
      if (!supported) {
        status({
          phase: "error",
          message: "WebCodecs H.264 decode unsupported in this browser — use the polling fallback"
        });
        return Promise.resolve();
      }
      status({ phase: "connecting" });
      try {
        const decoder = deps.decoder ?? new globalThis.VideoDecoder({
          output: () => {},
          error: () => {}
        });
        session = new DecoderSession({
          decoder,
          canvas: opts.canvas,
          onFirstFrame: () => status({ phase: "streaming" }),
          onError: (message) => status({ phase: "error", message })
        });
      } catch {
        status({ phase: "error", message: "VideoDecoder unavailable — use the polling fallback" });
        return Promise.resolve();
      }
      videoSock.binaryType = "arraybuffer";
      videoSock.onopen = () => {};
      videoSock.onmessage = (ev) => {
        const d = ev.data;
        if (typeof d === "string")
          onVideoJson(d);
        else
          onVideoBinary(d);
      };
      videoSock.onclose = (ev) => {
        if (!closed) {
          status({ phase: "closed", ...ev?.code !== undefined ? { code: ev.code } : {} });
        }
        controlOpen = false;
      };
      videoSock.onerror = () => {
        if (!closed)
          status({ phase: "error", message: "video socket error" });
      };
      controlSock.onopen = () => {
        controlOpen = true;
      };
      controlSock.onmessage = (ev) => {
        const d = ev.data;
        if (typeof d === "string")
          onControlJson(d);
      };
      controlSock.onclose = () => {
        controlOpen = false;
      };
      controlSock.onerror = () => {
        controlOpen = false;
      };
      return Promise.resolve();
    },
    close() {
      if (closed)
        return;
      closed = true;
      controlSock.close();
      videoSock.close();
      session?.close().catch(() => {});
      status({ phase: "closed" });
    },
    sendInput(event) {
      if (closed || !controlOpen)
        return false;
      controlSock.send(JSON.stringify(event));
      return true;
    },
    get videoSize() {
      return size.current;
    },
    get onMessage() {
      return onMessage;
    },
    set onMessage(fn) {
      onMessage = fn;
    }
  };
  return api;
}
export {
  isStreamSupported,
  createStreamClient
};
