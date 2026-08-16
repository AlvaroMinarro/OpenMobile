/**
 * scrcpy server adapter: push / reverse / spawn / teardown (design D1, D5).
 *
 * The spawn command shape here is LIVE-validated against the bundled
 * scrcpy-server v4.1 jar on emulator-5554 (see design §Live-validated facts):
 *
 *   adb -s <serial> shell "CLASSPATH=/data/local/tmp/scrcpy-server.jar
 *     /system/bin/app_process / com.genymobile.scrcpy.Server 4.1
 *     scid=<hex> log_level=info video=true audio=false control=true
 *     send_dummy_byte=true send_device_meta=true send_stream_meta=true
 *     send_frame_meta=true tunnel_forward=false max_size=960
 *     video_bit_rate=8000000 max_fps=30"
 *
 * Requirements that MUST stay true:
 *  - `CLASSPATH=...` is a separate shell word BEFORE `app_process`.
 *  - The version string "4.1" is required by the server's Options parser.
 *  - `tunnel_forward=false` → the DEVICE connects OUT to the abstract socket
 *    reversed to a local TCP port where the daemon LISTENS (conn1=video,
 *    conn2=control).
 *  - The server's CleanUp self-deletes the pushed jar once streaming starts,
 *    so pushServer() runs before EVERY spawn.
 */

import { join } from "node:path";
import type { CommandRunner } from "../device/runner";
import { JAR_DEVICE_PATH, SCRCPY_VERSION } from "./types";

/** Repo path of the bundled jar (design D1). */
export const JAR_LOCAL_PATH = join(import.meta.dir, "..", "..", "assets", "scrcpy-server.jar");

/** Reverse path prefix: abstract socket the DEVICE connects to. */
export function abstractSocket(scid: string): string {
  return `localabstract:scrcpy_${scid}`;
}

/** Build the full `adb shell` command (ONE argv) for the app_process spawn. */
export function buildSpawnCmd(scid: string): string {
  return [
    `CLASSPATH=${JAR_DEVICE_PATH}`,
    "/system/bin/app_process",
    "/",
    "com.genymobile.scrcpy.Server",
    SCRCPY_VERSION,
    `scid=${scid}`,
    "log_level=info",
    "video=true",
    "audio=false",
    "control=true",
    "send_dummy_byte=true",
    "send_device_meta=true",
    "send_stream_meta=true",
    "send_frame_meta=true",
    "tunnel_forward=false",
    "max_size=960",
    "video_bit_rate=8000000",
    "max_fps=30",
  ].join(" ");
}

/** `adb push` the bundled jar (RE-push before every start — server CleanUp self-deletes). */
export async function pushServer(runner: CommandRunner, serial: string): Promise<void> {
  const { stderr, exitCode } = await runner.run(["adb", "-s", serial, "push", JAR_LOCAL_PATH, JAR_DEVICE_PATH]);
  if (exitCode !== 0) throw new Error(`scrcpy push failed: ${stderr}`);
}

/** `adb reverse localabstract:scrcpy_<scid> tcp:<port>` (daemon LISTENS, device CONNECTS). */
export async function reverseSocket(
  runner: CommandRunner,
  serial: string,
  scid: string,
  port: number,
): Promise<void> {
  const { stderr, exitCode } = await runner.run([
    "adb",
    "-s",
    serial,
    "reverse",
    abstractSocket(scid),
    `tcp:${port}`,
  ]);
  if (exitCode !== 0) throw new Error(`scrcpy reverse failed: ${stderr}`);
}

/** `adb reverse --remove-all` — called on session teardown. */
export async function removeReverse(runner: CommandRunner, serial: string): Promise<void> {
  const { stderr, exitCode } = await runner.run(["adb", "-s", serial, "reverse", "--remove-all"]);
  if (exitCode !== 0) throw new Error(`scrcpy reverse cleanup failed: ${stderr}`);
}

/**
 * Spawn the scrcpy server on the device via `adb shell`. Returns the spawned
 * adb process so the caller can kill it on teardown.
 */
export async function spawnServer(
  runner: CommandRunner,
  serial: string,
  scid: string,
): Promise<unknown> {
  const cmd = buildSpawnCmd(scid);
  const { stderr, exitCode } = await runner.run(["adb", "-s", serial, "shell", cmd]);
  if (exitCode !== 0) throw new Error(`scrcpy spawn failed: ${stderr}`);
  return undefined;
}

/** Full teardown: remove the reverse mapping + the device-side jar. */
export async function teardown(runner: CommandRunner, serial: string): Promise<void> {
  await removeReverse(runner, serial);
  const { stderr, exitCode } = await runner.run(["adb", "-s", serial, "shell", "rm", "-f", JAR_DEVICE_PATH]);
  if (exitCode !== 0) throw new Error(`scrcpy jar cleanup failed: ${stderr}`);
}