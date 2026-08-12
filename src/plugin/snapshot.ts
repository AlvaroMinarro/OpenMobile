/**
 * Pure snapshot building for the OpenCode feedback-loop plugin (SDD Phase 5,
 * decision D4). Kept side-effect free so it is unit-testable.
 *
 * Snapshot source is the local bridge `GET /v1/state` (NOT MCP tools — the
 * plugin has no MCP client wiring and the spec forbids it).
 */

/** Compact `/v1/state` shape the plugin consumes (subset of the bridge contract). */
export interface BridgeState {
  schema?: string;
  selected: { serial: string; state: string; model?: string } | null;
  devices: Array<{ serial: string; state: string; model?: string }>;
  emulators?: Array<{ name: string; running?: boolean }>;
  frame?: {
    width?: number;
    height?: number;
    elementCount?: number;
    changedCount?: number;
    layoutAt?: string;
  } | null;
}

/** A device is usable only if one is explicitly selected AND in state `device`. */
export function hasUsableDevice(state: BridgeState): boolean {
  return state.selected !== null && state.selected.state === "device";
}

/**
 * Build a compact, context-friendly snapshot. Returns `null` when there is no
 * usable device so the loop can skip the push entirely. Prefers the compact
 * summary (never full dumps) to guard against context bloat.
 */
export function buildSnapshot(state: BridgeState): string | null {
  if (!hasUsableDevice(state)) return null;
  const sel = state.selected!;
  const lines: string[] = [`device: ${sel.serial} (${sel.state})`];
  if (sel.model) lines.push(`model: ${sel.model}`);
  if (state.emulators && state.emulators.length > 0) {
    lines.push(
      `emulators: ${state.emulators
        .map((e) => `${e.name}${e.running ? " running" : ""}`)
        .join(", ")}`,
    );
  }
  const f = state.frame;
  if (f) {
    if (f.width != null && f.height != null) {
      lines.push(`screen: ${f.width}x${f.height}`);
    }
    if (f.elementCount != null) {
      lines.push(
        `ui elements: ${f.elementCount}${f.changedCount != null ? ` (${f.changedCount} changed)` : ""}`,
      );
    }
    if (f.layoutAt) lines.push(`layout at: ${f.layoutAt}`);
  }
  return lines.join("\n");
}

/** Stable SHA-256 hex digest used for content-hash dedupe of snapshots. */
export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
