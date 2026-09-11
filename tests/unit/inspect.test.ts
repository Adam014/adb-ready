import { describe, expect, test } from "bun:test";
import type { CommandDependencies } from "../../src/app/commands.js";
import { runInspectApp, runInspectUi } from "../../src/evidence/inspect.js";
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

function fixture(requests: string[][] = []): CommandDependencies {
  let id = 0;
  return {
    idFactory: () => `id-${String(++id)}`,
    clock: () => new Date("2026-09-10T10:00:00.000Z"),
    locateAdb: async () => "/sdk/adb",
    detectProject: async () => ({
      root: "/project",
      presetEvidence: [],
      packageManager: { conflicts: [] },
    }),
    runner: async (request) => {
      const args = [...(request.args ?? [])];
      requests.push(args);
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
        return result(request, "package:/data/app/example/base.apk=com.example.app\n");
      }
      if (args.includes("dumpsys") && args.includes("package")) {
        return result(
          request,
          "Package [com.example.app]\n codePath=/data/app/example\n versionCode=7 targetSdk=36\n versionName=1.2.3\n pkgFlags=[ DEBUGGABLE ]\n",
        );
      }
      if (args.includes("activity") && args.includes("activities")) {
        return result(
          request,
          "mResumedActivity: ActivityRecord{42 u0 com.example.app/.MainActivity t12}\n",
        );
      }
      if (args.includes("pidof")) return result(request, "321\n");
      if (args.includes("logcat")) {
        const output = "09-10 10:00:00.000  321  322 E Demo: crash marker\n";
        request.onStdoutChunk?.(new TextEncoder().encode(output));
        return result(request, output);
      }
      if (args.includes("uiautomator")) {
        return result(
          request,
          '<?xml version version="1.0"?><hierarchy><node text="Open" resource-id="com.example.app:id/open" class="android.widget.Button" clickable="true" enabled="true" bounds="[1,2][30,40]" /></hierarchy>',
        );
      }
      return result(request);
    },
  };
}

describe("inspect evidence", () => {
  test("builds one bounded app snapshot and keeps screenshots explicit", async () => {
    const execution = await runInspectApp(
      { cwd: "/project", applicationId: "com.example.app" },
      {},
      fixture(),
    );
    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        kind: "app",
        app: { package: { applicationId: "com.example.app", versionName: "1.2.3" } },
        logs: { available: true, records: [{ message: "crash marker" }] },
        screenshot: {
          available: false,
          reason: "sensitive-explicit-capture-required",
          command: "adb-ready capture screenshot",
        },
        sensitive: true,
      },
    });
  });

  test("returns a bounded sensitive UI snapshot from one explicit target", async () => {
    const requests: string[][] = [];
    const execution = await runInspectUi(
      { interactiveOnly: true, maxDepth: 10 },
      {},
      fixture(requests),
    );
    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        kind: "ui",
        selected: { transport: { serial: "USB-1" } },
        snapshot: {
          sensitive: true,
          complete: true,
          returnedNodes: 1,
          nodes: [{ resourceId: "com.example.app:id/open", clickable: true }],
        },
      },
    });
    expect(requests.find((args) => args.includes("uiautomator"))).toEqual(
      expect.arrayContaining(["-t", "1", "exec-out", "uiautomator", "dump", "/dev/tty"]),
    );
  });

  test("reports a continuously changing UI separately from inaccessible windows", async () => {
    const dependencies = fixture();
    dependencies.runner = async (request) => {
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
      return result(request, "ERROR: could not get idle state");
    };
    const execution = await runInspectUi({}, {}, dependencies);
    expect(execution.result).toMatchObject({
      ok: false,
      problems: [{ code: "UI_NOT_IDLE", category: "evidence.ui.busy" }],
    });
  });
});
