import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runApp, runApps, runOpen } from "../../src/app/app-commands.js";
import type { CommandDependencies } from "../../src/app/commands.js";
import { ExitCode } from "../../src/domain/contracts.js";
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

function fixture(
  onRequest?: (request: ProcessRequest) => ProcessResult | undefined,
): CommandDependencies {
  let id = 0;
  return {
    idFactory: () => `id-${String(++id)}`,
    clock: () => new Date("2026-09-10T10:00:00.000Z"),
    locateAdb: async () => "/sdk/adb",
    sleep: async () => false,
    detectProject: async () => ({
      root: "/project",
      presetEvidence: [],
      packageManager: { conflicts: [] },
    }),
    runner: async (request) => {
      const custom = onRequest?.(request);
      if (custom !== undefined) return custom;
      const args = request.args ?? [];
      if (args.includes("devices")) {
        return result(
          request,
          "List of devices attached\nUSB-1 device model:Pixel_9 transport_id:1\n",
        );
      }
      if (args.includes("host-features")) return result(request, "shell_v2\n");
      if (args.includes("mdns")) return result(request, "List of discovered mdns services\n");
      if (args.includes("ro.serialno")) return result(request, "hardware-1\n");
      if (args.includes("list") && args.includes("packages")) {
        return result(
          request,
          "package:/data/app/com.example.app/base.apk=com.example.app\npackage:/data/app/com.other/base.apk=com.other.app\n",
        );
      }
      if (args.includes("resolve-activity"))
        return result(request, "com.example.app/.MainActivity\n");
      if (args.includes("activity") && args.includes("activities")) {
        return result(
          request,
          "mResumedActivity: ActivityRecord{42 u0 com.example.app/.MainActivity t12}\n",
        );
      }
      if (args.includes("dumpsys") && args.includes("package")) {
        return result(
          request,
          "Package [com.example.app]\n codePath=/data/app/com.example.app\n versionCode=7 minSdk=24 targetSdk=36\n versionName=1.0.0\n pkgFlags=[ DEBUGGABLE HAS_CODE ]\n",
        );
      }
      if (args.includes("pidof")) return result(request, "", 1);
      return result(request, args.includes("start") ? "Status: ok\n" : "");
    },
  };
}

