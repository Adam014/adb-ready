import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseGradleManagedTasks,
  runGradleManagedTest,
} from "../../src/automation/gradle-managed-devices.js";
import type { ProcessRequest, ProcessResult } from "../../src/platform/process-runner.js";

function processResult(
  request: ProcessRequest,
  overrides: Partial<ProcessResult> = {},
): ProcessResult {
  return {
    executable: request.executable,
    args: [...(request.args ?? [])],
    startedAt: new Date(Date.now() - 100).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 100,
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

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "adb-ready-gmd-"));
  await writeFile(path.join(root, process.platform === "win32" ? "gradlew.bat" : "gradlew"), "");
  return root;
}

describe("Gradle Managed Devices", () => {
  test("discovers only managed-device and device-group Android test tasks", () => {
    expect(
      parseGradleManagedTasks(`
pixel2api35DebugAndroidTest - Executes tests using a Gradle managed device.
phoneAndTabletGroupDebugAndroidTest - Runs tests on all devices defined in phoneAndTablet.
connectedDebugAndroidTest - Installs and runs tests for Debug on connected devices.
lintDebug - Runs lint.
`),
    ).toEqual(["phoneAndTabletGroupDebugAndroidTest", "pixel2api35DebugAndroidTest"]);
  });

  test("builds a mutation-free exact dry-run plan", async () => {
    const root = await project();
    let calls = 0;
    try {
      const execution = await runGradleManagedTest(
        {
          cwd: root,
          task: ":app:pixel2api35DebugAndroidTest",
          shards: 4,
          softwareRendering: true,
          dryRun: true,
        },
        {
          idFactory: () => "plan-1",
          runner: async (request) => {
            calls += 1;
            return processResult(request);
          },
        },
      );

      expect(calls).toBe(0);
      expect(execution.exitCode).toBe(0);
      expect(execution.result.data).toMatchObject({
        status: "planned",
        task: ":app:pixel2api35DebugAndroidTest",
        command: {
          args: [
            ":app:pixel2api35DebugAndroidTest",
            "--console=plain",
            "--no-daemon",
            "-Pandroid.experimental.androidTest.numManagedDeviceShards=4",
            "-Pandroid.testoptions.manageddevices.emulator.gpu=swiftshader_indirect",
          ],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts an explicit Gradle Wrapper path without requiring project discovery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-gmd-explicit-"));
    try {
      const execution = await runGradleManagedTest({
        cwd: root,
        gradlePath: "tools/gradlew",
        task: "pixel2api35DebugAndroidTest",
        dryRun: true,
      });

      expect(execution.exitCode).toBe(0);
      expect(execution.result.data).toMatchObject({
        status: "planned",
        wrapper: "tools/gradlew",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports a missing Wrapper before attempting Gradle discovery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-gmd-missing-"));
    let calls = 0;
    try {
      const execution = await runGradleManagedTest(
        { cwd: root },
        {
          runner: async (request) => {
            calls += 1;
            return processResult(request);
          },
        },
      );

      expect(calls).toBe(0);
      expect(execution.exitCode).toBe(10);
      expect(execution.result.problems[0]?.code).toBe("GRADLE_WRAPPER_NOT_FOUND");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("discovers declared tasks and keeps discovery failures and cancellation distinct", async () => {
    const scenarios: Array<{
      result: Partial<ProcessResult>;
      exit: number;
      code?: string;
      tasks?: string[];
    }> = [
      {
        result: {
          stdout:
            "pixel2api35DebugAndroidTest - Executes tests using a Gradle managed device.\nconnectedDebugAndroidTest - Runs connected tests.",
        },
        exit: 0,
        tasks: ["pixel2api35DebugAndroidTest"],
      },
      {
        result: { exitCode: 1, timedOut: true, stderr: "discovery timed out" },
        exit: 40,
        code: "GRADLE_DISCOVERY_FAILED",
      },
      {
        result: { exitCode: null, aborted: true },
        exit: 130,
        code: "GRADLE_DISCOVERY_CANCELLED",
      },
    ];

    for (const scenario of scenarios) {
      const root = await project();
      try {
        const execution = await runGradleManagedTest(
          { cwd: root },
          {
            runner: async (request) => processResult(request, scenario.result),
          },
        );
        expect(execution.exitCode).toBe(scenario.exit);
        if (scenario.tasks !== undefined) {
          expect(execution.result.data).toMatchObject({
            status: "discovered",
            tasks: scenario.tasks,
          });
        } else {
          expect(execution.result.problems[0]?.code).toBe(scenario.code);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("rejects malformed and non-managed Gradle tasks before execution", async () => {
    const root = await project();
    try {
      let calls = 0;
      const malformed = await runGradleManagedTest(
        { cwd: root, task: "connectedDebugAndroidTest" },
        {
          runner: async (request) => {
            calls += 1;
            return processResult(request);
          },
        },
      );
      expect(calls).toBe(0);
      expect(malformed.exitCode).toBe(2);
      expect(malformed.result.problems[0]?.code).toBe("GRADLE_MANAGED_TASK_INVALID");

      const unrelated = await runGradleManagedTest(
        { cwd: root, task: "customDebugAndroidTest" },
        {
          runner: async (request) => {
            calls += 1;
            return processResult(request, { stdout: "Type\nTask (org.gradle.api.Task)" });
          },
        },
      );
      expect(calls).toBe(1);
      expect(unrelated.exitCode).toBe(2);
      expect(unrelated.result.problems[0]?.code).toBe("GRADLE_TASK_NOT_MANAGED_DEVICE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preflights one declared task and retains fresh JUnit and HTML evidence", async () => {
    const root = await project();
    const results = path.join(
      root,
      "app",
      "build",
      "outputs",
      "androidTest-results",
      "managedDevice",
      "pixel2api35",
      "debug",
    );
    const reports = path.join(
      root,
      "app",
      "build",
      "reports",
      "androidTests",
      "managedDevice",
      "pixel2api35",
      "debug",
    );
    try {
      let calls = 0;
      const execution = await runGradleManagedTest(
        { cwd: root, task: ":app:pixel2api35DebugAndroidTest" },
        {
          idFactory: () => "run-1",
          runner: async (request) => {
            calls += 1;
            if (calls === 2) {
              await mkdir(results, { recursive: true });
              await mkdir(reports, { recursive: true });
              await writeFile(
                path.join(results, "TEST-com.example.DeviceTest.xml"),
                '<testsuite tests="2" failures="0" errors="0" skipped="1" />',
              );
              await writeFile(path.join(reports, "index.html"), "<html>passed</html>");
            }
            return processResult(request, {
              stdout:
                calls === 1 ? "Type\nManagedDeviceInstrumentationTestTask" : "BUILD SUCCESSFUL",
            });
          },
        },
      );

      expect(calls).toBe(2);
      expect(execution.exitCode).toBe(0);
      expect(execution.result.data).toMatchObject({
        status: "completed",
        outcome: "passed",
        tests: { total: 2, failed: 0, errors: 0, skipped: 1 },
        evidence: { path: ".adb-ready/artifacts/gradle-managed-run-1", nativeFiles: 2 },
      });
      const retained = JSON.parse(
        await readFile(
          path.join(root, ".adb-ready", "artifacts", "gradle-managed-run-1", "result.json"),
          "utf8",
        ),
      ) as { outcome: string };
      expect(retained.outcome).toBe("passed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts a declared managed-device group task from Gradle task metadata", async () => {
    const root = await project();
    try {
      let calls = 0;
      const execution = await runGradleManagedTest(
        { cwd: root, task: "smokeFleetGroupDebugAndroidTest" },
        {
          idFactory: () => "group",
          runner: async (request) => {
            calls += 1;
            return processResult(request, {
              stdout:
                calls === 1
                  ? "Type\nTask (org.gradle.api.Task)\nDescription\nRuns the tests for debug on all devices defined in smokeFleet."
                  : "BUILD SUCCESSFUL",
            });
          },
        },
      );

      expect(execution.exitCode).toBe(0);
      expect(execution.result.data).toMatchObject({
        task: "smokeFleetGroupDebugAndroidTest",
        outcome: "passed",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps missing tasks, assertions, infrastructure, timeout, and cancellation distinct", async () => {
    const scenarios: Array<{
      name: string;
      preflight?: Partial<ProcessResult>;
      run?: Partial<ProcessResult>;
      code: string;
      exit: number;
    }> = [
      {
        name: "missing",
        preflight: { exitCode: 1 },
        code: "GRADLE_MANAGED_TASK_NOT_FOUND",
        exit: 2,
      },
      {
        name: "infrastructure",
        run: { exitCode: 1 },
        code: "GRADLE_MANAGED_INFRASTRUCTURE_FAILED",
        exit: 40,
      },
      {
        name: "timeout",
        run: { exitCode: null, timedOut: true },
        code: "GRADLE_MANAGED_TEST_TIMED_OUT",
        exit: 40,
      },
      {
        name: "cancel",
        run: { exitCode: null, aborted: true },
        code: "GRADLE_MANAGED_TEST_CANCELLED",
        exit: 130,
      },
    ];

    for (const scenario of scenarios) {
      const root = await project();
      try {
        let calls = 0;
        const execution = await runGradleManagedTest(
          { cwd: root, task: "pixel2api35DebugAndroidTest" },
          {
            idFactory: () => scenario.name,
            runner: async (request) => {
              calls += 1;
              return processResult(request, {
                ...(calls === 1
                  ? { stdout: "Type\nManagedDeviceInstrumentationTestTask", ...scenario.preflight }
                  : scenario.run),
              });
            },
          },
        );
        expect(execution.exitCode).toBe(scenario.exit);
        expect(execution.result.problems[0]?.code).toBe(scenario.code);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("uses JUnit evidence to classify a product assertion independently of Gradle prose", async () => {
    const root = await project();
    const results = path.join(root, "build", "outputs", "androidTest-results", "managedDevice");
    try {
      let calls = 0;
      const execution = await runGradleManagedTest(
        { cwd: root, task: "pixel2api35DebugAndroidTest" },
        {
          idFactory: () => "assertion",
          runner: async (request) => {
            calls += 1;
            if (calls === 2) {
              await mkdir(results, { recursive: true });
              await writeFile(
                path.join(results, "TEST-result.xml"),
                '<testsuite tests="1" failures="1" errors="0" skipped="0" />',
              );
            }
            return processResult(
              request,
              calls === 2
                ? { exitCode: 1, stderr: "opaque" }
                : { stdout: "Type\nManagedDeviceInstrumentationTestTask" },
            );
          },
        },
      );

      expect(execution.result.data?.outcome).toBe("assertion-failed");
      expect(execution.result.problems[0]?.code).toBe("GRADLE_TEST_ASSERTION_FAILED");
      const retained = JSON.parse(
        await readFile(
          path.join(root, ".adb-ready", "artifacts", "gradle-managed-assertion", "result.json"),
          "utf8",
        ),
      ) as { outcome: string };
      expect(retained.outcome).toBe("assertion-failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("marks Gradle-validated cached output without using stale failures to classify a failed run", async () => {
    for (const exitCode of [0, 1]) {
      const root = await project();
      const results = path.join(root, "build", "outputs", "androidTest-results", "managedDevice");
      try {
        await mkdir(results, { recursive: true });
        const stale = path.join(results, "TEST-stale.xml");
        await writeFile(stale, '<testsuite tests="1" failures="1" errors="0" skipped="0" />');
        await utimes(stale, new Date(1_000), new Date(1_000));
        let calls = 0;
        const execution = await runGradleManagedTest(
          { cwd: root, task: "pixel2api35DebugAndroidTest" },
          {
            idFactory: () => `cached-${String(exitCode)}`,
            runner: async (request) => {
              calls += 1;
              return processResult(
                request,
                calls === 1
                  ? { stdout: "Type\nManagedDeviceInstrumentationTestTask" }
                  : { exitCode },
              );
            },
          },
        );

        if (exitCode === 0) {
          expect(execution.result.data).toMatchObject({
            outcome: "passed",
            tests: { total: 1, failed: 1 },
            evidence: { provenance: "gradle-cache", nativeFiles: 1 },
          });
        } else {
          expect(execution.result.data).toMatchObject({
            outcome: "infrastructure-failed",
            tests: { total: 0, failed: 0 },
            evidence: { provenance: "none", nativeFiles: 0 },
          });
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
