import { describe, expect, test } from "bun:test";
import { type CommandDependencies, runLogs } from "../../src/app/commands.js";
import { ExitCode } from "../../src/domain/contracts.js";
import { ProblemCode } from "../../src/domain/problems.js";
import type { ProcessRequest, ProcessResult } from "../../src/platform/process-runner.js";

function result(request: ProcessRequest, stdout = "", exitCode = 0): ProcessResult {
  return {
    executable: request.executable,
    args: [...(request.args ?? [])],
    startedAt: "2026-09-10T10:00:00.000Z",
    finishedAt: "2026-09-10T10:00:00.010Z",
    durationMs: 10,
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    stoppedAfterIdle: false,
    killEscalated: false,
  };
}

function dependencies(requests: ProcessRequest[], packagePid = "321\n"): CommandDependencies {
  let id = 0;
  return {
    locateAdb: async () => "/sdk/adb",
    idFactory: () => `id-${String(++id)}`,
    clock: () => new Date("2026-09-10T10:00:00.000Z"),
    runner: async (request) => {
      requests.push(request);
      const args = request.args ?? [];
      if (args.includes("devices")) {
        return result(
          request,
          "List of devices attached\nUSB-1 device model:Pixel_9 transport_id:7\n",
        );
      }
      if (args.includes("ro.serialno")) return result(request, "PHONE-1\n");
      if (args.includes("host-features")) return result(request, "shell_v2\n");
      if (args.includes("mdns")) return result(request, "List of discovered mdns services\n");
      if (args.includes("pidof")) return result(request, packagePid, packagePid === "" ? 1 : 0);
      if (args.includes("logcat")) {
        const output =
          "09-10 10:00:00.000  321  322 I DemoTag: ready\n" +
          "09-10 10:00:01.000  321  322 E DemoTag: token=secret-value\n";
        request.onStdoutChunk?.(new TextEncoder().encode(output));
        return result(request, output);
      }
      return result(request);
    },
  };
}

