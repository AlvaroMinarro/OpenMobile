import { randomUUID } from "node:crypto";

/**
 * Unique temporary PNG path naming (design D7).
 *
 * Every capture temp file MUST use a unique name — never a fixed path — so
 * concurrent or same-millisecond captures cannot collide and overwrite each
 * other. The name embeds the capture kind, the target serial, a timestamp, and
 * 6 hex chars from a UUID: `/tmp/om-<kind>-<serial>-<ts>-<rand6>.png`.
 */
export function tempPngPath(kind: string, serial: string): string {
  const rand6 = randomUUID().replace(/-/g, "").slice(0, 6);
  return `/tmp/om-${kind}-${serial}-${Date.now()}-${rand6}.png`;
}