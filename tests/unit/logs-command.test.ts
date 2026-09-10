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
  test("streams bounded, parsed, redacted logs for one package and target", async () => {
    const requests: ProcessRequest[] = [];
    const streamed: string[] = [];
    const execution = await runLogs(
      {
        packageName: "com.example.demo",
        tags: ["DemoTag"],
        minimumPriority: "D",
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
      filters: ["DemoTag:D", "*:S"],
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
      "-d",
      "--pid=321",
      "DemoTag:D",
      "*:S",
    ]);
    expect(streamed.join("\n")).not.toContain("secret-value");
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
