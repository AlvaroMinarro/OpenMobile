import { z } from "zod";

/**
 * Zod v4 input schemas for every MCP tool. Each tool's `inputSchema` references
 * one of these so the SDK validates arguments before the handler runs, and the
 * plugin/bridge slices can reuse the same schemas when calling these tools.
 */

const deviceOption = { device: z.string().optional().describe("Explicit device serial") };

export const listDevicesSchema = z.object({});

export const getDeviceInfoSchema = z.object({ ...deviceOption });

export const emulatorListSchema = z.object({});

export const emulatorStartSchema = z.object({
  name: z.string().optional().describe("AVD name; defaults to the single available AVD"),
  timeoutMs: z.number().int().positive().optional().describe("Outer readiness timeout (ms)"),
});

export const emulatorStopSchema = z.object({
  name: z.string().describe("AVD name or device serial to stop"),
});

export const emulatorCreateSchema = z.object({
  name: z.string().describe("New AVD name from a locally available system image"),
});

export const deployAppSchema = z.object({
  apk: z.string().describe("Path to the APK to install"),
  activity: z.string().optional().describe("Component to launch after install"),
  ...deviceOption,
});

export const getUiTreeSchema = z.object({ ...deviceOption });

export const getUiTreeDiffSchema = z.object({ ...deviceOption });

export const takeScreenshotSchema = z.object({ ...deviceOption });

export const getAnnotatedScreenSchema = z.object({ ...deviceOption });

export const resolveScreenLabelsSchema = z.object({
  screenshot: z.string().describe("Annotated screenshot path"),
  labels: z.array(z.string()).min(1).describe("One or more #N labels to resolve"),
});

export const readLogcatSchema = z.object({
  ...deviceOption,
  pid: z.number().int().positive().optional(),
  priority: z
    .enum(["V", "D", "I", "W", "E", "F", "S"])
    .optional()
    .describe("Filter to this priority (default E)"),
  tail: z.number().int().positive().optional().describe("Return at most this many lines"),
});

export const tapSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  ...deviceOption,
});

export const swipeSchema = z.object({
  x1: z.number().int(),
  y1: z.number().int(),
  x2: z.number().int(),
  y2: z.number().int(),
  durationMs: z.number().int().nonnegative().optional(),
  ...deviceOption,
});

export const inputTextSchema = z.object({
  text: z.string().describe("ASCII text to type (spaces become %s)"),
  ...deviceOption,
});

export const pressKeySchema = z.object({
  key: z.enum(["back", "home", "menu", "enter", "del", "tab", "volume_up", "volume_down", "power", "app_switch"]),
  ...deviceOption,
});
