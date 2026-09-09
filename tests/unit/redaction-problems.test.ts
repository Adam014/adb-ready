import { describe, expect, test } from "bun:test";
import { redactText } from "../../src/core/redaction.js";
import { adbProcessProblem, ProblemCode, problemsForDevices } from "../../src/domain/problems.js";
import type { ProcessResult } from "../../src/platform/process-runner.js";

function failedProcess(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    executable: "adb",
    args: ["devices", "-l"],
    startedAt: "2026-09-09T10:00:00.000Z",
    finishedAt: "2026-09-09T10:00:01.000Z",
    durationMs: 1_000,
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "adb failed",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    stoppedAfterIdle: false,
    killEscalated: false,
    ...overrides,
  };
}

describe("redactText", () => {
  test("redacts common credentials, pairing codes, URL secrets, and home paths", () => {
    const input =
      "Authorization: Bearer abc.def pairing code=123456 " +
      "api_key='top-secret' https://example.test/?token=query-secret " +
      "/Users/example/project";
    const result = redactText(input, { homeDirectory: "/Users/example" });

    expect(result.value).not.toContain("abc.def");
    expect(result.value).not.toContain("123456");
    expect(result.value).not.toContain("top-secret");
    expect(result.value).not.toContain("query-secret");
    expect(result.value).toContain("~/project");
    expect(result.replacements).toBe(5);
  });

  test("does not redact unrelated six-digit values", () => {
    expect(redactText("build 149108 and port 8081", { homeDirectory: "/none" }).value).toBe(
      "build 149108 and port 8081",
    );
  });
});

describe("problem classification", () => {
  test("classifies a timeout from structured process state", () => {
    const problem = adbProcessProblem(
      "devices",
      failedProcess({ timedOut: true, signal: "SIGTERM" }),
      { commandId: "command-1", operationId: "operation-1" },
    );
    expect(problem.code).toBe(ProblemCode.AdbTimeout);
    expect(problem.evidence).toContainEqual({
      source: "process",
      field: "timedOut",
      value: true,
    });
  });

  test("classifies an interrupted process before generic ADB failures", () => {
    const problem = adbProcessProblem(
      "devices",
      failedProcess({ aborted: true, signal: "SIGTERM" }),
      { commandId: "command-1", operationId: "operation-1" },
    );

    expect(problem.code).toBe(ProblemCode.OperationInterrupted);
    expect(problem.category).toBe("process.interrupted");
  });

  test("classifies a daemon failure without treating every stderr line as a category", () => {
    const daemon = adbProcessProblem(
      "devices",
      failedProcess({ stderr: "cannot connect to daemon at tcp:5037" }),
      { commandId: "command-1" },
    );
    const generic = adbProcessProblem("devices", failedProcess({ stderr: "a future failure" }), {
      commandId: "command-1",
    });

    expect(daemon.code).toBe(ProblemCode.AdbServerUnavailable);
    expect(generic.code).toBe(ProblemCode.AdbCommandFailed);
  });

  test("redacts process evidence before attaching it to a problem", () => {
    const problem = adbProcessProblem(
      "devices",
      failedProcess({ stderr: "Authorization=secret-value" }),
      { commandId: "command-1" },
    );
    const stderr = problem.evidence.find(({ field }) => field === "stderr");

    expect(stderr?.value).toBe("Authorization=[REDACTED]");
    expect(stderr?.redacted).toBe(true);
  });

  test("creates explicit problems for unsafe target states", () => {
    const problems = problemsForDevices(
      [
        { serial: "usb-1", state: "unauthorized", properties: {}, unparsed: [] },
        { serial: "wifi-1", state: "offline", properties: {}, unparsed: [] },
        { serial: "future-1", state: "unknown", properties: {}, unparsed: [] },
      ],
      { commandId: "command-1" },
    );

    expect(problems.map(({ code }) => code)).toEqual([
      ProblemCode.TargetUnauthorized,
      ProblemCode.TargetOffline,
      ProblemCode.TargetUnknownState,
    ]);
  });
});
