import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type CommandDependencies, runDev, runDevOfflinePlan } from "../../src/app/commands.js";
import type { ProjectDetection } from "../../src/dev/project.js";
import { ExitCode } from "../../src/domain/contracts.js";
import { ProblemCode } from "../../src/domain/problems.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../../src/platform/process-runner.js";
import { listSessions, readSessionEvents } from "../../src/state/session-store.js";

function result(request: ProcessRequest, overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    executable: request.executable,
    args: [...(request.args ?? [])],
    startedAt: "2026-09-10T10:00:00.000Z",
    finishedAt: "2026-09-10T10:00:00.010Z",
    durationMs: 10,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    stoppedAfterIdle: false,
    killEscalated: false,
    ...overrides,
  };
}

function dependencies(runner: ProcessRunner): CommandDependencies {
  let id = 0;
  return {
    runner,
    locateAdb: async () => "/sdk/adb",
    detectProject: async () => ({
      root: "/workspace/app",
      presetEvidence: [],
      packageManager: { conflicts: [] },
    }),
    idFactory: () => `id-${String(++id)}`,
    clock: () => new Date("2026-09-10T10:00:00.000Z"),
    resolveExpoLaunch: async ({ runtime, signal }) =>
      signal?.aborted === true
        ? { status: "aborted" }
        : {
            status: "resolved",
            target: {
              url: "demo://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081%2F",
              runtime,
              source: "link",
              applicationId: "com.example.demo",
            },
          },
  };
}

function targetProbe(request: ProcessRequest): ProcessResult | undefined {
  const args = request.args ?? [];
  if (args.includes("devices")) {
    return result(request, {
      stdout: "List of devices attached\nUSB-1 device model:Pixel_9 transport_id:7\n",
    });
  }
  if (args.includes("ro.serialno")) return result(request, { stdout: "PHONE-1\n" });
  if (args.includes("host-features")) return result(request, { stdout: "shell_v2\n" });
  if (args.includes("mdns")) {
    return result(request, { stdout: "List of discovered mdns services\n" });
  }
  if (args.includes("resolve-activity")) {
    return result(request, { stdout: "priority=0\ncom.example.demo/.MainActivity\n" });
  }
  return undefined;
}

