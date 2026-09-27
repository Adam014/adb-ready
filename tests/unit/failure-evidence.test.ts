import { describe, expect, test } from "bun:test";
import type { CommandDependencies } from "../../src/app/commands.js";
import {
  correlateFailureIncidents,
  parseApplicationExitInfo,
  parseDropboxFailures,
  runInspectFailures,
} from "../../src/evidence/failure-evidence.js";
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
  options: { unavailableExit?: boolean; deniedDropbox?: boolean } = {},
): CommandDependencies {
  let id = 0;
  return {
    idFactory: () => `failure-${String(++id)}`,
    clock: () => new Date("2026-09-10T10:00:00.000Z"),
    locateAdb: async () => "/sdk/adb",
    detectProject: async () => ({
      root: "/project",
      presetEvidence: [],
      packageManager: { conflicts: [] },
    }),
    runner: async (request) => {
      const args = [...(request.args ?? [])];
      if (args.includes("devices")) {
        return result(
          request,
          "List of devices attached\nUSB-1 device model:Pixel_9 transport_id:1\n",
        );
      }
      if (args.includes("host-features")) return result(request, "shell_v2\n");
      if (args.includes("mdns")) return result(request, "List of discovered mdns services\n");
      if (args.includes("ro.serialno")) return result(request, "hardware-1\n");
      if (args.includes("packages")) {
        return result(
          request,
          args.includes("-U")
            ? "package:com.example.app uid:10123\n"
            : "package:/data/app/example/base.apk=com.example.app\n",
        );
      }
      if (args.includes("dumpsys") && args.includes("package")) {
        return result(
          request,
          "Package [com.example.app]\n codePath=/data/app/example\n versionCode=7 targetSdk=36\n versionName=1.2.3\n pkgFlags=[ DEBUGGABLE ]\n",
        );
      }
      if (args.includes("activities")) {
        return result(
          request,
          "mResumedActivity: ActivityRecord{42 u0 com.example.app/.MainActivity}\n",
        );
      }
      if (args.includes("date") && args.includes("+%s%3N")) {
        return result(request, `${String(Date.parse("2026-09-10T10:00:00.000Z"))}\n`);
      }
      if (args.includes("date") && args.includes("+%z")) return result(request, "+0000\n");
      if (args.includes("exit-info")) {
        return result(
          request,
          options.unavailableExit === true
            ? "Unknown command: exit-info\n"
            : `ACTIVITY MANAGER PROCESS EXIT INFO (dumpsys activity exit-info)
  package: com.example.app
    Historical Process Exit for uid=10123
        ApplicationExitInfo #0:
          timestamp=2026-09-10 09:59:30.123 pid=321 realUid=10123 packageUid=10123 definingUid=10123 user=0
          process=com.example.app reason=4 (APP CRASH(EXCEPTION)) subreason=0 (UNKNOWN) status=0
          importance=100 pss=20MB rss=40MB description=crash state=empty trace=null
        ApplicationExitInfo #1:
          timestamp=2026-09-10 09:59:35.000 pid=100 realUid=10123 packageUid=10123 definingUid=10123 user=0
          process=com.example.app reason=6 (ANR) subreason=0 (UNKNOWN) status=0
          importance=100 pss=20MB rss=40MB description=recent anr state=empty trace=null
        ApplicationExitInfo #2:
          timestamp=2026-09-10 09:59:40.000 pid=999 realUid=10999 packageUid=10999 definingUid=10999 user=0
          process=com.other.app reason=5 (APP CRASH(NATIVE)) subreason=0 (UNKNOWN) status=0
          importance=100 pss=20MB rss=40MB description=unrelated state=empty trace=null
`,
        );
      }
      if (args.includes("--help") && args.includes("logcat")) {
        return result(request, "--uid=UIDS filter by UID\n");
      }
      if (args.includes("logcat")) {
        const output =
          "09-10 09:59:31.000  321  322 E ReactNativeJS: Invariant Violation: demo failure\n";
        request.onStdoutChunk?.(new TextEncoder().encode(output));
        return result(request, output);
      }
      if (args.includes("dropbox")) {
        if (options.deniedDropbox === true) return result(request, "Permission Denial\n", 1);
        const tag = args.at(-1);
        return result(
          request,
          tag === "data_app_native_crash"
            ? `Drop box contents: 1 entries
2026-09-10 09:59:32 data_app_native_crash (text, 200 bytes)
Package: com.example.app
Process: com.example.app
signal 11 (SIGSEGV)
backtrace: #00 pc 0000
`
            : "Drop box contents: 0 entries\n(No entries found.)\n",
        );
      }
      return result(request);
    },
  };
}

