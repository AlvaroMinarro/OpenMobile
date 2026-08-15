/** Shared types for the `src/device/` core. */

export type DeviceState = "device" | "unauthorized" | "offline";

export interface Device {
  serial: string;
  state: DeviceState;
  model?: string;
}

export interface AVD {
  name: string;
  running: boolean;
  /** `emulator-\d+` serial; present only while the AVD is Online (real `emulator list --long`). */
  serial?: string;
}

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface UIElement {
  bounds: Bounds;
  center: Point;
  interactions: string[];
  state: string;
  offScreen: boolean;
  text?: string;
  /** Original `resource-id` from the CLI layout (sparse: present only when emitted). */
  resourceId?: string;
  /** Original `content-desc` from the CLI layout (sparse: present only when emitted). */
  contentDesc?: string;
  /**
   * Whether the element is a safe tap target. Explicitly `false` when the CLI
   * emitted coordinates that cannot be parsed — NEVER silently tappable at (0,0).
   */
  targetable?: boolean;
  children?: UIElement[];
}

export type LayoutDiffResult =
  | { shape: "diff"; added: UIElement[]; modified: UIElement[] }
  | { shape: "full"; tree: UIElement[] };

export interface LogcatResult {
  lines: string[];
  truncated: boolean;
}
