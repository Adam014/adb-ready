import { describe, expect, test } from "bun:test";
import { runPorts } from "../../src/app/commands.js";
import { ExitCode } from "../../src/domain/contracts.js";
import { ProblemCode } from "../../src/domain/problems.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../../src/platform/process-runner.js";

function result(request: ProcessRequest, stdout = "", exitCode = 0, stderr = ""): ProcessResult {
  return {
    executable: request.executable,
    args: [...(request.args ?? [])],
    startedAt: "2026-09-10T10:00:00.000Z",
    finishedAt: "2026-09-10T10:00:00.010Z",
    durationMs: 10,
    exitCode,
    signal: null,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    stoppedAfterIdle: false,
    killEscalated: false,
  };
}

function dependencies(runner: ProcessRunner) {
  let id = 0;
  return {
    runner,
    locateAdb: async () => "/sdk/platform-tools/adb",
    idFactory: () => `id-${String(++id)}`,
    clock: () => new Date("2026-09-10T10:00:00.000Z"),
  };
}

function targetProbe(request: ProcessRequest): ProcessResult | undefined {
  const args = request.args ?? [];
  if (args.includes("devices")) {
    return result(
      request,
      "List of devices attached\nUSB-1 device model:Pixel_9 usb:1-1 transport_id:7\n",
    );
  }
  if (args.includes("ro.serialno")) {
    return result(request, "PHONE-1\n");
  }
  if (args.includes("host-features")) {
    return result(request, "shell_v2\n");
  }
  if (args.includes("mdns")) {
    return result(request, "List of discovered mdns services\n");
  }
  return undefined;
}

describe("runPorts", () => {
  test("adds with no-rebind, uses the transport ID, and verifies the result", async () => {
    const requests: ProcessRequest[] = [];
    let listCount = 0;
    const execution = await runPorts(
      { direction: "reverse", action: "add", devicePort: 8081, hostPort: 3000 },
      {},
      dependencies(async (request) => {
        requests.push(request);
        const probe = targetProbe(request);
        if (probe !== undefined) return probe;
        const args = request.args ?? [];
        if (args.includes("--list")) {
          listCount += 1;
          return result(request, listCount === 1 ? "" : "host tcp:8081 tcp:3000\n");
        }
        return result(request);
      }),
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.data).toMatchObject({
      status: "added",
      requested: { device: "tcp:8081", host: "tcp:3000" },
      mappings: [{ direction: "reverse", serial: "host", device: "tcp:8081", host: "tcp:3000" }],
    });
    expect(requests.find(({ args }) => args?.includes("--no-rebind"))?.args).toEqual([
      "-t",
      "7",
      "reverse",
      "--no-rebind",
      "tcp:8081",
      "tcp:3000",
    ]);
    expect(requests.filter(({ args }) => args?.includes("--list"))).toHaveLength(2);
  });

  test("treats an exact existing mapping as idempotent and never mutates it", async () => {
    const requests: ProcessRequest[] = [];
    const execution = await runPorts(
      { direction: "reverse", action: "add", devicePort: 8081 },
      {},
      dependencies(async (request) => {
        requests.push(request);
        return (
          targetProbe(request) ??
          result(request, request.args?.includes("--list") ? "host tcp:8081 tcp:8081\n" : "")
        );
      }),
    );

    expect(execution.result.data?.status).toBe("already-exists");
    expect(requests.some(({ args }) => args?.includes("--no-rebind"))).toBe(false);
  });

  test("reports a conflict instead of overwriting another mapping", async () => {
    const requests: ProcessRequest[] = [];
    const execution = await runPorts(
      { direction: "reverse", action: "add", devicePort: 8081, hostPort: 3000 },
      {},
      dependencies(async (request) => {
        requests.push(request);
        return (
          targetProbe(request) ??
          result(request, request.args?.includes("--list") ? "host tcp:8081 tcp:9000\n" : "")
        );
      }),
    );

    expect(execution.exitCode).toBe(ExitCode.AdbOperation);
    expect(execution.result.problems.at(-1)?.code).toBe(ProblemCode.PortMappingConflict);
    expect(requests.some(({ args }) => args?.includes("--no-rebind"))).toBe(false);
  });

  test("plans a forward without mutation and keeps host/device semantics explicit", async () => {
    const requests: ProcessRequest[] = [];
    const execution = await runPorts(
      { direction: "forward", action: "add", hostPort: 9229, devicePort: 3000 },
      { dryRun: true },
      dependencies(async (request) => {
        requests.push(request);
        return targetProbe(request) ?? result(request);
      }),
    );

    expect(execution.result.data).toMatchObject({
      status: "planned",
      plan: {
        dryRun: true,
        steps: [
          {
            id: "forward-add",
            args: ["-t", "7", "forward", "--no-rebind", "tcp:9229", "tcp:3000"],
          },
          { id: "verify-port-mapping" },
        ],
      },
    });
    expect(requests.some(({ args }) => args?.includes("--no-rebind"))).toBe(false);
  });

  test("validates ports before resolving ADB", async () => {
    let resolved = false;
    const execution = await runPorts(
      { direction: "reverse", action: "add", devicePort: "tcp:0" },
      {},
      {
        locateAdb: async () => {
          resolved = true;
          return "adb";
        },
      },
    );

    expect(execution.exitCode).toBe(ExitCode.InvalidInput);
    expect(execution.result.problems[0]?.code).toBe(ProblemCode.InvalidPort);
    expect(resolved).toBe(false);
  });
});