describe("failure evidence", () => {
  test("parses stable ApplicationExitInfo reason codes and device-local timestamps", () => {
    expect(
      parseApplicationExitInfo(
        `ApplicationExitInfo #0:
 timestamp=2026-09-10 12:00:00.000 pid=42 realUid=1
 process=com.example.app reason=5 (APP CRASH(NATIVE)) subreason=0 (UNKNOWN) status=4
 importance=100 description=crash state=empty trace=null
`,
        "+0200",
      ),
    ).toEqual([
      {
        timestamp: "2026-09-10T10:00:00.000Z",
        pid: 42,
        process: "com.example.app",
        reasonCode: 5,
        reason: "APP CRASH(NATIVE)",
        description: "crash",
      },
    ]);
  });

  test("keeps only exact package-correlated DropBox blocks", () => {
    const incidents = parseDropboxFailures(
      `2026-09-10 09:59:00 data_app_crash (text, 100 bytes)
Package: com.other.app
FATAL EXCEPTION
2026-09-10 09:59:30 data_app_anr (text, 100 bytes)
Package: com.example.app
ANR in com.example.app
`,
      "com.example.app",
      "+0000",
    );
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      kind: "anr",
      source: "dropbox",
      observedAt: "2026-09-10T09:59:30.000Z",
    });
  });

  test("merges one crash corroborated by independent Android sources", () => {
    const incidents = correlateFailureIncidents([
      {
        kind: "java-crash",
        source: "application-exit-info",
        observedAt: "2026-09-10T09:59:30.123Z",
        process: "com.example.app",
        pid: 321,
        summary: "Android classified an app crash.",
        evidence: ["reason=4"],
      },
      {
        kind: "java-crash",
        source: "dropbox",
        observedAt: "2026-09-10T09:59:30.000Z",
        summary: "DropBox retained the crash.",
        evidence: ["FATAL EXCEPTION"],
      },
      {
        kind: "java-crash",
        source: "logcat",
        pid: 321,
        summary: "Logcat retained the crash.",
        evidence: ["RuntimeException"],
      },
    ]);
    expect(incidents).toEqual([
      expect.objectContaining({
        source: "application-exit-info",
        corroboratedBy: ["dropbox", "logcat"],
        evidence: ["reason=4", "FATAL EXCEPTION", "RuntimeException"],
      }),
    ]);
  });

  test("correlates bounded Java, React Native, native, and ANR evidence while excluding unrelated exits", async () => {
    const execution = await runInspectFailures(
      { cwd: "/project", applicationId: "com.example.app", sinceMs: 60_000, limit: 10 },
      {},
      fixture(),
    );
    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        kind: "failures",
        applicationId: "com.example.app",
        identity: { uid: 10123 },
        summary: { "java-crash": 1, "native-crash": 1, anr: 1, "react-native": 1 },
        window: { durationMs: 60_000, deviceUtcOffset: "+0000" },
        sources: [
          { name: "application-exit-info", available: true, records: 3 },
          { name: "logcat", available: true, records: 1 },
          { name: "dropbox", available: true, records: 1 },
        ],
        sensitive: true,
        truncated: false,
      },
    });
    expect(execution.result.data?.incidents.map(({ kind }) => kind).sort()).toEqual([
      "anr",
      "java-crash",
      "native-crash",
      "react-native",
    ]);
  });

  test("reports unavailable sources without turning absence into an app failure", async () => {
    const execution = await runInspectFailures(
      { cwd: "/project", applicationId: "com.example.app" },
      {},
      fixture({ unavailableExit: true, deniedDropbox: true }),
    );
    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        sources: [
          { name: "application-exit-info", available: false },
          { name: "logcat", available: true },
          { name: "dropbox", available: false, limitation: expect.stringContaining("denied") },
        ],
      },
    });
  });

  test("rejects unbounded windows and result limits before ADB access", async () => {
    expect(
      (await runInspectFailures({ cwd: "/project", sinceMs: 999 }, {}, fixture())).result,
    ).toMatchObject({ ok: false, problems: [{ code: "FAILURE_WINDOW_INVALID" }] });
    expect(
      (await runInspectFailures({ cwd: "/project", limit: 101 }, {}, fixture())).result,
    ).toMatchObject({ ok: false, problems: [{ code: "FAILURE_LIMIT_INVALID" }] });
  });
});
