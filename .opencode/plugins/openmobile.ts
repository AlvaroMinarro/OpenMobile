/**
 * Local OpenCode plugin sample for the OpenMobile feedback loop.
 *
 * This file exists so a contributor can run the plugin WITHOUT publishing the
 * package. Instead of resolving the (not-yet-published) package export
 * `@openmobile/android-device-bridge/plugin`, it re-exports the plugin straight
 * from this repo's TypeScript source via a relative import. Point `opencode.json`
 * at this file and OpenCode loads it directly.
 *
 * Usage:
 *   {
 *     "plugin": [{ "id": "openmobile", "path": "./.opencode/plugins/openmobile.ts" }]
 *   }
 *
 * It consumes the same OPENMOBILE_BRIDGE_PORT / OPENMOBILE_BRIDGE_SECRET env
 * knobs as the bridge daemon (see src/bridge/main.ts).
 */
import openmobilePlugin from "../../src/plugin/index";

export default openmobilePlugin;
