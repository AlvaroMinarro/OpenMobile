// src/stream/client/index.ts
function hasVp8(codecs) {
  return codecs.some((c) => c.toUpperCase() === "VP8");
}
function deriveControlUrl(videoUrl) {
  return videoUrl.replace(/\/video(?=$|\?)/, "/control");
}
var WS_OPEN = 1;
var defaultSocketFactory = (url) => new WebSocket(url);
function createStreamClient(opts) {
  const deps = opts.deps ?? {};
  const makeSocket = deps.createSignalSocket ?? defaultSocketFactory;
  const makeControlSocket = deps.createControlSocket ?? makeSocket;
  const makePeerConnection = deps.createPeerConnection ?? (() => new RTCPeerConnection);
  const controlUrl = deriveControlUrl(opts.url);
  let signal = null;
  let pc = null;
  let control = null;
  let closedByUs = false;
  let finished = false;
  let handshakeSeen = false;
  let answered = false;
  let streamingSent = false;
  let info = null;
  let pendingRemoteIce = [];
  let pendingLocalIce = [];
  let resolveOpen = null;
  let rejectOpen = null;
  const openPromise = new Promise((res, rej) => {
    resolveOpen = res;
    rejectOpen = rej;
  });
  let messageListener;
  const emitMessage = (msg) => {
    messageListener?.(msg);
  };
  const status = (s) => {
    if (finished)
      return;
    if (s.phase === "error" || s.phase === "closed")
      finished = true;
    opts.onStatus?.(s);
  };
  const fail = (message) => {
    status({ phase: "error", message });
    teardownSockets();
    rejectOpen?.(new Error(message));
  };
  const teardownSockets = () => {
    pc?.close();
    pc = null;
    signal?.close();
    signal = null;
  };
  const send = (msg) => {
    try {
      signal?.send(JSON.stringify(msg));
    } catch {}
  };
  const addRemoteCandidate = (candidate) => {
    if (!pc || !answered) {
      pendingRemoteIce.push(candidate);
      return;
    }
    pc.addIceCandidate(candidate).catch(() => {});
  };
  const handleOffer = async (sdp) => {
    if (answered || !pc)
      return;
    try {
      await pc.setRemoteDescription({ type: "offer", sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "answer", sdp: pc.localDescription?.sdp ?? answer.sdp });
      answered = true;
      for (const candidate of pendingRemoteIce.splice(0)) {
        pc.addIceCandidate(candidate).catch(() => {});
      }
      resolveOpen?.();
    } catch (e) {
      fail(`answer failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const handleFrame = async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return fail("malformed signaling frame (not valid JSON)");
    }
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      return fail("signaling frame must be a JSON object");
    }
    const obj = msg;
    switch (obj.type) {
      case "handshake": {
        if (handshakeSeen)
          return fail("duplicate handshake");
        if (typeof obj.rtcId !== "string" || typeof obj.fps !== "number" || !Array.isArray(obj.codecs)) {
          return fail("handshake requires rtcId, fps and codecs");
        }
        if (!hasVp8(obj.codecs)) {
          return fail(`VP8 is mandatory but the handshake offered: ${obj.codecs.join(", ")}`);
        }
        handshakeSeen = true;
        info = { rtcId: obj.rtcId, fps: obj.fps };
        pc = pc ?? makePeerConnection();
        wirePeerConnection(pc);
        status({ phase: "handshake", rtcId: info.rtcId, fps: info.fps });
        return;
      }
      case "offer":
        if (!handshakeSeen)
          return fail("offer before handshake");
        await handleOffer(obj.sdp);
        return;
      case "answer":
        if (!handshakeSeen)
          return fail("answer before handshake");
        await pc?.setRemoteDescription({ type: "answer", sdp: obj.sdp });
        return;
      case "ice": {
        if (!handshakeSeen)
          return fail("ice before handshake");
        const candidate = obj.candidate;
        if (!candidate || typeof candidate.candidate !== "string") {
          return fail("ice frame requires an RTCIceCandidateInit candidate");
        }
        addRemoteCandidate(candidate);
        return;
      }
      case "state": {
        const state = obj.state;
        const reason = typeof obj.reason === "string" ? obj.reason : undefined;
        emitMessage({ type: "state", state, reason });
        if (state === "error")
          status({ phase: "error", message: reason ?? "stream error" });
        return;
      }
      case "error": {
        emitMessage(obj);
        return;
      }
      default:
        return fail(`unknown signaling type: ${String(obj.type)}`);
    }
  };
  const wirePeerConnection = (connection) => {
    connection.onicecandidate = (ev) => {
      if (!ev.candidate)
        return;
      if (answered) {
        send({ type: "ice", candidate: ev.candidate });
      } else {
        pendingLocalIce.push(ev.candidate);
      }
    };
    connection.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (stream !== undefined)
        opts.video.srcObject = stream;
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "connected" && !streamingSent) {
        streamingSent = true;
        send({ type: "state", state: "streaming" });
        status({ phase: "streaming" });
      } else if (connection.connectionState === "failed") {
        status({ phase: "error", message: "peer connection failed" });
      }
    };
  };
  return {
    open() {
      if (signal)
        return openPromise;
      status({ phase: "connecting" });
      signal = makeSocket(opts.url);
      signal.onmessage = (ev) => {
        const data = ev.data;
        handleFrame(typeof data === "string" ? data : String(data));
      };
      signal.onclose = (ev) => {
        if (closedByUs || finished)
          return;
        const code = typeof ev?.code === "number" ? ev.code : undefined;
        const reason = typeof ev?.reason === "string" && ev.reason !== "" ? ev.reason : undefined;
        teardownSockets();
        status({ phase: "closed", ...code !== undefined ? { code } : {}, ...reason ? { reason } : {} });
        rejectOpen?.(new Error(`signal socket closed${code !== undefined ? ` (${code})` : ""}`));
      };
      signal.onerror = () => {};
      return openPromise;
    },
    close() {
      if (closedByUs)
        return;
      closedByUs = true;
      teardownSockets();
      control?.close();
      control = null;
      status({ phase: "closed" });
      rejectOpen?.(new Error("stream closed before signaling completed"));
    },
    sendInput(event) {
      if (closedByUs)
        return false;
      if (!control || control.readyState !== WS_OPEN) {
        if (!control) {
          control = makeControlSocket(controlUrl);
          control.onmessage = (ev) => {
            const data = ev.data;
            const text = typeof data === "string" ? data : String(data);
            let parsed;
            try {
              parsed = JSON.parse(text);
            } catch {
              return;
            }
            const msg = parsed;
            if (msg.type === "ack" || msg.type === "error") {
              emitMessage(parsed);
            }
          };
          control.onclose = () => {};
          control.onerror = () => {};
        }
        return false;
      }
      try {
        control.send(JSON.stringify(event));
        return true;
      } catch {
        return false;
      }
    },
    get onMessage() {
      return messageListener;
    },
    set onMessage(fn) {
      messageListener = fn;
    },
    get info() {
      return info;
    }
  };
}
export {
  createStreamClient,
  deriveControlUrl,
  hasVp8
};
