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
  children?: UIElement[];
}

export type LayoutDiffResult =
  | { shape: "diff"; added: UIElement[]; modified: UIElement[] }
  | { shape: "full"; tree: UIElement[] };

export interface LogcatResult {
  lines: string[];
  truncated: boolean;
}
