import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DeviceContext } from "./context";
import type { ToolResult } from "./handlers";
import * as h from "./handlers";
import * as s from "./schemas";

/**
 * Register all MCP tools on the given server. Each tool routes through the
 * shared `src/device/` core via a single `DeviceContext`. The callbacks wrap
 * the pure handlers so the SDK's validated args are passed straight through.
 */
export function registerTools(server: McpServer, ctx: DeviceContext): void {
  const wrap = (fn: (ctx: DeviceContext, args: any) => Promise<ToolResult>) => {
    return async (args: any) => fn(ctx, args ?? {});
  };

  server.registerTool("list_devices", {
    description:
      "List attached Android devices with connection state and model, available AVDs, and the detected `android` CLI version. Use this first to see what is connected and to pick a serial.",
    inputSchema: s.listDevicesSchema,
  }, wrap(h.listDevices) as any);

  server.registerTool("get_device_info", {
    description:
      "Return SDK level, screen-facing metadata and model for the selected device (explicit serial > ANDROID_DEVICE > single device).",
    inputSchema: s.getDeviceInfoSchema,
  }, wrap(h.getDeviceInfo) as any);

  server.registerTool("emulator_list", {
    description: "List every AVD with a running flag.",
    inputSchema: s.emulatorListSchema,
  }, wrap(h.emulatorList) as any);

  server.registerTool("emulator_start", {
    description:
      "Start an AVD (defaults to the single available one) and wait until adb reports state 'device' or an outer timeout elapses.",
    inputSchema: s.emulatorStartSchema,
  }, wrap(h.emulatorStart) as any);

  server.registerTool("emulator_stop", {
    description: "Stop an AVD by name; succeeds only once it is no longer running.",
    inputSchema: s.emulatorStopSchema,
  }, wrap(h.emulatorStop) as any);

  server.registerTool("emulator_create", {
    description: "Create an AVD from a locally available system image. Duplicate names are rejected.",
    inputSchema: s.emulatorCreateSchema,
  }, wrap(h.emulatorCreate) as any);

  server.registerTool("deploy_app", {
    description: "Install an APK on the selected device (preferring `android` CLI delta install); optionally launch an activity after install.",
    inputSchema: s.deployAppSchema,
  }, wrap(h.deployApp) as any);

  server.registerTool("get_ui_tree", {
    description: "Return the device UI hierarchy as structured JSON (bounds, centers, interaction affordances). CLI-first with uiautomator XML fallback on empty result.",
    inputSchema: s.getUiTreeSchema,
  }, wrap(h.getUiTree) as any);

  server.registerTool("get_ui_tree_diff", {
    description:
      "Return only changed UI elements via `layout --diff`. The first call in the process establishes the baseline and returns the full tree labeled {baseline:'set'}; later calls return only added/modified elements. A server restart re-establishes the baseline.",
    inputSchema: s.getUiTreeDiffSchema,
  }, wrap(h.getUiTreeDiff) as any);

  server.registerTool("take_screenshot", {
    description: "Capture the current screen as a PNG image. Prefer the `android` CLI capture, falling back to screencap.",
    inputSchema: s.takeScreenshotSchema,
  }, wrap(h.takeScreenshot) as any);

  server.registerTool("get_annotated_screen", {
    description: "Capture the current screen as an annotated PNG with #N overlays. Supply the screenshot path to resolve_screen_labels for tappable coordinates.",
    inputSchema: s.getAnnotatedScreenSchema,
  }, wrap(h.getAnnotatedScreen) as any);

  server.registerTool("resolve_screen_labels", {
    description: "Resolve one or more #N labels from an annotated screenshot to their center coordinates. Unknown labels produce an actionable error.",
    inputSchema: s.resolveScreenLabelsSchema,
  }, wrap(h.resolveScreenLabels) as any);

  server.registerTool("read_logcat", {
    description: "Read device logcat lines filtered by priority (default *:E), bounded to the last N lines with a truncation note.",
    inputSchema: s.readLogcatSchema,
  }, wrap(h.readLogcat) as any);

  server.registerTool("tap", {
    description: "Inject a tap at integer (x, y) on the selected device. Retries once on transient adb latency.",
    inputSchema: s.tapSchema,
  }, wrap(h.tap) as any);

  server.registerTool("swipe", {
    description: "Inject a swipe from (x1,y1) to (x2,y2) with an optional duration in milliseconds.",
    inputSchema: s.swipeSchema,
  }, wrap(h.swipe) as any);

  server.registerTool("input_text", {
    description: "Type ASCII text via the adb input channel (spaces become %s). Uninjectable characters produce an actionable error.",
    inputSchema: s.inputTextSchema,
  }, wrap(h.inputText) as any);

  server.registerTool("press_key", {
    description: "Inject a key event by name (back, home, menu, enter, app_switch, ...).",
    inputSchema: s.pressKeySchema,
  }, wrap(h.pressKey) as any);
}

export { z };
