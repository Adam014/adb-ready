import { describe, expect, test } from "bun:test";
import { AdbClient } from "../../src/adb/client.js";
import { EventBus } from "../../src/core/event-bus.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../../src/platform/process-runner.js";

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    executable: "/sdk/platform-tools/adb",
    args: [],
    startedAt: "2026-09-09T10:00:00.000Z",
    finishedAt: "2026-09-09T10:00:00.010Z",
    durationMs: 10,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    ...overrides,
  };
}

describe("AdbClient", () => {
  test("passes remote server options as direct argv and parses devices", async () => {
    const requests: ProcessRequest[] = [];
    const runner: ProcessRunner = async (request) => {
      requests.push(request);
      return processResult({
        args: [...(request.args ?? [])],
        stdout:
          "List of devices attached\n" +
          "emulator-5554 device product:sdk model:Android_SDK device:emu transport_id:1\n",
      });
    };
    const bus = new EventBus(() => new Date("2026-09-09T10:00:00.000Z"));
    const events: string[] = [];
    bus.subscribe((event) => events.push(event.type));
    const client = new AdbClient({
      executable: "/sdk/platform-tools/adb",
      host: "127.0.0.1",
      port: 5038,
      bus,
      correlation: { commandId: "command-1" },
      runner,
      idFactory: () => "operation-1",
    });

    const observation = await client.devices();

    expect(requests[0]?.args).toEqual(["-H", "127.0.0.1", "-P", "5038", "devices", "-l"]);
    expect(observation.value).toHaveLength(1);
    expect(observation.value[0]).toMatchObject({
      serial: "emulator-5554",
      state: "device",
      model: "Android SDK",
    });
    expect(events).toEqual(["operation.started", "operation.completed"]);
  });

  test("keeps client version independent from a configured remote server", async () => {
    const requests: ProcessRequest[] = [];
    const runner: ProcessRunner = async (request) => {
      requests.push(request);
      return processResult({
        args: [...(request.args ?? [])],
        stdout: "Android Debug Bridge version 1.0.41\nVersion 37.0.0\n",
      });
    };
    const client = new AdbClient({
      executable: "adb",
      host: "remote.example",
      port: 5037,
      bus: new EventBus(),
      correlation: { commandId: "command-1" },
      runner,
      idFactory: () => "operation-1",
    });

    const observation = await client.version();

    expect(requests[0]?.args).toEqual(["version"]);
    expect(observation.value.platformToolsVersion).toBe("37.0.0");
  });

  test("emits a failed event and retains raw process evidence", async () => {
    const runner: ProcessRunner = async () =>
      processResult({ exitCode: 1, stderr: "cannot connect to daemon" });
    const bus = new EventBus(() => new Date("2026-09-09T10:00:00.000Z"));
    const events: Array<{ type: string; data: unknown }> = [];
    bus.subscribe((event) => events.push({ type: event.type, data: event.data }));
    const client = new AdbClient({
      executable: "adb",
      bus,
      correlation: { commandId: "command-1" },
      runner,
      idFactory: () => "operation-1",
    });

    const observation = await client.devices();

    expect(observation.process.stderr).toBe("cannot connect to daemon");
    expect(events.map((event) => event.type)).toEqual(["operation.started", "operation.failed"]);
    expect(events[1]?.data).toMatchObject({ exitCode: 1, timedOut: false });
  });

  test("does not report an aborted process as completed even if it exits zero", async () => {
    const runner: ProcessRunner = async () => processResult({ exitCode: 0, aborted: true });
    const bus = new EventBus(() => new Date("2026-09-09T10:00:00.000Z"));
    const events: string[] = [];
    bus.subscribe((event) => events.push(event.type));
    const client = new AdbClient({
      executable: "adb",
      bus,
      correlation: { commandId: "command-1" },
      runner,
      idFactory: () => "operation-1",
    });

    await client.devices();

    expect(events).toEqual(["operation.started", "operation.failed"]);
  });

  test("passes pairing codes over stdin and never exposes them in event arguments", async () => {
    const requests: ProcessRequest[] = [];
    const bus = new EventBus(() => new Date("2026-09-09T10:00:00.000Z"));
    const events: unknown[] = [];
    bus.subscribe((event) => events.push(event));
    const runner: ProcessRunner = async (request) => {
      requests.push(request);
      return processResult({
        args: [...(request.args ?? [])],
        stdout: "Enter pairing code: Successfully paired to 192.168.1.8:37123\n",
      });
    };
    const client = new AdbClient({
      executable: "adb",
      bus,
      correlation: { commandId: "command-1" },
      runner,
      idFactory: () => "operation-1",
    });

    const observation = await client.pair("192.168.1.8:37123", "739201");

    expect(requests[0]?.args).toEqual(["pair", "192.168.1.8:37123"]);
    expect(requests[0]?.input).toBe("739201\n");
    expect(observation.value).toMatchObject({ paired: true, endpoint: "192.168.1.8:37123" });
    expect(JSON.stringify(events)).not.toContain("739201");
    expect(JSON.stringify(observation.process)).not.toContain("739201");
  });

  test("uses explicit target arguments for state and identity probes", async () => {
    const requests: ProcessRequest[] = [];
    const runner: ProcessRunner = async (request) => {
      requests.push(request);
      return processResult({ args: [...(request.args ?? [])], stdout: "R5CT-001\n" });
    };
    const client = new AdbClient({
      executable: "adb",
      host: "remote.example",
      port: 5037,
      bus: new EventBus(),
      correlation: { commandId: "command-1" },
      runner,
      idFactory: () => "operation-1",
    });

    await client.getHardwareSerial("192.168.1.8:37123");
    await client.getState("192.168.1.8:37123");

    expect(requests.map(({ args }) => args)).toEqual([
      [
        "-H",
        "remote.example",
        "-P",
        "5037",
        "-s",
        "192.168.1.8:37123",
        "shell",
        "getprop",
        "ro.serialno",
      ],
      ["-H", "remote.example", "-P", "5037", "-s", "192.168.1.8:37123", "get-state"],
    ]);
  });
});
