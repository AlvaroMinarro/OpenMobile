/**
 * Stream support detection for the browser client (task 3.3, D7).
 *
 * `isStreamSupported()` is the browser-side half of the fallback contract:
 *  - the server reports `stream.supported` (bridge capability) on /v1/state,
 *  - THIS function reports whether the CURRENT BROWSER can decode the H.264
 *    stream with WebCodecs. Firefox (no stable VideoDecoder) and platforms
 *    without an H.264 codec return false → the caller falls back to the
 *    polling path (REST /v1/screenshot driven surface).
 *
 * The check is deliberately SYNC and best-effort (the caller must branch
 * before opening the stream, and `VideoDecoder.isConfigSupported` is async):
 * presence of the constructor + a throw-free probe construction. A browser
 * that passes this but later fails to configure surfaces a decoder error
 * through the client's onStatus, which the caller can also treat as a
 * polling fallback trigger.
 *
 * Browser-only: no Bun/node APIs.
 */

/**
 * True when the platform exposes a usable VideoDecoder for H.264 decoding.
 */
export function isStreamSupported(): boolean {
  const g = globalThis as { VideoDecoder?: unknown };
  if (typeof g.VideoDecoder !== "function") return false;
  const Ctor = g.VideoDecoder as new (init: object) => { close?: () => void };
  try {
    // WebCodecs requires the output/error callbacks at construction; a
    // throw here means the platform can't build a decoder at all.
    const probe = new Ctor({ output: () => {}, error: () => {} });
    probe?.close?.();
    return true;
  } catch {
    return false;
  }
}