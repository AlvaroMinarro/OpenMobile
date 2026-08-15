import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { MemoryRunner } from "./helpers/memoryRunner";
import {
  JAR_LOCAL_PATH,
  buildSpawnCmd,
  pushServer,
  reverseSocket,
  removeReverse,
  spawnServer,
  teardown,
} from "../src/stream/scrcpy";

const SERIAL = "emulator-5554";
const SCID = "12345678";

describe("scrcpy adapter — adb orchestration (design §Live-validated facts)", () => {
  it("builds the live-validated app_process spawn command (CLASSPATH separate shell word, version 4.1, tunnel_forward=false)", () => {
    const cmd = buildSpawnCmd(SCID);
    // The whole command is ONE argv passed to `adb shell`, with the
    // CLASSPATH prefix as its own word before app_process.
    expect(cmd.startsWith("CLASSPATH=/data/local/tmp/scrcpy-server.jar /system/bin/app_process")).toBe(true);
    expect(cmd).toContain("com.genymobile.scrcpy.Server 4.1");
    expect(cmd).toContain(`scid=${SCID}`);
    expect(cmd).toContain("video=true audio=false");
    expect(cmd).toContain("send_dummy_byte=true");
    expect(cmd).toContain("send_device_meta=true");
    expect(cmd).toContain("send_stream_meta=true");
    expect(cmd).toContain("send_frame_meta=true");
    expect(cmd).toContain("tunnel_forward=false");
    expect(cmd).toContain("max_size=960");
    expect(cmd).toContain("log_level=info");
    // v4.1 has no raw_stream flag — the raw protocol is the only mode.
    expect(cmd).not.toContain("raw_stream");
  });

  it("pushes the bundled jar to /data/local/tmp (RE-push every start — server self-deletes)", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", SERIAL, "push", JAR_LOCAL_PATH, "/data/local/tmp/scrcpy-server.jar"], {
      stdout: "1 file pushed",
    });
    await pushServer(runner, SERIAL);
    runner.assertSatisfied();
  });

  it("sets the reverse localabstract socket (device connects OUT to the daemon listener)", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", SERIAL, "reverse", `localabstract:scrcpy_${SCID}`, "tcp:47832"], {
      stdout: "",
    });
    await reverseSocket(runner, SERIAL, SCID, 47832);
    runner.assertSatisfied();
  });

  it("removes the reverse mapping on teardown", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", SERIAL, "reverse", "--remove-all"], { stdout: "" });
    await removeReverse(runner, SERIAL);
    runner.assertSatisfied();
  });

  it("spawns the server via `adb shell` with the app_process command as ONE argv", async () => {
    const runner = new MemoryRunner();
    const cmd = buildSpawnCmd(SCID);
    runner.expect(["adb", "-s", SERIAL, "shell", cmd], { stdout: "" });
    await spawnServer(runner, SERIAL, SCID);
    runner.assertSatisfied();
  });

  it("teardown removes the reverse mapping + device-side jar in order", async () => {
    const runner = new MemoryRunner();
    runner.expect(["adb", "-s", SERIAL, "reverse", "--remove-all"], { stdout: "" });
    runner.expect(["adb", "-s", SERIAL, "shell", "rm", "-f", "/data/local/tmp/scrcpy-server.jar"], { stdout: "" });
    await teardown(runner, SERIAL);
    runner.assertSatisfied();
  });
});