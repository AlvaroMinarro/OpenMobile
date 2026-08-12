/**
 * @openmobile/android-device-bridge — package entrypoint.
 *
 * Re-exports the shared `src/device/` core so both the MCP server and the
 * bridge daemon consume the same device-control layer. The device core is the
 * current slice; MCP tools, bridge, and plugin land in later slices.
 */

export const PACKAGE_VERSION = "0.1.0";
