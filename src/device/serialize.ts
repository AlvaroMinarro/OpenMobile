import type { Bounds, Point, UIElement } from "./types";

/**
 * Serialization helpers for the device core: UIElement→JSON, CLI diff-shape
 * detection, and the uiautomator XML→tree fallback parser.
 */

export type DiffShape = "diff" | "full" | "unknown";

/** Classify a CLI layout payload as a diff object, a full tree, or unrecognized. */
export function detectDiffShape(obj: unknown): DiffShape {
  if (Array.isArray(obj)) {
    // Real `android layout` emits a FLAT JSON ARRAY of elements (string
    // centers, sparse keys). Presence alone means a full tree.
    if (obj.length === 0) return "unknown";
    return obj.some((el) => typeof el === "object" && el !== null) ? "full" : "unknown";
  }
  if (obj === null || typeof obj !== "object") return "unknown";
  const record = obj as Record<string, unknown>;
  if (Array.isArray(record["added"]) || Array.isArray(record["modified"])) return "diff";
  // Real elements carry bounds and/or center; sparse JSON has NO offScreen/state
  // keys, so the old offScreen-based check would misclassify real output.
  if ("bounds" in record || "center" in record) return "full";
  return "unknown";
}

/** Serialize a UIElement into a JSON-safe plain object. */
export function uiElementToJson(el: UIElement): Record<string, unknown> {
  return {
    bounds: el.bounds,
    center: el.center,
    interactions: el.interactions,
    state: el.state,
    offScreen: el.offScreen,
    ...(el.text !== undefined ? { text: el.text } : {}),
    ...(el.resourceId !== undefined ? { resourceId: el.resourceId } : {}),
    ...(el.contentDesc !== undefined ? { contentDesc: el.contentDesc } : {}),
    ...(el.targetable !== undefined ? { targetable: el.targetable } : {}),
    ...(el.children !== undefined ? { children: el.children.map(uiElementToJson) } : {}),
  };
}

/** Parse the recorded string bounds format `"[left,top][right,bottom]"`. */
export function parseBounds(raw: string): Bounds {
  // Format: "[left,top][right,bottom]"
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(raw);
  if (!m) return { left: 0, top: 0, right: 0, bottom: 0 };
  return {
    left: Number(m[1]),
    top: Number(m[2]),
    right: Number(m[3]),
    bottom: Number(m[4]),
  };
}

function centerOf(bounds: Bounds): Point {
  return {
    x: Math.round((bounds.left + bounds.right) / 2),
    y: Math.round((bounds.top + bounds.bottom) / 2),
  };
}

function attr(raw: string, name: string): string {
  const m = new RegExp(`${name}="([^"]*)"`).exec(raw);
  return m ? (m[1] as string) : "";
}

function parseNodeAttrs(attrsRaw: string): UIElement {
  const bounds = parseBounds(attr(attrsRaw, "bounds"));
  const clickable = attr(attrsRaw, "clickable") === "true";
  const longClickable = attr(attrsRaw, "long-clickable") === "true";
  const scrollable = attr(attrsRaw, "scrollable") === "true";
  const checkable = attr(attrsRaw, "checkable") === "true";
  const focused = attr(attrsRaw, "focused") === "true";
  const selected = attr(attrsRaw, "selected") === "true";

  const interactions: string[] = [];
  if (clickable) interactions.push("click");
  if (longClickable) interactions.push("long-click");
  if (scrollable) interactions.push("scroll");
  if (checkable) interactions.push("check");
  if (focused) interactions.push("focus");
  if (selected) interactions.push("selected");

  const text = attr(attrsRaw, "text");

  return {
    bounds,
    center: centerOf(bounds),
    interactions,
    state: focused ? "focused" : selected ? "selected" : "default",
    offScreen: attr(attrsRaw, "displayed") === "false",
    ...(text ? { text } : {}),
  };
}

/**
 * Parse a uiautomator `<hierarchy>` dump into a UIElement tree. Used as the
 * fallback when the `android` CLI returns an empty tree (e.g. WebView).
 */
export function xmlToTree(xml: string): UIElement[] {
  const roots: UIElement[] = [];
  const stack: UIElement[] = [];
  // Capture opening tag, attributes, and a trailing self-closing slash per node.
  // Self-closing nodes (`<node .../>`) are leaves: they never occupy the stack.
  const tagRe = /<(\/?node)([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const name = m[1] as string;
    const attrsRaw = m[2] as string;
    const selfClosing = m[3] === "/";
    if (name === "node") {
      const el = parseNodeAttrs(attrsRaw);
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.children ??= [];
        parent.children.push(el);
      } else {
        roots.push(el);
      }
      if (!selfClosing) stack.push(el);
    } else {
      stack.pop();
    }
  }
  return roots;
}