describe("app commands", () => {
  test("plans every app mutation with exact target-scoped ADB arguments", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-app-plans-"));
    await writeFile(path.join(root, "base.apk"), "apk");
    await writeFile(path.join(root, "config.apk"), "apk");
    try {
      const planned = await Promise.all([
        runApp(
          {
            action: "install",
            cwd: root,
            artifactPaths: ["base.apk", "config.apk"],
            applicationId: "com.example.app",
            replace: true,
            grantRuntimePermissions: true,
          },
          { dryRun: true, adbHost: "127.0.0.2", adbPort: 5038 },
          fixture(),
        ),
        runApp(
          { action: "launch", cwd: root, applicationId: "com.example.app" },
          { dryRun: true },
          fixture(),
        ),
        runApp(
          {
            action: "restart",
            cwd: root,
            applicationId: "com.example.app",
            activity: ".MainActivity",
          },
          { dryRun: true },
          fixture(),
        ),
        runApp(
          { action: "stop", cwd: root, applicationId: "com.example.app" },
          { dryRun: true },
          fixture(),
        ),
        runApp(
          { action: "clear-data", cwd: root, applicationId: "com.example.app" },
          { dryRun: true },
          fixture(),
        ),
        runApp(
          { action: "uninstall", cwd: root, applicationId: "com.example.app" },
          { dryRun: true },
          fixture(),
        ),
      ]);
      for (const execution of planned) {
        expect(execution.result).toMatchObject({ ok: true, data: { status: "planned" } });
        expect(execution.result.data).toHaveProperty("plan.dryRun", true);
      }
      expect(planned[0]?.result.data).toMatchObject({
        plan: { steps: [{ id: "install-split-apks" }, { id: "verify-installed-package" }] },
      });
      expect(planned[2]?.result.data).toMatchObject({
        plan: {
          steps: [
            { id: "stop-app" },
            { id: "verify-app-stopped" },
            { id: "launch-app" },
            { id: "verify-app-foreground" },
          ],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects missing, unreadable, and unverifiable install artifacts before mutation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-app-invalid-"));
    try {
      const invalid = await runApp(
        { action: "install", cwd: root, artifactPath: "bundle.aab" },
        {},
        fixture(),
      );
      expect(invalid.result.problems[0]?.code).toBe("APP_ARTIFACT_INVALID");

      const missing = await runApp(
        { action: "install", cwd: root, artifactPath: "missing.apk" },
        {},
        fixture(),
      );
      expect(missing.result.problems[0]?.code).toBe("APP_ARTIFACT_NOT_FOUND");

      await writeFile(path.join(root, "app.apk"), "apk");
      const unresolved = await runApp(
        { action: "install", cwd: root, artifactPath: "app.apk" },
        { dryRun: true },
        fixture(),
      );
      expect(unresolved.result.problems[0]?.code).toBe("APP_ID_NOT_FOUND");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports package, activity, stop, launch, and URL postcondition failures", async () => {
    const packageFailure = await runApps(
      "system",
      "example",
      {},
      fixture((request) =>
        request.args?.includes("packages") ? result(request, "", 1) : undefined,
      ),
    );
    expect(packageFailure.result.problems[0]?.code).toBeDefined();

    const noActivity = await runApp(
      { action: "launch", cwd: "/project", applicationId: "com.example.app" },
      {},
      fixture((request) =>
        request.args?.includes("resolve-activity") ? result(request, "", 1) : undefined,
      ),
    );
    expect(noActivity.result.problems[0]?.code).toBe("APP_ACTIVITY_NOT_FOUND");

    const stopFailed = await runApp(
      { action: "stop", cwd: "/project", applicationId: "com.example.app" },
      {},
      fixture((request) =>
        request.args?.includes("force-stop") ? result(request, "", 1) : undefined,
      ),
    );
    expect(stopFailed.result.ok).toBeFalse();

    const stopUnverified = await runApp(
      { action: "stop", cwd: "/project", applicationId: "com.example.app" },
      {},
      fixture((request) =>
        request.args?.includes("pidof") ? result(request, "321\n") : undefined,
      ),
    );
    expect(stopUnverified.result.problems[0]?.code).toBe("APP_STOP_UNVERIFIED");

    const launchUnverified = await runApp(
      {
        action: "launch",
        cwd: "/project",
        applicationId: "com.example.app",
        activity: ".MainActivity",
      },
      {},
      fixture((request) =>
        request.args?.includes("activities")
          ? result(request, "mResumedActivity: ActivityRecord{42 u0 com.other/.MainActivity t12}\n")
          : undefined,
      ),
    );
    expect(launchUnverified.result.problems[0]?.code).toBe("APP_LAUNCH_UNVERIFIED");

    expect((await runOpen("not a URL", undefined, {}, fixture())).result.problems[0]?.code).toBe(
      "APP_URL_INVALID",
    );
    const openUnverified = await runOpen(
      "https://example.com",
      "com.example.app",
      {},
      fixture((request) =>
        request.args?.includes("activities")
          ? result(request, "mResumedActivity: ActivityRecord{42 u0 com.other/.Main t12}\n")
          : undefined,
      ),
    );
    expect(openUnverified.result.problems[0]?.code).toBe("APP_OPEN_UNVERIFIED");
  });

  test("plans URLs with and without an explicit verified handler", async () => {
    const generic = await runOpen(
      "https://example.com/path",
      undefined,
      { dryRun: true },
      fixture(),
    );
    const explicit = await runOpen(
      "myapp://orders/42",
      "com.example.app",
      { dryRun: true },
      fixture(),
    );
    expect(generic.result.data).toMatchObject({
      status: "planned",
      plan: { steps: [{ id: "open-url" }] },
    });
    expect(explicit.result.data).toMatchObject({
      status: "planned",
      plan: { steps: [{ id: "open-url" }, { id: "verify-app-foreground" }] },
    });
  });

  test("lists bounded user packages on one deterministic target", async () => {
    const execution = await runApps("user", undefined, {}, fixture());
    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.data).toMatchObject({
      scope: "user",
      selected: { transport: { serial: "USB-1" } },
      packages: [{ name: "com.example.app" }, { name: "com.other.app" }],
      truncated: false,
    });
  });

  test("resolves explicit app identity and returns package/foreground evidence", async () => {
    const requests: string[][] = [];
    const resolved = await runApp(
      { action: "resolve", cwd: "/project", applicationId: "com.example.app" },
      {},
      fixture((request) => {
        requests.push([...(request.args ?? [])]);
        return undefined;
      }),
    );
    expect(resolved.result).toMatchObject({
      ok: true,
      data: {
        resolution: {
          kind: "resolved",
          applicationId: "com.example.app",
          provenance: { source: "cli" },
        },
      },
    });
    expect(requests).toEqual([]);

    const infoRequests: string[][] = [];
    const info = await runApp(
      { action: "info", cwd: "/project", applicationId: "com.example.app" },
      {},
      fixture((request) => {
        infoRequests.push([...(request.args ?? [])]);
        return undefined;
      }),
    );
    expect(info.result).toMatchObject({
      ok: true,
      data: {
        resolution: {
          provenance: { source: "cli" },
          considered: [{ value: "com.example.app", source: "cli" }],
        },
        package: { applicationId: "com.example.app", installed: true, versionName: "1.0.0" },
        foreground: { applicationId: "com.example.app", activity: ".MainActivity" },
      },
    });
    expect(infoRequests.some((args) => args.includes("list") && args.includes("packages"))).toBe(
      false,
    );
  });

  test("launches and verifies the same package in the foreground", async () => {
    const requests: string[][] = [];
    const dependencies = fixture((request) => {
      requests.push([...(request.args ?? [])]);
      return undefined;
    });
    const execution = await runApp(
      { action: "launch", cwd: "/project", applicationId: "com.example.app" },
      {},
      dependencies,
    );
    expect(execution.result).toMatchObject({
      ok: true,
      data: { action: "launch", applicationId: "com.example.app", verified: true },
    });
    expect(requests.some((args) => args.includes("resolve-activity"))).toBe(true);
    expect(
      requests.some(
        (args) => args.includes("-n") && args.includes("com.example.app/.MainActivity"),
      ),
    ).toBe(true);
  });

  test("refuses destructive app changes without explicit policy approval", async () => {
    const requests: string[][] = [];
    const execution = await runApp(
      { action: "clear-data", cwd: "/project", applicationId: "com.example.app" },
      {},
      fixture((request) => {
        requests.push([...(request.args ?? [])]);
        return undefined;
      }),
    );
    expect(execution.exitCode).toBe(ExitCode.InvalidInput);
    expect(execution.result.problems).toContainEqual(
      expect.objectContaining({ code: "DESTRUCTIVE_APPROVAL_REQUIRED" }),
    );
    expect(requests.some((args) => args.includes("clear"))).toBe(false);
  });

  test("plans exact target-scoped lifecycle commands without mutating or prompting", async () => {
    const requests: string[][] = [];
    const execution = await runApp(
      { action: "clear-data", cwd: "/project", applicationId: "com.example.app" },
      { adbHost: "10.0.0.2", adbPort: 5038, dryRun: true },
      fixture((request) => {
        requests.push([...(request.args ?? [])]);
        return undefined;
      }),
    );
    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        status: "planned",
        verified: false,
        plan: { dryRun: true },
      },
    });
    const data = execution.result.data;
    expect(data?.action).toBe("clear-data");
    if (data === null || data.action !== "clear-data") throw new Error("expected clear-data plan");
    expect(data.plan?.steps[0]).toEqual(
      expect.objectContaining({
        id: "clear-app-data",
        risk: "destructive",
        args: [
          "-H",
          "10.0.0.2",
          "-P",
          "5038",
          "-t",
          "1",
          "shell",
          "pm",
          "clear",
          "com.example.app",
        ],
      }),
    );
    expect(requests.some((args) => args.includes("clear"))).toBe(false);
  });

  test("installs an APK and verifies a new package independently", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-app-"));
    const apk = path.join(directory, "example.apk");
    await writeFile(apk, "fixture");
    let installed = false;
    try {
      const execution = await runApp(
        { action: "install", cwd: directory, artifactPath: apk },
        {},
        fixture((request) => {
          const args = request.args ?? [];
          if (args.includes("list") && args.includes("packages")) {
            return result(
              request,
              installed
                ? "package:/data/app/com.example.new/base.apk=com.example.new\n"
                : "package:/data/app/com.example.app/base.apk=com.example.app\n",
            );
          }
          if (args.includes("install")) {
            installed = true;
            return result(request, "Success\n");
          }
          if (args.includes("dumpsys") && args.includes("package")) {
            return result(
              request,
              installed
                ? "Package [com.example.new]\n codePath=/data/app/com.example.new\n versionCode=1\n versionName=1.0.0\n lastUpdateTime=2026-09-10 10:00:00\n"
                : "Unable to find package\n",
            );
          }
          return undefined;
        }),
      );
      expect(execution.result).toMatchObject({
        ok: true,
        data: {
          action: "install",
          applicationId: "com.example.new",
          verified: true,
          status: "installed",
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("plans an APK install only when its verification identity is deterministic", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-plan-"));
    const apk = path.join(directory, "example.apk");
    await writeFile(apk, "fixture");
    const requests: string[][] = [];
    try {
      const execution = await runApp(
        {
          action: "install",
          cwd: directory,
          artifactPath: apk,
          applicationId: "com.example.app",
          replace: true,
        },
        { dryRun: true },
        fixture((request) => {
          requests.push([...(request.args ?? [])]);
          return undefined;
        }),
      );
      expect(execution.result).toMatchObject({
        ok: true,
        data: {
          applicationId: "com.example.app",
          status: "planned",
          plan: {
            steps: [
              {
                id: "install-apk",
                args: ["-t", "1", "install", "-r", expect.any(String)],
              },
              { id: "verify-installed-package" },
            ],
          },
        },
      });
      expect(requests.some((args) => args.includes("install"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("installs one complete split APK set with one verified operation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-splits-"));
    const base = path.join(directory, "base.apk");
    const architecture = path.join(directory, "config.arm64_v8a.apk");
    await Promise.all([writeFile(base, "base"), writeFile(architecture, "split")]);
    const requests: string[][] = [];
    let installed = false;
    try {
      const execution = await runApp(
        {
          action: "install",
          cwd: directory,
          artifactPaths: [base, architecture],
          applicationId: "com.example.app",
          replace: true,
        },
        {},
        fixture((request) => {
          const args = [...(request.args ?? [])];
          requests.push(args);
          if (args.includes("install-multiple")) {
            installed = true;
            return result(request, "Success\n");
          }
          if (installed && args.includes("dumpsys") && args.includes("package")) {
            return result(
              request,
              "Package [com.example.app]\n codePath=/data/app/new\n versionCode=8\n versionName=1.1.0\n lastUpdateTime=2026-09-10 10:01:00\n",
            );
          }
          return undefined;
        }),
      );

      expect(execution.result).toMatchObject({
        ok: true,
        data: {
          status: "installed",
          artifactPaths: [expect.stringContaining("base.apk"), expect.stringContaining("arm64")],
        },
      });
      expect(
        requests.some(
          (args) =>
            args.includes("install-multiple") && args.includes(base) && args.includes(architecture),
        ),
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("clears and uninstalls only with approval and verified postconditions", async () => {
    let removed = false;
    const dependencies = fixture((request) => {
      const args = request.args ?? [];
      if (args.includes("clear")) return result(request, "Success\n");
      if (args.includes("uninstall")) {
        removed = true;
        return result(request, "Success\n");
      }
      if (removed && args.includes("dumpsys") && args.includes("package")) {
        return result(request, "Unable to find package\n");
      }
      return undefined;
    });
    const cleared = await runApp(
      {
        action: "clear-data",
        cwd: "/project",
        applicationId: "com.example.app",
        destructiveApproved: true,
      },
      {},
      dependencies,
    );
    expect(cleared.result).toMatchObject({ ok: true, data: { status: "cleared" } });

    const uninstalled = await runApp(
      {
        action: "uninstall",
        cwd: "/project",
        applicationId: "com.example.app",
        destructiveApproved: true,
      },
      {},
      dependencies,
    );
    expect(uninstalled.result).toMatchObject({ ok: true, data: { status: "uninstalled" } });
  });

  test("opens a deep link and verifies an explicitly requested handler", async () => {
    const execution = await runOpen("myapp://orders/42", "com.example.app", {}, fixture());
    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        url: "myapp://orders/42",
        applicationId: "com.example.app",
        verified: true,
        status: "opened",
      },
    });
  });
});
