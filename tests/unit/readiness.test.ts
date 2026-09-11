import { describe, expect, test } from "bun:test";
import { AdbClient } from "../../src/adb/client.js";
import {
  createAdbReadinessProbe,
  type ReadinessAssertionResult,
  readinessProblem,
  waitForReadiness,
} from "../../src/automation/readiness.js";
import { EventBus } from "../../src/core/event-bus.js";
import { ProblemCode } from "../../src/domain/problems.js";
import type { ProcessRequest, ProcessResult } from "../../src/platform/process-runner.js";

function processResult(request: ProcessRequest, stdout = "", exitCode = 0): ProcessResult {
  return {
    executable: request.executable,
    args: [...(request.args ?? [])],
    startedAt: "2026-09-11T10:00:00.000Z",
    finishedAt: "2026-09-11T10:00:00.001Z",
    durationMs: 1,
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

function client(
  respond: (request: ProcessRequest) => ProcessResult = (request) => processResult(request),
): AdbClient {
  return new AdbClient({
    executable: "/sdk/adb",
    bus: new EventBus(() => new Date("2026-09-11T10:00:00.000Z")),
    correlation: { commandId: "readiness-test" },
    runner: async (request) => respond(request),
    idFactory: () => "readiness-operation",
  });
}

describe("waitForReadiness", () => {
  test("polls failed assertions until every assertion passes", async () => {
    let now = 0;
    let calls = 0;
    const result = await waitForReadiness(
      [{ kind: "boot" }, { kind: "host-port", port: 8081 }],
      async (assertion): Promise<ReadinessAssertionResult> => {
        calls += 1;
        const passed = calls > 2;
        return {
          assertion,
          status: passed ? "passed" : "failed",
          detail: passed ? "ready" : "waiting",
          durationMs: 1,
        };
      },
      {
        timeoutMs: 2_000,
        pollIntervalMs: 100,
        clock: () => new Date(now),
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      },
    );

    expect(result).toMatchObject({ ready: true, attempts: 2, timedOut: false });
    expect(result.assertions.every(({ status }) => status === "passed")).toBeTrue();
  });

  test("fails immediately and honestly when a required probe is unsupported", async () => {
    const result = await waitForReadiness([{ kind: "unlocked" }], async (assertion) => ({
      assertion,
      status: "unsupported",
      detail: "not exposed",
      durationMs: 1,
    }));

    expect(result).toMatchObject({ ready: false, attempts: 1, timedOut: false });
  });

  test("returns an immediately ready result for an explicit empty contract", async () => {
    const result = await waitForReadiness([], async () => {
      throw new Error("probe should not run");
    });
    expect(result).toEqual({
      ready: true,
      attempts: 0,
      durationMs: 0,
      timedOut: false,
      assertions: [],
    });
  });

  test("validates polling limits and reports timeout and cancellation honestly", async () => {
    const assertion = { kind: "boot" as const };
    const failed = async (): Promise<ReadinessAssertionResult> => ({
      assertion,
      status: "failed",
      detail: "waiting",
      durationMs: 0,
    });
    await expect(waitForReadiness([assertion], failed, { timeoutMs: 0 })).rejects.toThrow(
      "timeoutMs",
    );
    await expect(waitForReadiness([assertion], failed, { pollIntervalMs: 0 })).rejects.toThrow(
      "pollIntervalMs",
    );

    let now = 0;
    const timedOut = await waitForReadiness([assertion], failed, {
      timeoutMs: 10,
      pollIntervalMs: 10,
      clock: () => new Date(now),
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });
    expect(timedOut).toMatchObject({ ready: false, attempts: 2, durationMs: 10, timedOut: true });

    const controller = new AbortController();
    controller.abort();
    expect(
      await waitForReadiness([assertion], failed, {
        signal: controller.signal,
        timeoutMs: 10,
      }),
    ).toMatchObject({ ready: false, attempts: 0, timedOut: false, assertions: [] });
  });
});

describe("ADB readiness probes", () => {
  const target = { serial: "USB-1", transportId: "7" };

  test("checks host, HTTP, and bounded log assertions independently", async () => {
    const lines = ["Metro ready", "ordinary log"];
    const probe = createAdbReadinessProbe({
      client: client(),
      target,
      logLines: () => lines,
      connectPort: async (_host, port) => port === 8081,
      fetchUrl: async (url) => (url.endsWith("/ready") ? 204 : 503),
    });

    expect(await probe({ kind: "host-port", port: 8081 })).toMatchObject({
      status: "passed",
      detail: "127.0.0.1:8081 is reachable.",
    });
    expect(await probe({ kind: "host-port", host: "localhost", port: 1 })).toMatchObject({
      status: "failed",
    });
    expect(await probe({ kind: "http", url: "https://example.test/ready" })).toMatchObject({
      status: "passed",
    });
    expect(
      await probe({ kind: "http", url: "https://example.test/down", status: [201] }),
    ).toMatchObject({ status: "failed", detail: expect.stringContaining("503") });
    expect(await probe({ kind: "log", contains: "Metro ready" })).toMatchObject({
      status: "passed",
    });
    expect(await probe({ kind: "log", contains: "fatal", absent: true })).toMatchObject({
      status: "passed",
    });
    expect(await probe({ kind: "log", contains: "Metro", absent: true })).toMatchObject({
      status: "failed",
    });
    expect(
      await createAdbReadinessProbe({ client: client(), target })({
        kind: "log",
        contains: "ready",
      }),
    ).toMatchObject({ status: "unsupported" });
  });

  test("checks Android boot, lock, process, foreground, and activity state", async () => {
    let lockState = "isStatusBarKeyguard=false";
    const probe = createAdbReadinessProbe({
      client: client((request) => {
        const args = request.args ?? [];
        if (args.includes("sys.boot_completed")) return processResult(request, "1\n");
        if (args.includes("policy")) return processResult(request, lockState);
        if (args.includes("pidof")) {
          return processResult(request, args.includes("com.example.app") ? "321 322\n" : "", 0);
        }
        if (args.includes("activities")) {
          return processResult(
            request,
            "mResumedActivity: ActivityRecord{42 u0 com.example.app/.MainActivity t12}\n",
          );
        }
        return processResult(request);
      }),
      target,
    });

    expect(await probe({ kind: "boot" })).toMatchObject({ status: "passed" });
    expect(await probe({ kind: "unlocked" })).toMatchObject({ status: "passed" });
    lockState = "mShowingLockscreen=true";
    expect(await probe({ kind: "unlocked" })).toMatchObject({ status: "failed" });
    lockState = "OEM state unavailable";
    expect(await probe({ kind: "unlocked" })).toMatchObject({ status: "unsupported" });
    expect(await probe({ kind: "process", package: "com.example.app" })).toMatchObject({
      status: "passed",
    });
    expect(await probe({ kind: "process", package: "com.missing" })).toMatchObject({
      status: "failed",
    });
    expect(await probe({ kind: "foreground", package: "com.example.app" })).toMatchObject({
      status: "passed",
    });
    expect(await probe({ kind: "foreground", package: "com.other" })).toMatchObject({
      status: "failed",
    });
    expect(await probe({ kind: "activity", value: ".MainActivity" })).toMatchObject({
      status: "passed",
    });
    expect(await probe({ kind: "activity", value: "OtherActivity" })).toMatchObject({
      status: "failed",
    });
  });

  test("checks semantic UI state and preserves unsupported and failure outcomes", async () => {
    let output =
      '<?xml version="1.0"?><hierarchy><node text="Ready" content-desc="status" resource-id="com.example:id/status" package="com.example" bounds="[0,0][10,10]" /></hierarchy>';
    let exitCode = 0;
    const probe = createAdbReadinessProbe({
      client: client((request) => processResult(request, output, exitCode)),
      target,
    });
    expect(await probe({ kind: "ui", selector: "text=Ready" })).toMatchObject({
      status: "passed",
    });
    expect(await probe({ kind: "ui", selector: "id=com.example:id/status" })).toMatchObject({
      status: "passed",
    });
    expect(await probe({ kind: "ui", selector: "desc=status", state: "gone" })).toMatchObject({
      status: "failed",
    });
    expect(
      await probe({ kind: "ui", selector: "package=com.missing", state: "gone" }),
    ).toMatchObject({
      status: "passed",
    });
    expect(await probe({ kind: "ui", selector: "class=Button" })).toMatchObject({
      status: "unsupported",
    });
    output = "not XML";
    expect(await probe({ kind: "ui", selector: "text=Ready" })).toMatchObject({
      status: "unsupported",
    });
    exitCode = 1;
    expect(await probe({ kind: "ui", selector: "text=Ready" })).toMatchObject({ status: "failed" });
  });

  test("converts probe exceptions and aborts into stable statuses", async () => {
    const probe = createAdbReadinessProbe({
      client: client(() => {
        throw new Error("transport lost");
      }),
      target,
    });
    expect(await probe({ kind: "boot" })).toMatchObject({
      status: "failed",
      detail: "Readiness probe failed: transport lost",
    });
    const controller = new AbortController();
    controller.abort();
    expect(await probe({ kind: "boot" }, controller.signal)).toMatchObject({
      status: "skipped",
      detail: "Readiness evaluation was cancelled.",
    });
  });

  test("classifies unsupported, timed-out, and ordinary readiness failures", () => {
    const base = {
      ready: false,
      attempts: 1,
      durationMs: 100,
      timedOut: false,
      assertions: [
        {
          assertion: { kind: "boot" as const },
          status: "failed" as const,
          detail: "waiting",
          durationMs: 1,
        },
      ],
    };
    expect(readinessProblem(base, "command-1", "target-1")).toMatchObject({
      code: ProblemCode.ReadinessFailed,
      summary: "The Android app readiness contract failed.",
      retryable: true,
      correlation: { commandId: "command-1", targetId: "target-1" },
    });
    expect(readinessProblem({ ...base, timedOut: true }, "command-2")).toMatchObject({
      summary: "The Android app did not become ready before the timeout.",
    });
    const failedAssertion = base.assertions[0];
    if (failedAssertion === undefined) throw new Error("Expected readiness assertion fixture");
    expect(
      readinessProblem(
        {
          ...base,
          assertions: [{ ...failedAssertion, status: "unsupported" }],
        },
        "command-3",
      ),
    ).toMatchObject({ code: ProblemCode.ReadinessUnsupported, retryable: false });
  });
});