describe("runLogs", () => {
  test("fails safely across setup, selection, validation, interruption, and logcat exit", async () => {
    const missing = await runLogs({}, {}, { locateAdb: async () => undefined });
    expect(missing.result.problems[0]?.code).toBe(ProblemCode.AdbNotFound);

    const inventory = dependencies([]);
    inventory.runner = async (request) =>
      request.args?.includes("devices") ? result(request, "", 1) : result(request);
    expect((await runLogs({}, {}, inventory)).result.ok).toBeFalse();

    const noTarget = dependencies([]);
    noTarget.runner = async (request) =>
      request.args?.includes("devices")
        ? result(request, "List of devices attached\n")
        : result(request);
    expect((await runLogs({}, {}, noTarget)).exitCode).toBe(ExitCode.Target);

    for (const options of [
      { tail: 0 },
      { tail: 1, since: "09-11 10:00:00.000" },
      { maxRecords: 0 },
    ]) {
      const execution = await runLogs(options, {}, dependencies([]));
      expect(execution.result.problems.at(-1)?.code).toBe(ProblemCode.LogcatFailed);
    }

    const interruptedController = new AbortController();
    interruptedController.abort();
    const interrupted = dependencies([]);
    const interruptedBase = interrupted.runner;
    interrupted.runner = async (request) => {
      if (request.args?.includes("logcat")) {
        return {
          ...result(request),
          exitCode: null,
          signal: "SIGTERM",
          aborted: true,
        };
      }
      if (interruptedBase === undefined) throw new Error("fixture runner missing");
      return await interruptedBase(request);
    };
    expect(
      (await runLogs({}, {}, interrupted, interruptedController.signal)).result.problems.at(-1)
        ?.code,
    ).toBe(ProblemCode.OperationInterrupted);

    const failed = dependencies([]);
    const failedBase = failed.runner;
    failed.runner = async (request) => {
      if (request.args?.includes("logcat")) return result(request, "", 2);
      if (failedBase === undefined) throw new Error("fixture runner missing");
      return await failedBase(request);
    };
    expect((await runLogs({}, {}, failed)).result.problems.at(-1)?.code).toBe(
      ProblemCode.LogcatFailed,
    );
  });

  test("follows from now by default without replaying the device buffer", async () => {
    const requests: ProcessRequest[] = [];
    await runLogs({}, {}, dependencies(requests));

    const logcat = requests.find(({ args }) => args?.includes("logcat"));
    const start = logcat?.args?.indexOf("-T") ?? -1;
    expect(start).toBeGreaterThan(-1);
    expect(logcat?.args?.[start + 1]).toBe("1");
    expect(logcat?.args).not.toContain("-d");
  });

  test("keeps an explicit dump as a current-buffer snapshot", async () => {
    const requests: ProcessRequest[] = [];
    await runLogs({ dump: true }, {}, dependencies(requests));

    const logcat = requests.find(({ args }) => args?.includes("logcat"));
    expect(logcat?.args).toContain("-d");
    expect(logcat?.args).not.toContain("-T");
  });

  test("streams bounded, parsed, redacted logs for one package and target", async () => {
    const requests: ProcessRequest[] = [];
    const streamed: string[] = [];
    const execution = await runLogs(
      {
        packageName: "com.example.demo",
        tags: ["DemoTag"],
        excludeTags: ["ChattyTag"],
        minimumPriority: "D",
        buffers: ["main", "crash"],
        tail: 50,
        dump: true,
        maxRecords: 1,
        onLine: (line) => streamed.push(line),
      },
      {},
      dependencies(requests),
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.data).toMatchObject({
      selected: { transport: { serial: "USB-1" } },
      packageName: "com.example.demo",
      pid: 321,
      buffers: ["main", "crash"],
      filters: ["ChattyTag:S", "DemoTag:D", "*:S"],
      findings: [],
      dropped: 1,
      records: [{ parsed: true, priority: "E", tag: "DemoTag", message: "token=[REDACTED]" }],
    });
    const logcat = requests.find(({ args }) => args?.includes("logcat"));
    expect(logcat?.args).toEqual([
      "-t",
      "7",
      "logcat",
      "-v",
      "threadtime",
      "-b",
      "main",
      "-b",
      "crash",
      "-t",
      "50",
      "--pid=321",
      "ChattyTag:S",
      "DemoTag:D",
      "*:S",
    ]);
    expect(streamed.join("\n")).not.toContain("secret-value");
  });

  test("uses a restart-stable package UID when the device exposes it", async () => {
    const requests: ProcessRequest[] = [];
    const deps = dependencies(requests);
    const baseRunner = deps.runner;
    deps.runner = async (request) => {
      if (request.args?.includes("packages")) {
        requests.push(request);
        return result(request, "package:com.example.demo uid:10123\n");
      }
      if (baseRunner === undefined) throw new Error("missing fixture runner");
      return await baseRunner(request);
    };

    const execution = await runLogs({ packageName: "com.example.demo", dump: true }, {}, deps);

    expect(execution.result.data).toMatchObject({ uid: 10123 });
    expect(execution.result.data?.pid).toBeUndefined();
    expect(requests.find(({ args }) => args?.includes("logcat"))?.args).toContain("--uid=10123");
    expect(requests.some(({ args }) => args?.includes("pidof"))).toBeFalse();
  });

  test("emits one structured finding for repeated fatal markers", async () => {
    const requests: ProcessRequest[] = [];
    const deps = dependencies(requests);
    const baseRunner = deps.runner;
    deps.runner = async (request) => {
      if (request.args?.includes("logcat")) {
        requests.push(request);
        const output =
          "09-10 10:00:00.000  321  322 F AndroidRuntime: FATAL EXCEPTION: main\n" +
          "09-10 10:00:01.000  321  322 E AndroidRuntime: FATAL EXCEPTION: main\n";
        request.onStdoutChunk?.(new TextEncoder().encode(output));
        return result(request, output);
      }
      if (baseRunner === undefined) throw new Error("missing fixture runner");
      return await baseRunner(request);
    };

    const execution = await runLogs({ dump: true }, {}, deps);

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.data?.findings).toEqual([
      expect.objectContaining({ code: "ANDROID_FATAL_EXCEPTION" }),
    ]);
  });

  test("fails clearly before logcat when the selected package is not running", async () => {
    const requests: ProcessRequest[] = [];
    const execution = await runLogs(
      { packageName: "com.example.missing", dump: true },
      {},
      dependencies(requests, ""),
    );

    expect(execution.result.problems.at(-1)?.code).toBe(ProblemCode.LogPackageNotRunning);
    expect(requests.some(({ args }) => args?.includes("logcat"))).toBeFalse();
  });
});
