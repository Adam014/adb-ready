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
  test("fails safely across discovery, selection, listing, mutation, and verification", async () => {
    const missing = await runPorts(
      { direction: "reverse", action: "list" },
      {},
      { locateAdb: async () => undefined },
    );
    expect(missing.result.problems[0]?.code).toBe(ProblemCode.AdbNotFound);

    const inventoryFailure = await runPorts(
      { direction: "reverse", action: "list" },
      {},
      dependencies(async (request) =>
        request.args?.includes("devices")
          ? result(request, "", 1, "server unavailable")
          : result(request),
      ),
    );
    expect(inventoryFailure.result.data).toBeNull();

    const noTarget = await runPorts(
      { direction: "reverse", action: "list" },
      {},
      dependencies(async (request) =>
        request.args?.includes("devices")
          ? result(request, "List of devices attached\n")
          : result(request),
      ),
    );
    expect(noTarget.exitCode).toBe(ExitCode.Target);

    const listFailure = await runPorts(
      { direction: "reverse", action: "list" },
      {},
      dependencies(async (request) => {
        const probe = targetProbe(request);
        if (probe !== undefined) return probe;
        return request.args?.includes("--list")
          ? result(request, "", 1, "list failed")
          : result(request);
      }),
    );
    expect(listFailure.result.ok).toBeFalse();

    const notFound = await runPorts(
      { direction: "reverse", action: "remove", devicePort: 8081 },
      {},
      dependencies(async (request) => targetProbe(request) ?? result(request)),
    );
    expect(notFound.result.data?.status).toBe("not-found");

    let listCount = 0;
    const mutationFailure = await runPorts(
      { direction: "reverse", action: "add", devicePort: 8081 },
      {},
      dependencies(async (request) => {
        const probe = targetProbe(request);
        if (probe !== undefined) return probe;
        if (request.args?.includes("--list")) return result(request);
        return result(request, "", 1, "mutation failed");
      }),
    );
    expect(mutationFailure.result.ok).toBeFalse();

    const verifyListFailure = await runPorts(
      { direction: "reverse", action: "add", devicePort: 8081 },
      {},
      dependencies(async (request) => {
        const probe = targetProbe(request);
        if (probe !== undefined) return probe;
        if (request.args?.includes("--list")) {
          listCount += 1;
          return listCount === 1 ? result(request) : result(request, "", 1, "verify failed");
        }
        return result(request);
      }),
    );
    expect(verifyListFailure.result.ok).toBeFalse();

    listCount = 0;
    const mismatch = await runPorts(
      { direction: "reverse", action: "add", devicePort: 8081 },
      {},
      dependencies(async (request) => {
        const probe = targetProbe(request);
        if (probe !== undefined) return probe;
        if (request.args?.includes("--list")) {
          listCount += 1;
          return result(request, "");
        }
        return result(request);
      }),
    );
    expect(mismatch.result.problems.at(-1)?.code).toBe(ProblemCode.PortMappingVerificationFailed);
  });

  test("validates missing and malformed primary and secondary ports", async () => {
    const requests = [
      { direction: "reverse" as const, action: "add" as const },
      { direction: "forward" as const, action: "add" as const },
      { direction: "reverse" as const, action: "add" as const, devicePort: 8081, hostPort: 0 },
      { direction: "forward" as const, action: "add" as const, hostPort: 9229, devicePort: 0 },
    ];
    for (const request of requests) {
      const execution = await runPorts(request, {}, { locateAdb: async () => "/sdk/adb" });
      expect(execution.result.problems[0]?.code).toBe(ProblemCode.InvalidPort);
    }
  });

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

  test("adds and removes a forward mapping with verification", async () => {
    let mapping: string | undefined;
    const runner: ProcessRunner = async (request) => {
      const probe = targetProbe(request);
      if (probe !== undefined) return probe;
      const args = request.args ?? [];
      if (args.includes("--list")) return result(request, mapping ?? "");
      if (args.includes("--no-rebind")) mapping = "USB-1 tcp:9229 tcp:3000\n";
      if (args.includes("--remove")) mapping = undefined;
      return result(request);
    };

    const added = await runPorts(
      { direction: "forward", action: "add", hostPort: 9229, devicePort: 3000 },
      {},
      dependencies(runner),
    );
    expect(added.exitCode).toBe(ExitCode.Success);
    expect(added.result.data).toMatchObject({
      status: "added",
      mappings: [{ direction: "forward", host: "tcp:9229", device: "tcp:3000" }],
    });

    const removed = await runPorts(
      { direction: "forward", action: "remove", hostPort: 9229, devicePort: 3000 },
      {},
      dependencies(runner),
    );
    expect(removed.exitCode).toBe(ExitCode.Success);
    expect(removed.result.data).toMatchObject({ status: "removed", mappings: [] });
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
