import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import {
  runConnect,
  runDevices,
  runDoctor,
  runPair,
  runWirelessDiscovery,
} from "../../src/app/commands.js";
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
  if (args.includes("connect")) {
    return "connect";
  }
  if (args.includes("pair")) {
    return "pair";
  }
  if (args.includes("get-state")) {
    return "get-state";
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

  test("selects an exact configured alias without relying on list order", async () => {
    const execution = await runDevices(
      { targetSelector: "desk", targetAliases: { desk: "USB-2" } },
      deterministicDependencies(
        fixtureRunner({
          devices:
            "List of devices attached\n" +
            "USB-1 device model:Pixel_8 transport_id:1\n" +
            "USB-2 device model:Pixel_9 transport_id:2\n",
          "hardware-serial:USB-1": "USB-1\n",
          "hardware-serial:USB-2": "USB-2\n",
          "mdns-services": "List of discovered mdns services\n",
        }),
      ),
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.data?.selected).toMatchObject({
      reason: "alias",
      transport: { serial: "USB-2", transportId: "2" },
    });
  });

  test("returns a stable target error when an explicit selector is absent", async () => {
    const execution = await runDevices(
      { targetSelector: "missing" },
      deterministicDependencies(fixtureRunner({ devices: "List of devices attached\n" })),
    );

    expect(execution.exitCode).toBe(ExitCode.Target);
    expect(execution.result.problems.at(-1)?.code).toBe(ProblemCode.TargetNotFound);
  });

  test("uses exit code 130 for an interrupted ADB inventory", async () => {
    const runner: ProcessRunner = async (request) =>
      processResult(request, { exitCode: null, signal: "SIGTERM", aborted: true });
    const execution = await runDevices({}, deterministicDependencies(runner));

    expect(execution.exitCode).toBe(ExitCode.Interrupted);
    expect(execution.result.problems[0]?.code).toBe(ProblemCode.OperationInterrupted);
  });
});

describe("wireless target commands", () => {
  test("returns deterministic de-duplicated mDNS choices for interactive callers", async () => {
    const execution = await runWirelessDiscovery(
      "connect",
      {},
      deterministicDependencies(
        fixtureRunner({
          "mdns-services":
            "List of discovered mdns services\n" +
            "adb-A-x _adb-tls-connect._tcp 192.168.1.20:37123\n" +
            "adb-A-x _adb-tls-connect._tcp 192.168.1.20:37123\n" +
            "adb-B-y _adb-tls-connect._tcp 192.168.1.21:37124\n" +
            "adb-C-z _adb-tls-pairing._tcp 192.168.1.22:41234\n",
        }),
      ),
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.data?.services.map(({ endpoint }) => endpoint.serial)).toEqual([
      "192.168.1.20:37123",
      "192.168.1.21:37124",
    ]);
  });

  test("connects an explicit endpoint and verifies the final serial", async () => {
    const requests: ProcessRequest[] = [];
    const execution = await runConnect(
      "192.168.1.20:37123",
      {},
      deterministicDependencies(
        fixtureRunner(
          {
            connect: "connected to 192.168.1.20:37123\n",
            "get-state": "device\n",
            "hardware-serial:192.168.1.20:37123": "PHONE-1\n",
          },
          requests,
        ),
      ),
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.data).toEqual({
      adbPath: "~/Android/sdk/platform-tools/adb",
      endpoint: "192.168.1.20:37123",
      status: "connected",
      serial: "192.168.1.20:37123",
      state: "device",
      hardwareSerial: "PHONE-1",
      discovered: false,
    });
    expect(requests.map(commandName)).toEqual([
      "connect",
      "get-state",
      "hardware-serial:192.168.1.20:37123",
    ]);
  });

  test("uses one discovered connect service but refuses to guess among several", async () => {
    const one = await runConnect(
      undefined,
      {},
      deterministicDependencies(
        fixtureRunner({
          "mdns-services":
            "List of discovered mdns services\n" +
            "adb-PHONE-1-x _adb-tls-connect._tcp 192.168.1.20:37123\n",
          connect: "connected to 192.168.1.20:37123\n",
          "get-state": "device\n",
        }),
      ),
    );
    expect(one.result.data).toMatchObject({ endpoint: "192.168.1.20:37123", discovered: true });

    const several = await runConnect(
      undefined,
      {},
      deterministicDependencies(
        fixtureRunner({
          "mdns-services":
            "List of discovered mdns services\n" +
            "adb-A-x _adb-tls-connect._tcp 192.168.1.20:37123\n" +
            "adb-B-y _adb-tls-connect._tcp 192.168.1.21:37124\n",
        }),
      ),
    );
    expect(several.exitCode).toBe(ExitCode.Target);
    expect(several.result.problems[0]?.code).toBe(ProblemCode.MultipleWirelessEndpoints);
  });

  test("passes the pairing code only over stdin and never returns it", async () => {
    const requests: ProcessRequest[] = [];
    const execution = await runPair(
      "192.168.1.20:41234",
      "123456",
      {},
      deterministicDependencies(
        fixtureRunner(
          { pair: "Successfully paired to 192.168.1.20:41234 [guid=fixture]\n" },
          requests,
        ),
      ),
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(requests[0]).toMatchObject({
      args: ["pair", "192.168.1.20:41234"],
      input: "123456\n",
    });
    expect(JSON.stringify(execution.result)).not.toContain("123456");
  });

  test("rejects malformed endpoints and pairing codes as input errors", async () => {
    const deps = deterministicDependencies(fixtureRunner({}));
    const connection = await runConnect("0.0.0.0:5555", {}, deps);
    const pairing = await runPair("192.168.1.20:41234", "12ab56", {}, deps);

    expect(connection.exitCode).toBe(ExitCode.InvalidInput);
    expect(connection.result.problems[0]?.code).toBe(ProblemCode.InvalidEndpoint);
    expect(pairing.exitCode).toBe(ExitCode.InvalidInput);
    expect(pairing.result.problems[0]?.code).toBe(ProblemCode.InvalidPairingCode);
  });

  test("plans connect and pair without invoking a mutating ADB command", async () => {
    const requests: ProcessRequest[] = [];
    const deps = deterministicDependencies(fixtureRunner({}, requests));
    const connection = await runConnect("192.168.1.20:37123", { dryRun: true }, deps);
    const pairing = await runPair("192.168.1.20:41234", "", { dryRun: true }, deps);

    expect(connection.result.data).toMatchObject({
      endpoint: "192.168.1.20:37123",
      plan: { dryRun: true, steps: [{ id: "connect" }, { id: "verify" }] },
    });
    expect(pairing.result.data).toMatchObject({
      endpoint: "192.168.1.20:41234",
      plan: { dryRun: true, steps: [{ id: "pair" }] },
    });
    expect(requests).toEqual([]);
    expect(JSON.stringify(pairing.result)).not.toMatch(/\b\d{6}\b/u);
  });
});
