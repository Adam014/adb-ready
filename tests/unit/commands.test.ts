import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { runDevices, runDoctor } from "../../src/app/commands.js";
import { ExitCode } from "../../src/domain/contracts.js";
import { ProblemCode } from "../../src/domain/problems.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../../src/platform/process-runner.js";

function processResult(
  request: ProcessRequest,
  overrides: Partial<ProcessResult> = {},
): ProcessResult {
  return {
    executable: request.executable,
    args: [...(request.args ?? [])],
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

function commandName(request: ProcessRequest): string {
  const args = request.args ?? [];
  if (args.includes("mdns")) {
    return "mdns-services";
  }
  if (args.includes("ro.serialno")) {
    return `hardware-serial:${String(args[args.indexOf("-s") + 1])}`;
  }
  if (args.includes("devices")) {
    return "devices";
  }
  return args.at(-1) ?? "";
}

function fixtureRunner(
  outputs: Partial<Record<string, string>>,
  requests: ProcessRequest[] = [],
): ProcessRunner {
  return async (request) => {
    requests.push(request);
    return processResult(request, {
      stdout: outputs[commandName(request) as keyof typeof outputs] ?? "",
    });
  };
}

function deterministicDependencies(runner: ProcessRunner) {
  let id = 0;
  return {
    runner,
    locateAdb: async () => `${homedir()}/Android/sdk/platform-tools/adb`,
    runtime: () => ({
      name: "node" as const,
      version: "22.22.2",
      platform: "darwin" as const,
      architecture: "arm64",
    }),
    idFactory: () => `id-${++id}`,
    clock: () => new Date("2026-09-09T10:00:00.000Z"),
  };
}

describe("runDoctor", () => {
  test("collects portable runtime, ADB capabilities, status, and target data", async () => {
    const execution = await runDoctor(
      {},
      deterministicDependencies(
        fixtureRunner({
          version:
            "Android Debug Bridge version 1.0.41\n" +
            `Version 37.0.0\nInstalled as ${homedir()}/Android/sdk/platform-tools/adb\n`,
          "host-features": "shell_v2,server_status,abb_exec\n",
          "server-status": `Binary path: ${homedir()}/Android/sdk/platform-tools/adb\nUSB backend: libusb\n`,
          devices:
            "List of devices attached\n" +
            "emulator-5554 device product:sdk model:Pixel_9 device:emu transport_id:1\n",
          "hardware-serial:emulator-5554": "EMULATOR-9\n",
          "mdns-services": "List of discovered mdns services\n",
        }),
      ),
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.ok).toBe(true);
    expect(execution.result.data).toMatchObject({
      runtime: { name: "node", version: "22.22.2" },
      adb: {
        path: "~/Android/sdk/platform-tools/adb",
        version: {
          platformToolsVersion: "37.0.0",
          installedAs: "~/Android/sdk/platform-tools/adb",
        },
        hostFeatures: ["abb_exec", "server_status", "shell_v2"],
        serverStatus: {
          "Binary path": "~/Android/sdk/platform-tools/adb",
          "USB backend": "libusb",
        },
      },
      devices: [{ serial: "emulator-5554", state: "device", model: "Pixel 9" }],
      targets: [{ serial: "emulator-5554", name: "Pixel 9", hardwareSerial: "EMULATOR-9" }],
      discovery: {
        mdns: { available: true, services: [] },
        identity: { probed: 1, resolved: 1 },
      },
    });
    expect(execution.result.problems).toEqual([]);
  });

  test("does not invoke server-status unless ADB advertises the capability", async () => {
    const requests: ProcessRequest[] = [];
    const execution = await runDoctor(
      {},
      deterministicDependencies(
        fixtureRunner(
          {
            version: "Android Debug Bridge version 1.0.41\nVersion 35.0.2\n",
            "host-features": "shell_v2,abb_exec\n",
            devices: "List of devices attached\n",
          },
          requests,
        ),
      ),
    );

    expect(requests.map(commandName)).toEqual([
      "version",
      "host-features",
      "devices",
      "mdns-services",
    ]);
    expect(execution.result.data?.adb.serverStatus).toBeNull();
    expect(execution.exitCode).toBe(ExitCode.Success);
  });

  test("continues after an unsupported optional host-features probe", async () => {
    const runner: ProcessRunner = async (request) => {
      if (commandName(request) === "host-features") {
        return processResult(request, { exitCode: 1, stderr: "unknown command host-features" });
      }
      return processResult(request, {
        stdout:
          commandName(request) === "version"
            ? "Android Debug Bridge version 1.0.41\nVersion 34.0.5\n"
            : "List of devices attached\n",
      });
    };
    const execution = await runDoctor({}, deterministicDependencies(runner));

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.problems.map(({ code }) => code)).toEqual([
      ProblemCode.AdbOptionalProbeFailed,
      ProblemCode.NoTargets,
    ]);
  });

  test("returns an environment error when ADB cannot be resolved", async () => {
    const execution = await runDoctor(
      { adbPath: "/missing/adb" },
      {
        locateAdb: async () => undefined,
        idFactory: () => "command-1",
        clock: () => new Date("2026-09-09T10:00:00.000Z"),
      },
    );

    expect(execution.exitCode).toBe(ExitCode.Environment);
    expect(execution.result.data).toBeNull();
    expect(execution.result.problems[0]?.code).toBe(ProblemCode.AdbNotFound);
  });
});

describe("runDevices", () => {
  test("reports an empty inventory as a non-fatal diagnostic warning", async () => {
    const execution = await runDevices(
      {},
      deterministicDependencies(fixtureRunner({ devices: "List of devices attached\n" })),
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.ok).toBe(true);
    expect(execution.result.data?.devices).toEqual([]);
    expect(execution.result.data?.targets).toEqual([]);
    expect(execution.result.problems[0]?.code).toBe(ProblemCode.NoTargets);
  });

  test("deduplicates USB and wireless transports only after observing the same identity", async () => {
    const execution = await runDevices(
      {},
      deterministicDependencies(
        fixtureRunner({
          devices:
            "List of devices attached\n" +
            "USB-1 device model:Pixel_9 usb:1-1 transport_id:1\n" +
            "192.168.1.20:37123 device model:Pixel_9 transport_id:2\n",
          "hardware-serial:USB-1": "PHONE-1\n",
          "hardware-serial:192.168.1.20:37123": "PHONE-1\n",
          "mdns-services":
            "List of discovered mdns services\n" +
            "adb-PHONE-1-aBcD _adb-tls-connect._tcp 192.168.1.20:37123\n",
        }),
      ),
    );

    expect(execution.result.data?.targets).toHaveLength(1);
    expect(execution.result.data?.targets[0]?.transports.map(({ kind }) => kind)).toEqual([
      "usb",
      "tls",
    ]);
  });

  test("keeps an offline target visible without failing the inventory command", async () => {
    const execution = await runDevices(
      {},
      deterministicDependencies(
        fixtureRunner({
          devices: "List of devices attached\n192.0.2.10:5555 offline transport_id:4\n",
        }),
      ),
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.data?.devices[0]).toMatchObject({
      serial: "192.0.2.10:5555",
      state: "offline",
    });
    expect(execution.result.problems[0]).toMatchObject({
      code: ProblemCode.TargetOffline,
      severity: "warning",
    });
  });

  test("uses exit code 130 for an interrupted ADB inventory", async () => {
    const runner: ProcessRunner = async (request) =>
      processResult(request, { exitCode: null, signal: "SIGTERM", aborted: true });
    const execution = await runDevices({}, deterministicDependencies(runner));

    expect(execution.exitCode).toBe(ExitCode.Interrupted);
    expect(execution.result.problems[0]?.code).toBe(ProblemCode.OperationInterrupted);
  });
});
