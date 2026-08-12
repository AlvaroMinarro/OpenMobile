/**
 * @openmobile/android-device-bridge — package entrypoint.
 *
 * Re-exports the shared `src/device/` core and the MCP tool layer so the MCP
 * server, the bridge daemon, and the plugin all consume the same device-control
 * surface. The bridge and plugin slices build on these in later work units.
 */

export const PACKAGE_VERSION = "0.1.0";

export * from "./device/types";
export * from "./device/runner";
export * from "./device/serialize";
export * from "./device/selection";
export * from "./device/input";
export { AndroidCli } from "./device/androidCli";
export { AdbWrapper } from "./device/adb";
export { createContext } from "./tools/context";
export type { DeviceContext } from "./tools/context";
export { registerTools } from "./tools/index";
export * as schemas from "./tools/schemas";
export * as tools from "./tools/handlers";