describe("runDev", () => {
  test("auto-reverses public Expo localhost services and includes them in default readiness", async () => {
    const deps = dependencies(async (request) => result(request));
    deps.detectProject = async () => ({
      root: "/workspace/app",
      preset: "expo",
      presetEvidence: ["dependency: expo"],
      packageManager: {
        name: "npm",
        executable: "/bin/npm",
        source: "lockfile",
        conflicts: [],
      },
    });
    deps.discoverExpoLocalServices = () => [
      {
        devicePort: 8000,
        hostPort: 8000,
        variables: ["EXPO_PUBLIC_API_URL"],
        environmentFiles: [".env.development.local"],
      },
    ];

    const execution = await runDevOfflinePlan(
      {
        cwd: "/workspace/app",
        preset: "expo",
        reversePorts: [{ device: 8081 }],
      },
      deps,
    );

    expect(execution.result.data).toMatchObject({
      localServices: [
        {
          devicePort: 8000,
          hostPort: 8000,
          variables: ["EXPO_PUBLIC_API_URL"],
        },
      ],
      ports: {
        requested: [
          { device: "tcp:8081", host: "tcp:8081" },
          { device: "tcp:8000", host: "tcp:8000" },
        ],
      },
    });
    expect(execution.result.data?.plan?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "reverse-2", title: expect.stringContaining("tcp:8000") }),
        expect.objectContaining({ id: "ready-2", title: "Verify host-port readiness" }),
        expect.objectContaining({ id: "ready-3", title: "Verify host-port readiness" }),
      ]),
    );
  });

  test("lets an explicit Expo mapping cover a discovered device port", async () => {
    const deps = dependencies(async (request) => result(request));
    deps.detectProject = async () => ({
      root: "/workspace/app",
      preset: "expo",
      presetEvidence: [],
      packageManager: {
        name: "npm",
        executable: "/bin/npm",
        source: "lockfile",
        conflicts: [],
      },
    });
    deps.discoverExpoLocalServices = () => [
      {
        devicePort: 8000,
        hostPort: 8000,
        variables: ["EXPO_PUBLIC_API_URL"],
        environmentFiles: [],
      },
    ];

    const execution = await runDevOfflinePlan(
      {
        cwd: "/workspace/app",
        preset: "expo",
        reversePorts: [{ device: 8081 }, { device: 8000, host: 9000 }],
      },
      deps,
    );

    expect(execution.result.data?.ports.requested).toEqual([
      { device: "tcp:8081", host: "tcp:8081" },
      { device: "tcp:8000", host: "tcp:9000" },
    ]);
  });

  test("supports an explicit opt-out from Expo localhost discovery", async () => {
    let discoveryCalls = 0;
    const deps = dependencies(async (request) => result(request));
    deps.detectProject = async () => ({
      root: "/workspace/app",
      preset: "expo",
      presetEvidence: [],
      packageManager: {
        name: "npm",
        executable: "/bin/npm",
        source: "lockfile",
        conflicts: [],
      },
    });
    deps.discoverExpoLocalServices = () => {
      discoveryCalls += 1;
      return [];
    };

    const execution = await runDevOfflinePlan(
      { cwd: "/workspace/app", preset: "expo", autoReverseLocalhost: false },
      deps,
    );

    expect(discoveryCalls).toBe(0);
    expect(execution.result.data?.localServices).toEqual([]);
    expect(execution.result.data?.ports.requested).toEqual([
      { device: "tcp:8081", host: "tcp:8081" },
    ]);
  });

  test("fails safely when Expo environment discovery cannot be completed", async () => {
    const deps = dependencies(async (request) => result(request));
    deps.detectProject = async () => ({
      root: "/workspace/app",
      preset: "expo",
      presetEvidence: ["dependency: expo"],
      packageManager: {
        name: "npm",
        executable: "/bin/npm",
        source: "lockfile",
        conflicts: [],
      },
    });
    deps.discoverExpoLocalServices = () => {
      throw new Error("secret dotenv value");
    };

    const execution = await runDevOfflinePlan({ cwd: "/workspace/app" }, deps);

    expect(execution.exitCode).toBe(ExitCode.Environment);
    expect(execution.result.data).toBeNull();
    expect(execution.result.problems).toEqual([
      expect.objectContaining({
        code: ProblemCode.ExpoEnvironmentDiscoveryFailed,
        detail: expect.not.stringContaining("secret dotenv value"),
      }),
    ]);
  });

  test("creates and cleans a discovered backend mapping in a real development session", async () => {
    const requests: ProcessRequest[] = [];
    const mappings = new Map<string, string>();
    const deps = dependencies(async (request) => {
      requests.push(request);
      const probe = targetProbe(request);
      if (probe !== undefined) return probe;
      const args = request.args ?? [];
      if (args.includes("--no-rebind")) {
        const device = args.at(-2);
        const host = args.at(-1);
        if (device !== undefined && host !== undefined) mappings.set(device, host);
        return result(request);
      }
      if (args.includes("--remove")) {
        const device = args.at(-1);
        if (device !== undefined) mappings.delete(device);
        return result(request);
      }
      if (args.includes("--list")) {
        return result(request, {
          stdout: [...mappings].map(([device, host]) => `host ${device} ${host}\n`).join(""),
        });
      }
      return result(request);
    });
    deps.detectProject = async () => ({
      root: "/workspace/app",
      preset: "expo",
      presetEvidence: [],
      packageManager: {
        name: "npm",
        executable: "/bin/npm",
        source: "lockfile",
        conflicts: [],
      },
    });
    deps.discoverExpoLocalServices = () => [
      {
        devicePort: 8000,
        hostPort: 8000,
        variables: ["EXPO_PUBLIC_API_URL"],
        environmentFiles: [".env.local"],
      },
    ];
    deps.probeMetroService = async () => ({
      status: "unavailable",
      endpoint: "http://127.0.0.1:8081",
    });

    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "expo",
        command: { executable: "project-start", args: [] },
        reversePorts: [{ device: 8081 }],
        readiness: { all: [] },
        logs: false,
        watch: false,
      },
      {},
      deps,
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(mappings.size).toBe(0);
    expect(execution.result.data?.ports).toMatchObject({
      requested: [
        { device: "tcp:8081", host: "tcp:8081" },
        { device: "tcp:8000", host: "tcp:8000" },
      ],
      created: expect.anything(),
      cleaned: true,
    });
    expect(
      requests.filter(({ args }) => args?.includes("--no-rebind")).map(({ args }) => args?.at(-2)),
    ).toEqual(["tcp:8081", "tcp:8000"]);
  });

  test("launches Expo only on the selected transport without delegating Android selection", async () => {
    const requests: ProcessRequest[] = [];
    let mapped = false;
    const deps = dependencies(async (request) => {
      requests.push(request);
      const args = request.args ?? [];
      if (args.includes("devices")) {
        return result(request, {
          stdout:
            "List of devices attached\nemulator-5554 device model:Pixel_9 transport_id:7\n10.0.0.9:41231 device model:Other_phone transport_id:8\n",
        });
      }
      if (args.includes("ro.serialno")) {
        return result(request, {
          stdout: args.includes("emulator-5554") ? "EMULATOR-1\n" : "PHONE-2\n",
        });
      }
      if (args.includes("host-features")) return result(request, { stdout: "shell_v2\n" });
      if (args.includes("mdns")) {
        return result(request, { stdout: "List of discovered mdns services\n" });
      }
      if (args.includes("--no-rebind")) {
        mapped = true;
        return result(request);
      }
      if (args.includes("--remove")) {
        mapped = false;
        return result(request);
      }
      if (args.includes("--list")) {
        return result(request, { stdout: mapped ? "host tcp:18081 tcp:18081\n" : "" });
      }
      if (args.includes("resolve-activity")) {
        return result(request, { stdout: "com.example.demo/.MainActivity\n" });
      }
      if (args.includes("am") && args.includes("start")) {
        return result(request, { stdout: "Status: ok\n" });
      }
      return result(request);
    });
    deps.detectProject = async () => ({
      root: "/workspace/app",
      preset: "expo",
      presetEvidence: ["package.json dependency: expo"],
      packageJson: {
        path: "/workspace/app/package.json",
        scripts: { start: "expo start -c" },
        hasExpoDevClient: true,
      },
      packageManager: {
        name: "npm",
        executable: "/bin/npm",
        source: "package-json",
        conflicts: [],
      },
    });
    deps.probeMetroService = async () => ({
      status: "unavailable",
      endpoint: "http://127.0.0.1:18081",
    });
    let resolvedDevicePort: number | undefined;
    deps.resolveExpoLaunch = async ({ devicePort, runtime }) => {
      resolvedDevicePort = devicePort;
      return {
        status: "resolved",
        target: {
          url: `demo://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A${String(devicePort)}`,
          runtime,
          source: "link",
          applicationId: "com.example.demo",
        },
      };
    };

    const execution = await runDev(
      {
        cwd: "/workspace/app",
        reversePorts: [{ device: 18081 }],
        readiness: { all: [] },
        logs: false,
        watch: false,
      },
      { targetSelector: "emulator-5554" },
      deps,
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(mapped).toBeFalse();
    expect(resolvedDevicePort).toBe(18081);
    expect(execution.result.data?.command).toMatchObject({
      executable: "/bin/npm",
      args: ["run", "start"],
    });
    expect(execution.result.data?.expoLaunch).toMatchObject({
      runtime: "custom",
      applicationId: "com.example.demo",
      verified: true,
    });
    const child = requests.find(({ executable }) => executable === "/bin/npm");
    expect(child?.args).not.toContain("--android");
    expect(child?.env?.ANDROID_SERIAL).toBe("emulator-5554");
    const targetOperations = requests.filter(
      ({ args }) => args?.includes("resolve-activity") || args?.includes("am"),
    );
    expect(targetOperations).toHaveLength(2);
    expect(targetOperations.every(({ args }) => args?.[0] === "-t" && args[1] === "7")).toBeTrue();
    expect(targetOperations.flatMap(({ args }) => args ?? [])).not.toContain("10.0.0.9:41231");
  });

  test("fails before ready when Expo cannot resolve or open the selected target", async () => {
    for (const failure of ["url", "handler", "launch"] as const) {
      let mapped = false;
      const deps = dependencies(async (request) => {
        const probe = targetProbe(request);
        if (
          probe !== undefined &&
          !(failure === "handler" && request.args?.includes("resolve-activity"))
        ) {
          return probe;
        }
        const args = request.args ?? [];
        if (args.includes("--no-rebind")) mapped = true;
        if (args.includes("--remove")) mapped = false;
        if (args.includes("--list")) {
          return result(request, { stdout: mapped ? "host tcp:8081 tcp:8081\n" : "" });
        }
        if (args.includes("resolve-activity")) return result(request, { stdout: "" });
        if (args.includes("am") && args.includes("start")) {
          return result(request, {
            exitCode: failure === "launch" ? 1 : 0,
            stderr: failure === "launch" ? "Error: activity not started\n" : "",
          });
        }
        return result(request);
      });
      deps.detectProject = async () => ({
        root: "/workspace/app",
        preset: "expo",
        presetEvidence: [],
        packageManager: {
          name: "npm",
          executable: "/bin/npm",
          source: "lockfile",
          conflicts: [],
        },
      });
      deps.probeMetroService = async () => ({
        status: "unavailable",
        endpoint: "http://127.0.0.1:8081",
      });
      if (failure === "url") {
        deps.resolveExpoLaunch = async () => ({
          status: "unavailable",
          detail: "No supported endpoint was available.",
        });
      }

      const execution = await runDev(
        {
          cwd: "/workspace/app",
          preset: "expo",
          command: { executable: "project-start", args: [] },
          reversePorts: [{ device: 8081 }],
          readiness: { all: [] },
          logs: false,
          watch: false,
        },
        {},
        deps,
      );

      expect(execution.exitCode).toBe(ExitCode.ChildProcess);
      expect(execution.result.data?.status).toBe("failed");
      expect(execution.result.data?.expoLaunch).toBeUndefined();
      expect(execution.result.problems).toContainEqual(
        expect.objectContaining({ code: ProblemCode.ExpoLaunchFailed }),
      );
      expect(mapped).toBeFalse();
      expect(
        execution.result.data?.journal.events.some(
          ({ type, data }) => type === "session.state.changed" && data?.to === "ready",
        ),
      ).toBeFalse();
    }
  });

  test("stops an interrupted or unmapped Expo launch before reporting ready", async () => {
    for (const failure of ["aborted", "mapping"] as const) {
      let mapped = false;
      const deps = dependencies(async (request) => {
        const probe = targetProbe(request);
        if (probe !== undefined) return probe;
        const args = request.args ?? [];
        if (args.includes("--no-rebind")) mapped = true;
        if (args.includes("--remove")) mapped = false;
        if (args.includes("--list")) {
          return result(request, { stdout: mapped ? "host tcp:8081 tcp:8081\n" : "" });
        }
        return result(request);
      });
      deps.detectProject = async () => ({
        root: "/workspace/app",
        preset: "expo",
        presetEvidence: [],
        packageManager: {
          name: "npm",
          executable: "/bin/npm",
          source: "lockfile",
          conflicts: [],
        },
      });
      deps.probeMetroService = async () => ({
        status: "unavailable",
        endpoint: "http://127.0.0.1:8081",
      });
      if (failure === "aborted") {
        deps.resolveExpoLaunch = async () => ({ status: "aborted" });
      }

      const execution = await runDev(
        {
          cwd: "/workspace/app",
          preset: "expo",
          command: { executable: "project-start", args: [] },
          reversePorts: failure === "mapping" ? [] : [{ device: 8081 }],
          readiness: { all: [] },
          logs: false,
          watch: false,
        },
        {},
        deps,
      );

      expect(execution.exitCode).toBe(
        failure === "aborted" ? ExitCode.Interrupted : ExitCode.ChildProcess,
      );
      expect(execution.result.problems).toContainEqual(
        expect.objectContaining({
          code:
            failure === "aborted" ? ProblemCode.OperationInterrupted : ProblemCode.ExpoLaunchFailed,
        }),
      );
      expect(execution.result.data?.status).toBe(failure === "aborted" ? "interrupted" : "failed");
      expect(mapped).toBeFalse();
    }
  });

  test("attaches to a verified existing Metro server without owning its process", async () => {
    const requests: ProcessRequest[] = [];
    let mapped = false;
    const controller = new AbortController();
    const deps = dependencies(async (request) => {
      requests.push(request);
      const probe = targetProbe(request);
      if (probe !== undefined) return probe;
      const args = request.args ?? [];
      if (args.includes("--no-rebind")) {
        mapped = true;
        return result(request);
      }
      if (args.includes("--remove")) {
        mapped = false;
        return result(request);
      }
      if (args.includes("--list")) {
        return result(request, { stdout: mapped ? "host tcp:8081 tcp:8081\n" : "" });
      }
      if (args.includes("am") && args.includes("start")) {
        setTimeout(() => controller.abort(), 0);
        return result(request, { stdout: "Status: ok\n" });
      }
      return result(request);
    });
    deps.detectProject = async () => ({
      root: "/workspace/app",
      presetEvidence: [],
      packageManager: {
        name: "npm",
        executable: "/bin/npm",
        source: "lockfile",
        conflicts: [],
      },
    });
    deps.probeMetroService = async (options) => {
      expect(options.expectedProjectRoot).toBe("/workspace/app");
      return {
        status: "available",
        endpoint: "http://127.0.0.1:8081",
      };
    };

    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "expo",
        command: { executable: "project-start", args: ["--android"] },
        reversePorts: [{ device: 8081 }],
        readiness: { all: [] },
        logs: false,
        watch: false,
      },
      {},
      deps,
      controller.signal,
    );

    expect(requests.some(({ executable }) => executable === "project-start")).toBeFalse();
    expect(mapped).toBeFalse();
    expect(execution.exitCode).toBe(ExitCode.Interrupted);
    expect(execution.result.data).toMatchObject({
      status: "interrupted",
      attachedService: {
        kind: "metro",
        endpoint: "http://127.0.0.1:8081",
        ownership: "external",
      },
      ports: { cleaned: true },
    });
    expect(execution.result.data).not.toHaveProperty("child");
    expect(
      execution.result.data?.journal.events
        .filter(({ type }) => type === "session.state.changed")
        .map(({ data }) => data?.to),
    ).toEqual([
      "acquiring-target",
      "preparing-ports",
      "attaching-child",
      "ready",
      "stopping",
      "ended",
    ]);
    expect(execution.result.data?.journal.events.map(({ type }) => type)).not.toContain(
      "child.started",
    );
  });

  test("refuses to attach or launch when Metro's port belongs to another service", async () => {
    const requests: ProcessRequest[] = [];
    let mapped = false;
    const deps = dependencies(async (request) => {
      requests.push(request);
      const probe = targetProbe(request);
      if (probe !== undefined) return probe;
      const args = request.args ?? [];
      if (args.includes("--no-rebind")) {
        mapped = true;
        return result(request);
      }
      if (args.includes("--remove")) {
        mapped = false;
        return result(request);
      }
      if (args.includes("--list")) {
        return result(request, { stdout: mapped ? "host tcp:8081 tcp:8081\n" : "" });
      }
      return result(request);
    });
    deps.detectProject = async () => ({
      root: "/workspace/app",
      presetEvidence: [],
      packageManager: {
        name: "npm",
        executable: "/bin/npm",
        source: "lockfile",
        conflicts: [],
      },
    });
    deps.probeMetroService = async (options) => {
      expect(options.expectedProjectRoot).toBe("/workspace/app");
      return {
        status: "occupied",
        endpoint: "http://127.0.0.1:8081",
        detail: "Metro belongs to a different project root.",
      };
    };

    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "react-native",
        command: { executable: "project-start", args: [] },
        reversePorts: [{ device: 8081 }],
        logs: false,
      },
      {},
      deps,
    );

    expect(requests.some(({ executable }) => executable === "project-start")).toBeFalse();
    expect(mapped).toBeFalse();
    expect(execution.result.problems).toContainEqual(
      expect.objectContaining({
        code: ProblemCode.DevelopmentServiceConflict,
        summary: "Port 8081 is occupied by a service ADB Ready cannot safely attach to.",
        detail:
          "Metro belongs to a different project root. Stop that service or configure the matching Metro host port before retrying.",
      }),
    );
  });

  test("cancels safely when the Metro probe is interrupted before launch", async () => {
    let mapped = false;
    const deps = dependencies(async (request) => {
      const probe = targetProbe(request);
      if (probe !== undefined) return probe;
      const args = request.args ?? [];
      if (args.includes("--no-rebind")) {
        mapped = true;
        return result(request);
      }
      if (args.includes("--remove")) {
        mapped = false;
        return result(request);
      }
      if (args.includes("--list")) {
        return result(request, { stdout: mapped ? "host tcp:8081 tcp:8081\n" : "" });
      }
      return result(request);
    });
    deps.detectProject = async () => ({
      root: "/workspace/app",
      presetEvidence: [],
      packageManager: {
        name: "npm",
        executable: "/bin/npm",
        source: "lockfile",
        conflicts: [],
      },
    });
    deps.probeMetroService = async () => ({
      status: "aborted",
      endpoint: "http://127.0.0.1:8081",
    });

    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "expo",
        command: { executable: "project-start", args: [] },
        reversePorts: [{ device: 8081 }],
        logs: false,
      },
      {},
      deps,
    );

    expect(mapped).toBeFalse();
    expect(execution.exitCode).toBe(ExitCode.Interrupted);
    expect(execution.result.data?.status).toBe("interrupted");
    expect(execution.result.problems).toContainEqual(
      expect.objectContaining({ code: ProblemCode.OperationInterrupted }),
    );
  });

  test("runs bounded verification against attached Metro without stopping it", async () => {
    const requests: ProcessRequest[] = [];
    const deps = dependencies(async (request) => {
      requests.push(request);
      const probe = targetProbe(request);
      if (probe !== undefined) return probe;
      if (request.args?.includes("--list")) {
        return result(request, { stdout: "host tcp:8081 tcp:8081\n" });
      }
      return result(request);
    });
    deps.detectProject = async () => ({
      root: "/workspace/app",
      presetEvidence: [],
      packageManager: {
        name: "npm",
        executable: "/bin/npm",
        source: "lockfile",
        conflicts: [],
      },
    });
    deps.probeMetroService = async () => ({
      status: "available",
      endpoint: "http://127.0.0.1:8081",
    });

    const execution = await runDev(
      {
        cwd: "/workspace/app",
        mode: "run",
        preset: "expo",
        command: { executable: "project-start", args: [] },
        reversePorts: [{ device: 8081 }],
        readiness: { all: [] },
        verification: { command: { executable: "verify-app", args: [] } },
        logs: false,
        watch: false,
      },
      {},
      deps,
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.data).toMatchObject({
      status: "completed",
      attachedService: { ownership: "external" },
      verification: { passed: true },
    });
    expect(requests.some(({ executable }) => executable === "verify-app")).toBeTrue();
    expect(requests.some(({ executable }) => executable === "project-start")).toBeFalse();
    expect(requests.some(({ args }) => args?.includes("--remove"))).toBeFalse();
  });

  test("reports a degraded attached session when its external Metro server disappears", async () => {
    const requests: ProcessRequest[] = [];
    let mapped = false;
    let metroProbes = 0;
    const deps = dependencies(async (request) => {
      requests.push(request);
      const probe = targetProbe(request);
      if (probe !== undefined) return probe;
      const args = request.args ?? [];
      if (args.includes("get-state")) return result(request, { stdout: "device\n" });
      if (args.includes("--no-rebind")) {
        mapped = true;
        return result(request);
      }
      if (args.includes("--remove")) {
        mapped = false;
        return result(request);
      }
      if (args.includes("--list")) {
        return result(request, { stdout: mapped ? "host tcp:8081 tcp:8081\n" : "" });
      }
      return result(request);
    });
    deps.detectProject = async () => ({
      root: "/workspace/app",
      presetEvidence: [],
      packageManager: {
        name: "npm",
        executable: "/bin/npm",
        source: "lockfile",
        conflicts: [],
      },
    });
    deps.probeMetroService = async () => {
      metroProbes += 1;
      return metroProbes === 1
        ? { status: "available", endpoint: "http://127.0.0.1:8081" }
        : { status: "unavailable", endpoint: "http://127.0.0.1:8081" };
    };
    deps.sleep = async () => true;

    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "expo",
        command: { executable: "project-start", args: [] },
        reversePorts: [{ device: 8081 }],
        readiness: { all: [] },
        logs: false,
        watchIntervalMs: 1,
        recovery: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
      },
      {},
      deps,
    );

    expect(requests.some(({ executable }) => executable === "project-start")).toBeFalse();
    expect(metroProbes).toBe(3);
    expect(mapped).toBeFalse();
    expect(execution.result.data).toMatchObject({
      status: "failed",
      attachedService: { kind: "metro", ownership: "external" },
      recovery: { checks: 2, recoveryAttempts: 1, recoveries: 0, failed: true },
    });
    expect(execution.result.problems).toContainEqual(
      expect.objectContaining({ code: ProblemCode.SessionRecoveryFailed }),
    );
    expect(
      execution.result.data?.journal.events.find(({ type }) => type === "session.degraded")?.data
        ?.health,
    ).toMatchObject({ serviceReady: false });
  });

  test("fails safely at every target and reverse-port preflight boundary", async () => {
    const options = {
      cwd: "/workspace/app",
      preset: "custom" as const,
      command: { executable: "dev-server", args: [] },
      reversePorts: [{ device: 8081 }],
      logs: false,
    };
    const missingDependencies = dependencies(async (request) => result(request));
    missingDependencies.locateAdb = async () => undefined;
    const missing = await runDev(options, {}, missingDependencies);
    expect(missing.exitCode).toBe(ExitCode.Environment);
    expect(missing.result.problems[0]?.code).toBe(ProblemCode.AdbNotFound);

    const devices = await runDev(
      options,
      {},
      dependencies(async (request) =>
        request.args?.includes("devices")
          ? result(request, { exitCode: 1, stderr: "server unavailable" })
          : result(request),
      ),
    );
    expect(devices.exitCode).toBe(ExitCode.AdbOperation);

    const interrupted = await runDev(
      options,
      {},
      dependencies(async (request) => {
        if (request.args?.includes("devices")) {
          return result(request, {
            stdout: "List of devices attached\nUSB-1 device model:Pixel_9 transport_id:7\n",
          });
        }
        if (request.args?.includes("mdns")) {
          return result(request, { exitCode: null, signal: "SIGTERM", aborted: true });
        }
        if (request.args?.includes("ro.serialno")) return result(request, { stdout: "PHONE-1\n" });
        if (request.args?.includes("host-features"))
          return result(request, { stdout: "shell_v2\n" });
        return result(request);
      }),
    );
    expect(interrupted.exitCode).toBe(ExitCode.Interrupted);

    const noTarget = await runDev(
      options,
      {},
      dependencies(async (request) =>
        request.args?.includes("devices")
          ? result(request, { stdout: "List of devices attached\n" })
          : result(request, {
              stdout: request.args?.includes("mdns") ? "List of discovered mdns services\n" : "",
            }),
      ),
    );
    expect(noTarget.exitCode).toBe(ExitCode.Target);

    const reverse = await runDev(
      options,
      {},
      dependencies(async (request) => {
        const probe = targetProbe(request);
        if (probe !== undefined) return probe;
        return request.args?.includes("--list")
          ? result(request, { exitCode: 1, stderr: "reverse unavailable" })
          : result(request);
      }),
    );
    expect(reverse.exitCode).toBe(ExitCode.AdbOperation);
    expect(reverse.result.problems.at(-1)?.code).toBe(ProblemCode.AdbCommandFailed);
  });

  test("continues when optional session persistence cannot be initialized", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-session-unavailable-"));
    try {
      const blocked = path.join(root, "not-a-directory");
      await writeFile(blocked, "fixture");
      const execution = await runDev(
        {
          cwd: "/workspace/app",
          preset: "custom",
          command: { executable: "dev-server", args: [] },
          reversePorts: [],
          logs: false,
          watch: false,
          sessionStore: { directory: path.join(blocked, "sessions") },
        },
        {},
        dependencies(async (request) => targetProbe(request) ?? result(request)),
      );
      expect(execution.result.data?.status).toBe("completed");
      expect(execution.result.problems).toContainEqual(
        expect.objectContaining({
          code: ProblemCode.SessionPersistenceFailed,
          severity: "warning",
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("builds an offline project plan without resolving ADB or a target", async () => {
    let processCalled = false;
    const deps = dependencies(async (request) => {
      processCalled = true;
      return result(request);
    });
    deps.locateAdb = async () => {
      throw new Error("ADB must not be resolved for an offline plan");
    };
    const execution = await runDevOfflinePlan(
      {
        cwd: "/workspace/app",
        preset: "custom",
        command: { executable: "node", args: ["server.mjs"] },
        reversePorts: [{ device: 8081 }],
      },
      deps,
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(processCalled).toBeFalse();
    expect(execution.result.data).toMatchObject({
      status: "planned",
      planScope: "offline",
      plan: {
        dryRun: true,
        steps: [
          { id: "acquire-target" },
          { id: "reverse-1" },
          { id: "start-child", executable: "node", args: ["server.mjs"] },
        ],
      },
    });
    expect(execution.result.data).not.toHaveProperty("selected");
  });

  test("owns one target, streams a redacted journal, and cleans only its reverse mapping", async () => {
    const requests: ProcessRequest[] = [];
    const lines: string[] = [];
    let mapped = false;
    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "custom",
        command: { executable: "dev-server", args: ["serve"] },
        reversePorts: [{ device: 8081 }],
        childStdin: "inherit",
        onChildLine: (stream, line) => lines.push(`${stream}:${line}`),
      },
      {},
      dependencies(async (request) => {
        requests.push(request);
        const probe = targetProbe(request);
        if (probe !== undefined) return probe;
        const args = request.args ?? [];
        if (args.includes("logcat")) {
          const line = "09-10 10:00:00.000  100  101 E ReactNativeJS: token=secret-value\n";
          request.onStdoutChunk?.(new TextEncoder().encode(line));
          return result(request, {
            stdout: line,
          });
        }
        if (args.includes("--no-rebind")) {
          mapped = true;
          return result(request);
        }
        if (args.includes("--remove")) {
          mapped = false;
          return result(request);
        }
        if (args.includes("--list")) {
          return result(request, { stdout: mapped ? "host tcp:8081 tcp:8081\n" : "" });
        }
        if (request.executable === "dev-server") {
          request.onStdoutChunk?.(new TextEncoder().encode("ready\npassword=hunter2\n"));
          request.onStderrChunk?.(new TextEncoder().encode("stderr is not failure\n"));
          return result(request, {
            stdout: "ready\npassword=hunter2\n",
            stderr: "stderr is not failure\n",
          });
        }
        return result(request);
      }),
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.data).toMatchObject({
      status: "completed",
      selected: { transport: { serial: "USB-1", transportId: "7" } },
      ports: {
        requested: [{ device: "tcp:8081", host: "tcp:8081" }],
        created: [{ device: "tcp:8081", host: "tcp:8081" }],
        reused: [],
        cleaned: true,
      },
      child: { exitCode: 0 },
    });
    const childRequest = requests.find(({ executable }) => executable === "dev-server");
    expect(childRequest).toMatchObject({
      args: ["serve"],
      cwd: path.resolve("/workspace/app"),
      stdin: "inherit",
      env: { ANDROID_SERIAL: "USB-1" },
    });
    expect(lines).toEqual([
      "stdout:ready",
      "stdout:password=[REDACTED]",
      "stderr:stderr is not failure",
    ]);
    const logcatRequest = requests.find(({ args }) => args?.includes("logcat"));
    const logStart = logcatRequest?.args?.indexOf("-T") ?? -1;
    expect(logStart).toBeGreaterThan(-1);
    expect(logcatRequest?.args?.[logStart + 1]).toBe("1");
    const serializedJournal = JSON.stringify(execution.result.data?.journal.events);
    expect(serializedJournal).not.toContain("hunter2");
    expect(serializedJournal).not.toContain("secret-value");
    expect(serializedJournal).toContain("child.stdout");
    expect(serializedJournal).toContain("log.record");
    expect(
      execution.result.data?.journal.events.find(({ type }) => type === "child.started")?.data
        ?.preset,
    ).toBe("custom");
    expect(
      execution.result.data?.journal.events
        .filter(({ type }) => type === "session.state.changed")
        .map(({ data }) => data?.to),
    ).toEqual([
      "acquiring-target",
      "preparing-ports",
      "starting-child",
      "ready",
      "stopping",
      "ended",
    ]);
    expect(execution.result.problems).toContainEqual(
      expect.objectContaining({ code: "REACT_NATIVE_FATAL", severity: "warning" }),
    );
  });

  test("does not mark a session ready until every configured readiness assertion passes", async () => {
    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "custom",
        command: { executable: "dev-server", args: [] },
        reversePorts: [],
        logs: false,
        watch: false,
        readiness: { all: [{ kind: "boot" }], timeoutMs: 500 },
      },
      {},
      dependencies(async (request) => {
        const probe = targetProbe(request);
        if (probe !== undefined) return probe;
        if (request.args?.includes("sys.boot_completed")) {
          return result(request, { stdout: "1\n" });
        }
        if (request.executable === "dev-server") {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return result(request);
      }),
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.data?.readiness).toMatchObject({
      ready: true,
      assertions: [{ assertion: { kind: "boot" }, status: "passed" }],
    });
    const events = execution.result.data?.journal.events.map(({ type }) => type) ?? [];
    expect(
      execution.result.data?.journal.events.filter(({ source }) => source === "adb.shell"),
    ).toHaveLength(0);
    expect(events.indexOf("readiness.passed")).toBeLessThan(events.indexOf("child.exited"));
  });

  test("fails with structured evidence when a required readiness capability is unsupported", async () => {
    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "custom",
        command: { executable: "dev-service", args: [] },
        reversePorts: [],
        logs: false,
        watch: false,
        readiness: {
          all: [{ kind: "ui", selector: "text=Ready" }],
          timeoutMs: 100,
          pollIntervalMs: 10,
        },
      },
      {},
      dependencies(async (request) => {
        const probe = targetProbe(request);
        if (probe !== undefined) return probe;
        if (request.args?.includes("uiautomator")) {
          return result(request, { stdout: "UI hierarchy unavailable" });
        }
        if (request.executable === "dev-service") {
          return await new Promise<ProcessResult>((resolve) => {
            request.signal?.addEventListener(
              "abort",
              () => resolve(result(request, { exitCode: null, signal: "SIGTERM", aborted: true })),
              { once: true },
            );
          });
        }
        return result(request);
      }),
    );

    expect(execution.exitCode).toBe(ExitCode.AdbOperation);
    expect(execution.result.problems).toContainEqual(
      expect.objectContaining({ code: ProblemCode.ReadinessUnsupported }),
    );
    expect(execution.result.data?.readiness?.assertions).toMatchObject([
      { assertion: { kind: "ui", selector: "text=Ready" }, status: "unsupported" },
    ]);
  });

  test("runs one bounded verification command and intentionally stops the development service", async () => {
    let verificationRequest: ProcessRequest | undefined;
    const verificationLines: string[] = [];
    const execution = await runDev(
      {
        cwd: "/workspace/app",
        mode: "run",
        preset: "custom",
        command: { executable: "dev-service", args: ["start"] },
        verification: {
          command: {
            executable: "smoke-test",
            args: ["--device={target.serial}", "--ci"],
          },
          timeoutMs: 30_000,
        },
        reversePorts: [],
        logs: false,
        watch: false,
        onChildLine: (stream, line) => verificationLines.push(`${stream}:${line}`),
      },
      {},
      dependencies(async (request) => {
        const probe = targetProbe(request);
        if (probe !== undefined) return probe;
        if (request.executable === "dev-service") {
          return await new Promise<ProcessResult>((resolve) => {
            request.signal?.addEventListener(
              "abort",
              () => resolve(result(request, { exitCode: null, signal: "SIGTERM", aborted: true })),
              { once: true },
            );
          });
        }
        if (request.executable === "smoke-test") {
          verificationRequest = request;
          request.onStdoutChunk?.(new TextEncoder().encode("assertion passed\n"));
          request.onStderrChunk?.(new TextEncoder().encode("diagnostic warning\n"));
          return result(request);
        }
        return result(request);
      }),
    );

    expect(execution.result.command).toBe("run");
    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.problems).toEqual([]);
    expect(execution.result.data).toMatchObject({
      status: "completed",
      verification: {
        passed: true,
        exitCode: 0,
        command: { executable: "smoke-test", args: ["--device=USB-1", "--ci"] },
      },
    });
    expect(verificationRequest).toMatchObject({
      args: ["--device=USB-1", "--ci"],
      env: { ADB_READY_TARGET_SERIAL: "USB-1", ANDROID_SERIAL: "USB-1" },
    });
    expect(verificationLines).toEqual(["stdout:assertion passed", "stderr:diagnostic warning"]);
  });

  test("preserves a failed bounded verification command exit code", async () => {
    const execution = await runDev(
      {
        cwd: "/workspace/app",
        mode: "run",
        preset: "custom",
        command: { executable: "dev-service", args: [] },
        verification: { command: { executable: "smoke-test", args: [] } },
        reversePorts: [],
        logs: false,
        watch: false,
      },
      {},
      dependencies(async (request) => {
        const probe = targetProbe(request);
        if (probe !== undefined) return probe;
        if (request.executable === "dev-service") {
          return await new Promise<ProcessResult>((resolve) => {
            request.signal?.addEventListener(
              "abort",
              () => resolve(result(request, { exitCode: null, signal: "SIGTERM", aborted: true })),
              { once: true },
            );
          });
        }
        if (request.executable === "smoke-test") return result(request, { exitCode: 9 });
        return result(request);
      }),
    );

    expect(execution.exitCode).toBe(9);
    expect(execution.result.data?.verification).toMatchObject({ passed: false, exitCode: 9 });
    expect(execution.result.problems).toContainEqual(
      expect.objectContaining({ code: ProblemCode.VerificationFailed }),
    );
  });

  test("does not diagnose intentional run teardown as a recovery degradation", async () => {
    let mapped = false;
    let healthProbeStarted: (() => void) | undefined;
    const healthProbe = new Promise<void>((resolve) => {
      healthProbeStarted = resolve;
    });
    const deps = dependencies(async (request) => {
      const probe = targetProbe(request);
      if (probe !== undefined) return probe;
      const args = request.args ?? [];
      if (args.includes("--no-rebind")) mapped = true;
      if (args.includes("--remove")) mapped = false;
      if (args.includes("--list")) {
        return result(request, { stdout: mapped ? "host tcp:8181 tcp:8181\n" : "" });
      }
      if (args.includes("get-state")) {
        healthProbeStarted?.();
        return await new Promise<ProcessResult>((resolve) => {
          const aborted = () =>
            resolve(result(request, { exitCode: null, signal: "SIGTERM", aborted: true }));
          if (request.signal?.aborted === true) aborted();
          else request.signal?.addEventListener("abort", aborted, { once: true });
        });
      }
      if (request.executable === "dev-service") {
        return await new Promise<ProcessResult>((resolve) => {
          request.signal?.addEventListener(
            "abort",
            () => resolve(result(request, { exitCode: null, signal: "SIGTERM", aborted: true })),
            { once: true },
          );
        });
      }
      if (request.executable === "smoke-test") {
        await healthProbe;
        return result(request, {
          exitCode: null,
          signal: "SIGTERM",
          timedOut: true,
        });
      }
      return result(request);
    });
    deps.sleep = async () => true;

    const execution = await runDev(
      {
        cwd: "/workspace/app",
        mode: "run",
        preset: "custom",
        command: { executable: "dev-service", args: [] },
        verification: { command: { executable: "smoke-test", args: [] }, timeoutMs: 1_000 },
        reversePorts: [{ device: 8181 }],
        logs: false,
        watchIntervalMs: 1,
        recovery: { initialDelayMs: 1, maxDelayMs: 1 },
      },
      {},
      deps,
    );

    expect(execution.result.data).toMatchObject({
      status: "failed",
      ports: { cleaned: true },
      verification: { passed: false, timedOut: true },
      recovery: {
        checks: 0,
        degradations: 0,
        recoveryAttempts: 0,
        recoveries: 0,
        failed: false,
      },
    });
    expect(execution.result.problems).toContainEqual(
      expect.objectContaining({ code: ProblemCode.VerificationFailed }),
    );
    expect(execution.result.problems).not.toContainEqual(
      expect.objectContaining({ code: ProblemCode.SessionRecoveryFailed }),
    );
    expect(execution.result.data?.journal.events.map(({ type }) => type)).not.toContain(
      "session.degraded",
    );
    expect(execution.result.data?.journal.events).not.toContainEqual(
      expect.objectContaining({
        type: "operation.failed",
        data: expect.objectContaining({ presentation: "background", aborted: true }),
      }),
    );
  });

  test("persists a finalized private session when storage is enabled", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-dev-session-"));
    try {
      const execution = await runDev(
        {
          cwd: "/workspace/app",
          preset: "custom",
          command: { executable: "dev-server", args: [] },
          reversePorts: [],
          logs: false,
          watch: false,
          sessionStore: { directory },
        },
        {},
        dependencies(async (request) => targetProbe(request) ?? result(request)),
      );

      const sessions = await listSessions({ directory });
      expect(sessions).toMatchObject({
        ok: true,
        value: [{ sessionId: execution.result.data?.sessionId, status: "completed" }],
      });
      const events = await readSessionEvents(execution.result.data?.sessionId ?? "", {
        directory,
      });
      expect(events.ok).toBeTrue();
      if (events.ok) {
        const serialized = JSON.stringify(events.value);
        expect(serialized).not.toContain("USB-1");
        expect(serialized).not.toContain("PHONE-1");
        expect(events.value.at(-1)?.type).toBe("command.completed");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("dry-run plans ports and the child without mutating or starting either", async () => {
    const requests: ProcessRequest[] = [];
    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "custom",
        command: { executable: "node", args: ["server.mjs"] },
        reversePorts: [{ device: 8081 }, { device: 3000, host: 4000 }],
        verification: {
          command: { executable: "smoke-test", args: ["--device={target.serial}"] },
        },
      },
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
          { args: ["-t", "7", "reverse", "--no-rebind", "tcp:8081", "tcp:8081"] },
          { args: ["-t", "7", "reverse", "--no-rebind", "tcp:3000", "tcp:4000"] },
          { id: "start-child", executable: "node", args: ["server.mjs"] },
          { id: "run-verification", executable: "smoke-test", args: ["--device=USB-1"] },
        ],
      },
    });
    expect(requests.some(({ args }) => args?.includes("--no-rebind"))).toBe(false);
    expect(requests.some(({ executable }) => executable === "node")).toBe(false);
  });

  test("preserves the child exit code and still cleans a created mapping", async () => {
    let mapped = false;
    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "custom",
        command: { executable: "broken-dev", args: [] },
        reversePorts: [{ device: 8081 }],
        logs: false,
      },
      {},
      dependencies(async (request) => {
        const probe = targetProbe(request);
        if (probe !== undefined) return probe;
        const args = request.args ?? [];
        if (args.includes("--no-rebind")) mapped = true;
        if (args.includes("--remove")) mapped = false;
        if (args.includes("--list")) {
          return result(request, { stdout: mapped ? "host tcp:8081 tcp:8081\n" : "" });
        }
        if (request.executable === "broken-dev") {
          const stderr = "CommandError: required development build is not installed\n";
          request.onStderrChunk?.(new TextEncoder().encode(stderr));
          return result(request, { exitCode: 17, stderr });
        }
        return result(request);
      }),
    );
    expect(execution.exitCode).toBe(17);
    expect(execution.result.problems.at(-1)?.code).toBe(ProblemCode.ChildProcessFailed);
    expect(execution.result.problems.at(-1)).toMatchObject({
      summary: "The development command failed before the session became ready.",
      detail: "CommandError: required development build is not installed",
      evidence: expect.arrayContaining([
        {
          source: "child",
          field: "diagnostic",
          value: "CommandError: required development build is not installed",
        },
      ]),
    });
    expect(execution.result.data?.reachedReady).toBeFalse();
    expect(
      execution.result.data?.journal.events.some(
        ({ type, data }) => type === "session.state.changed" && data?.to === "ready",
      ),
    ).toBeFalse();
    expect(execution.result.data?.ports.cleaned).toBe(true);
  });

  test("stops before mutation when an existing mapping conflicts", async () => {
    const requests: ProcessRequest[] = [];
    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "custom",
        command: { executable: "dev-server", args: [] },
        reversePorts: [{ device: 8081, host: 3000 }],
      },
      {},
      dependencies(async (request) => {
        requests.push(request);
        return (
          targetProbe(request) ??
          result(request, {
            stdout: request.args?.includes("--list") ? "host tcp:8081 tcp:9000\n" : "",
          })
        );
      }),
    );
    expect(execution.result.problems.at(-1)?.code).toBe(ProblemCode.PortMappingConflict);
    expect(requests.some(({ args }) => args?.includes("--no-rebind"))).toBe(false);
    expect(requests.some(({ executable }) => executable === "dev-server")).toBe(false);
  });

  test("plans first-party Expo and React Native presets with their project manager", async () => {
    for (const fixture of [
      {
        preset: "expo" as const,
        manager: "npm" as const,
        script: "start",
        expected: ["run", "start"],
      },
      {
        preset: "react-native" as const,
        manager: "pnpm" as const,
        script: "android",
        expected: ["run", "android"],
      },
    ]) {
      const deps = dependencies(async (request) => targetProbe(request) ?? result(request));
      deps.detectProject = async () => ({
        root: "/workspace/app",
        preset: fixture.preset,
        presetEvidence: [`dependency: ${fixture.preset}`],
        packageJson: {
          path: "/workspace/app/package.json",
          scripts: { [fixture.script]: "fixture" },
        },
        packageManager: {
          name: fixture.manager,
          executable: `/bin/${fixture.manager}`,
          source: "package-json",
          conflicts: [],
        },
      });
      const execution = await runDev({ cwd: "/workspace/app" }, { dryRun: true }, deps);
      expect(execution.result.data).toMatchObject({
        preset: fixture.preset,
        ports: { requested: [{ device: "tcp:8081", host: "tcp:8081" }] },
        command: { executable: `/bin/${fixture.manager}`, args: fixture.expected },
      });
    }
  });

  test("plans direct framework binaries for every supported JavaScript package manager", async () => {
    const fixtures = [
      {
        preset: "expo" as const,
        manager: "npm" as const,
        args: ["exec", "--", "expo", "start"],
      },
      {
        preset: "expo" as const,
        manager: "bun" as const,
        args: ["x", "expo", "start"],
      },
      {
        preset: "react-native" as const,
        manager: "yarn" as const,
        args: ["react-native", "run-android"],
      },
      {
        preset: "capacitor" as const,
        manager: "pnpm" as const,
        args: ["exec", "cap", "run", "android", "--target", "<selected-target>"],
      },
    ];
    for (const fixture of fixtures) {
      const deps = dependencies(async (request) => result(request));
      deps.detectProject = async () => ({
        root: "/workspace/app",
        preset: fixture.preset,
        presetEvidence: [],
        packageManager: {
          name: fixture.manager,
          executable: `/bin/${fixture.manager}`,
          source: "config",
          conflicts: [],
        },
      });
      const execution = await runDevOfflinePlan({ cwd: "/workspace/app" }, deps);
      expect(execution.exitCode).toBe(ExitCode.Success);
      expect(execution.result.data?.command).toMatchObject({
        executable: `/bin/${fixture.manager}`,
        args: fixture.args,
      });
    }
  });

  test("rejects incomplete or conflicting offline development definitions", async () => {
    const fixtures: Array<{
      project: ProjectDetection;
      options: { cwd: string; preset?: "custom" };
      code: string;
    }> = [
      {
        project: { root: "/workspace/app", presetEvidence: [], packageManager: { conflicts: [] } },
        options: { cwd: "/workspace/app" },
        code: ProblemCode.DevPresetNotFound,
      },
      {
        project: {
          root: "/workspace/app",
          preset: "expo" as const,
          presetEvidence: [],
          packageManager: {
            name: "npm" as const,
            executable: "/bin/npm",
            source: "lockfile" as const,
            conflicts: ["npm", "pnpm"],
          },
        },
        options: { cwd: "/workspace/app" },
        code: ProblemCode.PackageManagerConflict,
      },
      {
        project: {
          root: "/workspace/app",
          preset: "react-native" as const,
          presetEvidence: [],
          packageManager: { name: "npm" as const, source: "lockfile" as const, conflicts: [] },
        },
        options: { cwd: "/workspace/app" },
        code: ProblemCode.PackageManagerNotFound,
      },
      {
        project: {
          root: "/workspace/app",
          preset: "custom" as const,
          presetEvidence: [],
          packageManager: { conflicts: [] },
        },
        options: { cwd: "/workspace/app", preset: "custom" as const },
        code: ProblemCode.DevCommandNotFound,
      },
    ];
    for (const fixture of fixtures) {
      const deps = dependencies(async (request) => result(request));
      deps.detectProject = async () => fixture.project;
      const execution = await runDevOfflinePlan(fixture.options, deps);
      expect(execution.exitCode).not.toBe(ExitCode.Success);
      expect(execution.result.data).toBeNull();
      expect(execution.result.problems).toContainEqual(
        expect.objectContaining({ code: fixture.code }),
      );
    }
  });

  test("reports unavailable native framework launchers with actionable evidence", async () => {
    const nativeFixtures = [
      {
        preset: "flutter" as const,
        locate: async () => undefined,
        summary: "The Flutter executable was not found.",
        attemptedField: "attemptedExecutable",
      },
      {
        preset: "gradle" as const,
        locate: async () => undefined,
        summary: "No runnable Gradle Wrapper was found.",
        attemptedField: "attemptedLaunchers",
      },
    ];
    for (const fixture of nativeFixtures) {
      const root = await mkdtemp(path.join(tmpdir(), `adb-ready-${fixture.preset}-`));
      try {
        const deps = dependencies(async (request) => result(request));
        deps.detectProject = async () => ({
          root,
          preset: fixture.preset,
          presetEvidence: [],
          packageManager: { conflicts: [] },
        });
        deps.locateExecutable = fixture.locate;
        const execution = await runDevOfflinePlan({ cwd: root }, deps);
        expect(execution.exitCode).toBe(ExitCode.Environment);
        expect(execution.result.problems).toContainEqual(
          expect.objectContaining({
            code: ProblemCode.FrameworkLauncherNotFound,
            category: "environment.framework",
            summary: fixture.summary,
            evidence: expect.arrayContaining([
              expect.objectContaining({
                source: "project",
                field: "preset",
                value: fixture.preset,
              }),
              expect.objectContaining({ field: fixture.attemptedField }),
            ]),
            actions: [expect.objectContaining({ kind: "documentation", automatic: false })],
          }),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    const explicitFlutterDeps = dependencies(async (request) => result(request));
    explicitFlutterDeps.detectProject = async () => ({
      root: "/workspace/empty",
      presetEvidence: [],
      packageManager: { conflicts: [] },
    });
    explicitFlutterDeps.locateExecutable = async () => undefined;
    const explicitFlutter = await runDevOfflinePlan(
      { cwd: "/workspace/empty", preset: "flutter" },
      explicitFlutterDeps,
    );
    expect(explicitFlutter.result.problems).toContainEqual(
      expect.objectContaining({
        code: ProblemCode.FrameworkLauncherNotFound,
        evidence: expect.arrayContaining([
          expect.objectContaining({ field: "preset", value: "flutter" }),
        ]),
      }),
    );

    const customDeps = dependencies(async (request) => result(request));
    customDeps.detectProject = async () => ({
      root: "/workspace/custom",
      preset: "custom",
      presetEvidence: [],
      packageManager: { conflicts: [] },
    });
    const custom = await runDevOfflinePlan(
      { cwd: "/workspace/custom", preset: "custom" },
      customDeps,
    );
    expect(custom.result.problems).toContainEqual(
      expect.objectContaining({ code: ProblemCode.DevCommandNotFound }),
    );
  });

  test("rejects malformed reverse ports offline", async () => {
    const deps = dependencies(async (request) => result(request));
    const execution = await runDevOfflinePlan(
      {
        cwd: "/workspace/app",
        preset: "custom",
        command: { executable: "node", args: [] },
        reversePorts: [{ device: 0 }, { device: 8081, host: 70_000 }],
      },
      deps,
    );
    expect(execution.result.problems.map(({ code }) => code)).toEqual([
      ProblemCode.InvalidPort,
      ProblemCode.InvalidPort,
    ]);
  });

  test("produces a complete redacted offline plan with hooks, readiness, and verification", async () => {
    const deps = dependencies(async (request) => result(request));
    deps.detectProject = async () => ({
      root: "/Users/adam/private-app",
      preset: "custom",
      presetEvidence: [],
      packageJson: {
        path: "/Users/adam/private-app/package.json",
        name: "private-app",
        scripts: {},
      },
      packageManager: {
        name: "bun",
        executable: "/opt/bin/bun",
        source: "package-json",
        conflicts: [],
      },
    });
    const execution = await runDevOfflinePlan(
      {
        cwd: "/Users/adam/private-app",
        command: {
          executable: "/Users/adam/private-app/node_modules/.bin/expo",
          args: ["start", "token=secret-value"],
          cwd: "mobile",
          env: { PUBLIC_MODE: "demo", API_TOKEN: "secret-value" },
        },
        reversePorts: [
          { device: 8081, host: 3000 },
          { device: 8081, host: 3000 },
        ],
        hooks: {
          beforeDev: [{ run: ["node", "before.mjs"] }],
          onTargetReady: [{ run: ["node", "target.mjs"] }],
          onPortsReady: [{ run: ["node", "ports.mjs"] }],
          onReady: [{ run: ["node", "ready.mjs"] }],
          onChildExit: [{ run: ["node", "exit.mjs"] }],
          finally: [{ run: ["node", "finally.mjs"] }],
        },
        readiness: { all: [{ kind: "boot" }, { kind: "host-port", port: 3000 }] },
        verification: { command: { executable: "node", args: ["verify.mjs"] } },
      },
      deps,
    );
    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.data).toMatchObject({
      status: "planned",
      project: { name: "private-app" },
      packageManager: { name: "bun", source: "package-json" },
      ports: { requested: [{ device: "tcp:8081", host: "tcp:3000" }] },
      command: {
        cwd: path.resolve("/Users/adam/private-app", "mobile"),
        envKeys: ["ANDROID_SERIAL", "API_TOKEN", "PUBLIC_MODE"],
      },
    });
    expect(execution.result.data?.plan?.steps.map(({ id }) => id)).toEqual([
      "acquire-target",
      "hook-beforeDev-1",
      "hook-onTargetReady-1",
      "reverse-1",
      "hook-onPortsReady-1",
      "start-child",
      "ready-1",
      "ready-2",
      "hook-onReady-1",
      "run-verification",
      "hook-onChildExit-1",
      "hook-finally-1",
    ]);
    expect(JSON.stringify(execution.result.data)).not.toContain("secret-value");
  });

  test("runs the native Gradle wrapper through Java without a command shell", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-gradle-"));
    try {
      const wrapper = path.join(root, "gradle", "wrapper", "gradle-wrapper.jar");
      await mkdir(path.dirname(wrapper), { recursive: true });
      await writeFile(wrapper, "fixture");
      const deps = dependencies(async (request) => targetProbe(request) ?? result(request));
      deps.detectProject = async () => ({
        root,
        preset: "gradle",
        presetEvidence: ["Gradle wrapper"],
        packageManager: { conflicts: [] },
      });
      deps.locateExecutable = async (name) => (name === "java" ? "/jdk/bin/java" : undefined);
      const execution = await runDev({ cwd: root }, { dryRun: true }, deps);
      expect(execution.result.data).toMatchObject({
        preset: "gradle",
        command: {
          executable: "/jdk/bin/java",
          args: ["-classpath", wrapper, "org.gradle.wrapper.GradleWrapperMain", "installDebug"],
        },
        ports: { requested: [] },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("binds Flutter and Capacitor commands to the selected Android target", async () => {
    const flutterDeps = dependencies(async (request) => targetProbe(request) ?? result(request));
    flutterDeps.detectProject = async () => ({
      root: "/workspace/flutter",
      preset: "flutter",
      presetEvidence: ["Flutter pubspec.yaml"],
      packageManager: { conflicts: [] },
    });
    flutterDeps.locateExecutable = async (name) =>
      name === "flutter" ? "/sdk/flutter/bin/flutter" : undefined;
    const flutter = await runDev({ cwd: "/workspace/flutter" }, { dryRun: true }, flutterDeps);
    expect(flutter.result.data).toMatchObject({
      preset: "flutter",
      ports: { requested: [] },
      command: {
        executable: "/sdk/flutter/bin/flutter",
        args: ["run", "-d", "USB-1"],
      },
    });
    expect(flutter.result.data?.plan?.steps).toContainEqual(
      expect.objectContaining({ id: "ready-1", title: "Verify boot readiness" }),
    );

    const capacitorDeps = dependencies(async (request) => targetProbe(request) ?? result(request));
    capacitorDeps.detectProject = async () => ({
      root: "/workspace/capacitor",
      preset: "capacitor",
      presetEvidence: ["package.json dependency: Capacitor"],
      packageManager: {
        name: "pnpm",
        executable: "/bin/pnpm",
        source: "package-json",
        conflicts: [],
      },
    });
    const capacitor = await runDev(
      { cwd: "/workspace/capacitor" },
      { dryRun: true },
      capacitorDeps,
    );
    expect(capacitor.result.data).toMatchObject({
      preset: "capacitor",
      ports: { requested: [] },
      command: {
        executable: "/bin/pnpm",
        args: ["exec", "cap", "run", "android", "--target", "USB-1"],
      },
    });
  });

  test("runs lifecycle hooks in session order with direct arguments and reports warnings", async () => {
    const calls: string[] = [];
    let mapped = false;
    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "custom",
        command: { executable: "dev-server", args: [] },
        reversePorts: [{ device: 8081 }],
        logs: false,
        hooks: {
          beforeDev: [{ run: ["hook", "before", "literal;$(safe)"] }],
          onTargetReady: [{ run: ["hook", "target"] }],
          onPortsReady: [{ run: ["hook", "ports"] }],
          onReady: [{ run: ["hook", "ready"], failure: "warn" }],
          onChildExit: [{ run: ["hook", "exit"] }],
          finally: [{ run: ["hook", "finally"] }],
        },
      },
      {},
      dependencies(async (request) => {
        const probe = targetProbe(request);
        if (probe !== undefined) return probe;
        const args = request.args ?? [];
        if (request.executable === "hook") {
          calls.push(`hook:${args[0]}`);
          return result(request, args[0] === "ready" ? { exitCode: 7 } : {});
        }
        if (args.includes("--no-rebind")) {
          calls.push("port:add");
          mapped = true;
        }
        if (args.includes("--remove")) {
          calls.push("port:remove");
          mapped = false;
        }
        if (args.includes("--list")) {
          return result(request, { stdout: mapped ? "host tcp:8081 tcp:8081\n" : "" });
        }
        if (request.executable === "dev-server") calls.push("child:start");
        return result(request);
      }),
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.data?.hooks).toEqual({ completed: 5, failed: 1 });
    expect(execution.result.problems).toContainEqual(
      expect.objectContaining({ code: ProblemCode.HookFailed, severity: "warning" }),
    );
    expect(calls).toEqual([
      "hook:before",
      "hook:target",
      "port:add",
      "hook:ports",
      "child:start",
      "hook:ready",
      "hook:exit",
      "port:remove",
      "hook:finally",
    ]);
  });

  test("forwards session cancellation to the child, cleans ports, and exits as interrupted", async () => {
    const controller = new AbortController();
    let mapped = false;
    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "custom",
        command: { executable: "long-running", args: [] },
        reversePorts: [{ device: 8081 }],
        logs: false,
      },
      {},
      dependencies(async (request) => {
        const probe = targetProbe(request);
        if (probe !== undefined) return probe;
        const args = request.args ?? [];
        if (args.includes("--no-rebind")) mapped = true;
        if (args.includes("--remove")) mapped = false;
        if (args.includes("--list")) {
          return result(request, { stdout: mapped ? "host tcp:8081 tcp:8081\n" : "" });
        }
        if (request.executable === "long-running") {
          controller.abort();
          return result(request, { exitCode: null, signal: "SIGTERM", aborted: true });
        }
        return result(request);
      }),
      controller.signal,
    );

    expect(execution.exitCode).toBe(ExitCode.Interrupted);
    expect(execution.result.problems.at(-1)?.code).toBe(ProblemCode.OperationInterrupted);
    expect(execution.result.data?.status).toBe("interrupted");
    expect(execution.result.data?.ports.cleaned).toBe(true);
    expect(
      execution.result.data?.journal.events
        .filter(({ type }) => type === "session.state.changed")
        .map(({ data }) => data?.to),
    ).not.toContain("failed");
    expect(execution.result.data?.journal.events.at(-1)).toMatchObject({
      type: "command.interrupted",
      severity: "warning",
    });
  });

  test("restores a lost reverse mapping while the development child stays alive", async () => {
    let mapped = false;
    let childStarted = false;
    let recoveryAdds = 0;
    let resolveChild: ((value: ProcessResult) => void) | undefined;
    let sleepCalls = 0;
    const deps = dependencies(async (request) => {
      const probe = targetProbe(request);
      if (probe !== undefined) return probe;
      const args = request.args ?? [];
      if (args.includes("get-state")) return result(request, { stdout: "device\n" });
      if (args.includes("--no-rebind")) {
        mapped = true;
        if (childStarted) recoveryAdds += 1;
        return result(request);
      }
      if (args.includes("--remove")) {
        mapped = false;
        return result(request);
      }
      if (args.includes("--list")) {
        if (childStarted && recoveryAdds > 0 && mapped) {
          resolveChild?.(result({ executable: "long-running", args: [] }));
        }
        return result(request, { stdout: mapped ? "host tcp:8081 tcp:8081\n" : "" });
      }
      if (request.executable === "long-running") {
        childStarted = true;
        mapped = false;
        return await new Promise<ProcessResult>((resolve) => {
          resolveChild = resolve;
        });
      }
      return result(request);
    });
    deps.sleep = async (_milliseconds, signal) => {
      sleepCalls += 1;
      if (sleepCalls <= 2) return true;
      if (signal.aborted) return false;
      return await new Promise<boolean>((resolve) => {
        signal.addEventListener("abort", () => resolve(false), { once: true });
      });
    };

    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "custom",
        command: { executable: "long-running", args: [] },
        reversePorts: [{ device: 8081 }],
        logs: false,
        watchIntervalMs: 1,
        recovery: { initialDelayMs: 1, maxDelayMs: 1 },
      },
      {},
      deps,
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(recoveryAdds).toBe(1);
    expect(execution.result.data?.recovery).toMatchObject({
      checks: 2,
      degradations: 1,
      recoveryAttempts: 1,
      recoveries: 1,
      failed: false,
    });
    expect(execution.result.data?.journal.events.map(({ type }) => type)).toContain(
      "recovery.completed",
    );
    expect(
      execution.result.data?.journal.events.filter(
        ({ data, type }) => data?.presentation === "background" || type === "health.checked",
      ),
    ).toHaveLength(0);
  });

  test("restarts an unexpectedly ended log stream without restarting the development child", async () => {
    let logStarts = 0;
    let mappingLists = 0;
    let resolveChild: ((value: ProcessResult) => void) | undefined;
    let sleepCalls = 0;
    const deps = dependencies(async (request) => {
      const probe = targetProbe(request);
      if (probe !== undefined) return probe;
      const args = request.args ?? [];
      if (args.includes("logcat")) {
        logStarts += 1;
        if (logStarts === 1) return result(request);
        return await new Promise<ProcessResult>((resolve) => {
          request.signal?.addEventListener(
            "abort",
            () => resolve(result(request, { exitCode: null, signal: "SIGTERM", aborted: true })),
            { once: true },
          );
        });
      }
      if (args.includes("get-state")) return result(request, { stdout: "device\n" });
      if (args.includes("--list")) {
        mappingLists += 1;
        if (mappingLists >= 3 && logStarts >= 2) {
          queueMicrotask(() => resolveChild?.(result({ executable: "long-running", args: [] })));
        }
        return result(request);
      }
      if (request.executable === "long-running") {
        return await new Promise<ProcessResult>((resolve) => {
          resolveChild = resolve;
        });
      }
      return result(request);
    });
    deps.sleep = async (_milliseconds, watchSignal) => {
      sleepCalls += 1;
      if (sleepCalls <= 2) return true;
      if (watchSignal.aborted) return false;
      return await new Promise<boolean>((resolve) => {
        watchSignal.addEventListener("abort", () => resolve(false), { once: true });
      });
    };

    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "custom",
        command: { executable: "long-running", args: [] },
        reversePorts: [],
        watchIntervalMs: 1,
        recovery: { initialDelayMs: 1, maxDelayMs: 1 },
      },
      {},
      deps,
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(logStarts).toBe(2);
    expect(execution.result.data?.recovery).toMatchObject({ recoveries: 1, failed: false });
    expect(execution.result.data?.journal.events.map(({ type }) => type)).toContain(
      "log.stream.failed",
    );
    expect(
      execution.result.data?.journal.events
        .filter(({ type }) => type === "session.state.changed")
        .map(({ data }) => data?.to),
    ).toEqual([
      "acquiring-target",
      "preparing-ports",
      "starting-child",
      "ready",
      "degraded",
      "recovering",
      "ready",
      "stopping",
      "ended",
    ]);
  });

  test("stops the owned child after the bounded recovery budget is exhausted", async () => {
    let mapped = false;
    let childStarted = false;
    const deps = dependencies(async (request) => {
      const probe = targetProbe(request);
      if (probe !== undefined) return probe;
      const args = request.args ?? [];
      if (args.includes("get-state")) return result(request, { stdout: "device\n" });
      if (args.includes("--no-rebind")) {
        if (childStarted) return result(request, { exitCode: 1, stderr: "cannot bind\n" });
        mapped = true;
        return result(request);
      }
      if (args.includes("--remove")) {
        mapped = false;
        return result(request);
      }
      if (args.includes("--list")) {
        return result(request, { stdout: mapped ? "host tcp:8081 tcp:8081\n" : "" });
      }
      if (request.executable === "long-running") {
        childStarted = true;
        mapped = false;
        if (request.signal?.aborted === true) {
          return result(request, { exitCode: null, signal: "SIGTERM", aborted: true });
        }
        return await new Promise<ProcessResult>((resolve) => {
          request.signal?.addEventListener(
            "abort",
            () => resolve(result(request, { exitCode: null, signal: "SIGTERM", aborted: true })),
            { once: true },
          );
        });
      }
      return result(request);
    });
    deps.sleep = async () => true;

    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "custom",
        command: { executable: "long-running", args: [] },
        reversePorts: [{ device: 8081 }],
        logs: false,
        watchIntervalMs: 1,
        recovery: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1 },
      },
      {},
      deps,
    );

    expect(execution.result.data).toMatchObject({
      status: "failed",
      recovery: { recoveryAttempts: 2, recoveries: 0, failed: true },
      child: { exitCode: null, signal: "SIGTERM" },
    });
    expect(execution.result.problems).toContainEqual(
      expect.objectContaining({ code: ProblemCode.SessionRecoveryFailed }),
    );
    expect(execution.result.problems).not.toContainEqual(
      expect.objectContaining({ code: ProblemCode.ChildProcessFailed }),
    );
  });

  test("fails bounded recovery when a lost target has no safe reconnect endpoint", async () => {
    let deviceLists = 0;
    let childStarted = false;
    const deps = dependencies(async (request) => {
      const args = request.args ?? [];
      if (args.includes("devices")) {
        deviceLists += 1;
        return result(request, {
          stdout:
            deviceLists === 1
              ? "List of devices attached\nUSB-1 device model:Pixel_9 transport_id:7\n"
              : "List of devices attached\n",
        });
      }
      if (args.includes("ro.serialno")) return result(request, { stdout: "PHONE-1\n" });
      if (args.includes("host-features")) return result(request, { stdout: "shell_v2\n" });
      if (args.includes("mdns")) {
        return result(request, { stdout: "List of discovered mdns services\n" });
      }
      if (args.includes("get-state")) {
        return result(request, { stdout: childStarted ? "offline\n" : "device\n" });
      }
      if (args.includes("--list")) return result(request);
      if (request.executable === "long-running") {
        childStarted = true;
        return await new Promise<ProcessResult>((resolve) => {
          request.signal?.addEventListener(
            "abort",
            () => resolve(result(request, { exitCode: null, signal: "SIGTERM", aborted: true })),
            { once: true },
          );
        });
      }
      return result(request);
    });
    deps.sleep = async () => true;

    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "custom",
        command: { executable: "long-running", args: [] },
        reversePorts: [],
        logs: false,
        watchIntervalMs: 1,
        recovery: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
      },
      {},
      deps,
    );

    expect(execution.exitCode).toBe(ExitCode.AdbOperation);
    expect(execution.result.data?.recovery).toMatchObject({
      degradations: 1,
      recoveryAttempts: 1,
      recoveries: 0,
      failed: true,
    });
    expect(execution.result.problems).toContainEqual(
      expect.objectContaining({ code: ProblemCode.SessionRecoveryFailed }),
    );
  });

  test("reconnects the same physical target after its wireless transport changes", async () => {
    const endpoint = "192.168.1.20:37123";
    let deviceLists = 0;
    let childStarted = false;
    let reconnected = false;
    let healthyChecks = 0;
    let sleepCalls = 0;
    let resolveChild: ((value: ProcessResult) => void) | undefined;
    const deps = dependencies(async (request) => {
      const args = request.args ?? [];
      if (args.includes("devices")) {
        deviceLists += 1;
        const stdout =
          deviceLists === 1
            ? "List of devices attached\nUSB-1 device model:Pixel_9 transport_id:7\n"
            : deviceLists === 2
              ? "List of devices attached\n"
              : `List of devices attached\n${endpoint} device model:Pixel_9 transport_id:9\n`;
        return result(request, { stdout });
      }
      if (args.includes("host-features")) return result(request, { stdout: "shell_v2\n" });
      if (args.includes("mdns")) {
        return result(request, {
          stdout: `List of discovered mdns services\nadb-PHONE-1-x _adb-tls-connect._tcp ${endpoint}\n`,
        });
      }
      if (args.includes("connect")) {
        reconnected = true;
        return result(request, { stdout: `connected to ${endpoint}\n` });
      }
      if (args.includes("get-state")) {
        if (args.includes(endpoint)) return result(request, { stdout: "device\n" });
        return result(request, { stdout: childStarted ? "offline\n" : "device\n" });
      }
      if (args.includes("ro.serialno")) return result(request, { stdout: "PHONE-1\n" });
      if (args.includes("--list")) {
        if (reconnected) {
          healthyChecks += 1;
          if (healthyChecks >= 2) {
            queueMicrotask(() => resolveChild?.(result({ executable: "long-running", args: [] })));
          }
        }
        return result(request);
      }
      if (request.executable === "long-running") {
        childStarted = true;
        return await new Promise<ProcessResult>((resolve) => {
          resolveChild = resolve;
          request.signal?.addEventListener(
            "abort",
            () => resolve(result(request, { exitCode: null, signal: "SIGTERM", aborted: true })),
            { once: true },
          );
        });
      }
      return result(request);
    });
    deps.sleep = async (_milliseconds, watchSignal) => {
      sleepCalls += 1;
      if (sleepCalls <= 3) return true;
      if (watchSignal.aborted) return false;
      return await new Promise<boolean>((resolve) => {
        watchSignal.addEventListener("abort", () => resolve(false), { once: true });
      });
    };

    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "custom",
        command: { executable: "long-running", args: [] },
        reversePorts: [],
        logs: false,
        watchIntervalMs: 1,
        recovery: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
      },
      {},
      deps,
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(reconnected).toBeTrue();
    expect(execution.result.data).toMatchObject({
      status: "completed",
      selected: { transport: { serial: endpoint } },
      recovery: { recoveryAttempts: 1, recoveries: 1, targetChanges: 1, failed: false },
    });
  });

  test("fails visibly when an owned reverse mapping cannot be cleaned", async () => {
    let mapped = false;
    const execution = await runDev(
      {
        cwd: "/workspace/app",
        preset: "custom",
        command: { executable: "dev-server", args: [] },
        reversePorts: [{ device: 8081 }],
        logs: false,
      },
      {},
      dependencies(async (request) => {
        const probe = targetProbe(request);
        if (probe !== undefined) return probe;
        const args = request.args ?? [];
        if (args.includes("--no-rebind")) mapped = true;
        if (args.includes("--remove")) return result(request, { exitCode: 1 });
        if (args.includes("--list")) {
          return result(request, { stdout: mapped ? "host tcp:8081 tcp:8081\n" : "" });
        }
        return result(request);
      }),
    );

    expect(execution.exitCode).toBe(ExitCode.AdbOperation);
    expect(execution.result.data?.ports.cleaned).toBe(false);
    expect(execution.result.problems.at(-1)?.code).toBe(ProblemCode.PortMappingCleanupFailed);
  });
});
