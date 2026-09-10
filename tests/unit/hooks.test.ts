import { describe, expect, test } from "bun:test";
import { EventBus } from "../../src/core/event-bus.js";
import { runHooks } from "../../src/dev/hooks.js";
import type { ProcessRequest, ProcessResult } from "../../src/platform/process-runner.js";

function result(request: ProcessRequest, exitCode = 0): ProcessResult {
  return {
    executable: request.executable,
    args: [...(request.args ?? [])],
    startedAt: "2026-09-10T10:00:00.000Z",
    finishedAt: "2026-09-10T10:00:00.010Z",
    durationMs: 10,
    exitCode,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    stoppedAfterIdle: false,
    killEscalated: false,
  };
}

describe("runHooks", () => {
  test("runs direct argv with an allowlisted environment and redacted output", async () => {
    const requests: ProcessRequest[] = [];
    const events: unknown[] = [];
    const bus = new EventBus(() => new Date("2026-09-10T10:00:00.000Z"));
    bus.subscribe((event) => events.push(event));
    const runs = await runHooks({
      hooks: {
        onReady: [
          {
            run: ["node", "notify.mjs", "literal;$(safe)"],
            envAllowlist: ["ALLOWED"],
            failure: "warn",
          },
        ],
      },
      event: "onReady",
      projectRoot: "/project",
      environment: { ANDROID_SERIAL: "USB-1", ADB_READY_SESSION_ID: "session-1" },
      hostEnv: { PATH: "/bin", ALLOWED: "yes", SECRET: "no" },
      bus,
      correlation: { commandId: "command", sessionId: "session" },
      runner: async (request) => {
        requests.push(request);
        request.onStdoutChunk?.(new TextEncoder().encode("token=secret-value\n"));
        return result(request);
      },
    });
    expect(requests[0]).toMatchObject({
      executable: "node",
      args: ["notify.mjs", "literal;$(safe)"],
      cwd: "/project",
      inheritEnv: false,
      env: {
        PATH: "/bin",
        ALLOWED: "yes",
        ANDROID_SERIAL: "USB-1",
        ADB_READY_SESSION_ID: "session-1",
      },
    });
    expect(requests[0]?.env?.SECRET).toBeUndefined();
    expect(runs[0]).toMatchObject({ ok: true, failure: "warn" });
    expect(JSON.stringify(events)).not.toContain("secret-value");
  });

  test("stops a hook chain only on a fail-policy failure", async () => {
    let calls = 0;
    const runs = await runHooks({
      hooks: {
        beforeDev: [
          { run: ["first"], failure: "warn" },
          { run: ["second"], failure: "fail" },
          { run: ["never"] },
        ],
      },
      event: "beforeDev",
      projectRoot: "/project",
      environment: {},
      hostEnv: {},
      bus: new EventBus(),
      correlation: { commandId: "command" },
      runner: async (request) => {
        calls += 1;
        return result(request, 1);
      },
    });
    expect(calls).toBe(2);
    expect(runs.map(({ failure }) => failure)).toEqual(["warn", "fail"]);
  });
});
