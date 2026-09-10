import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type CommandDependencies, runDev } from "../../src/app/commands.js";
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
  return undefined;
}

describe("runDev", () => {
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
    const serializedJournal = JSON.stringify(execution.result.data?.journal.events);
    expect(serializedJournal).not.toContain("hunter2");
    expect(serializedJournal).not.toContain("secret-value");
    expect(serializedJournal).toContain("child.stdout");
    expect(serializedJournal).toContain("log.record");
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
        if (request.executable === "broken-dev") return result(request, { exitCode: 17 });
        return result(request);
      }),
    );
    expect(execution.exitCode).toBe(17);
    expect(execution.result.problems.at(-1)?.code).toBe(ProblemCode.ChildProcessFailed);
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
        expected: ["run", "start", "--", "--android"],
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
    expect(execution.result.data?.ports.cleaned).toBe(true);
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
