import { describe, expect, test } from "bun:test";
import { runTargetPool, targetPoolMemberArguments } from "../../src/automation/target-pool.js";
import type { ConfigTargetPool } from "../../src/config/types.js";
import { ExitCode, type ResultEnvelope, SCHEMA_VERSION } from "../../src/domain/contracts.js";

const members: ConfigTargetPool["members"] = [
  { id: "usb", kind: "adb", serial: "USB-1" },
  { id: "emulator", kind: "avd", name: "Pixel_API_36" },
  { id: "lab", kind: "remote-adb", host: "lab.internal", port: 5038, serial: "REMOTE-1" },
];

function pool(overrides: Partial<ConfigTargetPool> = {}): ConfigTargetPool {
  return {
    members,
    maxConcurrency: 2,
    failFast: false,
    leaseWaitMs: 30_000,
    ...overrides,
  };
}

function envelope(id: string, ok: boolean): ResultEnvelope<unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    command: "run",
    commandId: id,
    ok,
    startedAt: "2026-09-27T10:00:00.000Z",
    finishedAt: "2026-09-27T10:00:01.000Z",
    durationMs: 1_000,
    data: { id },
    problems: [],
  };
}

describe("target pool fan-out", () => {
  test("bounds concurrency and preserves declaration-order member results", async () => {
    let active = 0;
    let maximum = 0;
    const started: string[] = [];
    const finished: string[] = [];
    const execution = await runTargetPool(
      {
        name: "smoke",
        pool: pool(),
        clock: () => new Date("2026-09-27T10:00:00.000Z"),
        idFactory: () => "pool-1",
        onMemberStart: ({ id }) => started.push(id),
        onMemberFinish: ({ id, status }) => finished.push(`${id}:${status}`),
      },
      async (member) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, member.id === "usb" ? 10 : 1));
        active -= 1;
        return { exitCode: ExitCode.Success, result: envelope(member.id, true) };
      },
    );

    expect(maximum).toBe(2);
    expect(started.sort()).toEqual(["emulator", "lab", "usb"]);
    expect(finished.sort()).toEqual(["emulator:passed", "lab:passed", "usb:passed"]);
    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.data?.members.map(({ id }) => id)).toEqual(["usb", "emulator", "lab"]);
    expect(execution.result.data?.summary).toEqual({
      passed: 3,
      failed: 0,
      cancelled: 0,
      skipped: 0,
    });
  });

  test("fails the aggregate for a required member and keeps every member outcome", async () => {
    const execution = await runTargetPool(
      { name: "smoke", pool: pool({ maxConcurrency: 1, failFast: true }) },
      async (member) => ({
        exitCode: member.id === "usb" ? ExitCode.ChildProcess : ExitCode.Success,
        result: envelope(member.id, member.id !== "usb"),
      }),
    );

    expect(execution.exitCode).toBe(ExitCode.ChildProcess);
    expect(execution.result.ok).toBeFalse();
    expect(execution.result.data?.members.map(({ status }) => status)).toEqual([
      "failed",
      "cancelled",
      "cancelled",
    ]);
    expect(execution.result.problems[0]?.code).toBe("TARGET_POOL_REQUIRED_MEMBER_FAILED");
  });

  test("does not fail the aggregate when only an optional member fails", async () => {
    const execution = await runTargetPool(
      {
        name: "optional",
        pool: pool({
          members: [
            { id: "required", kind: "adb", serial: "USB-1" },
            { id: "optional", kind: "adb", serial: "USB-2", required: false },
          ],
        }),
      },
      async (member) => ({
        exitCode: member.required === false ? ExitCode.Target : ExitCode.Success,
        result: envelope(member.id, member.required !== false),
      }),
    );

    expect(execution.exitCode).toBe(ExitCode.Success);
    expect(execution.result.ok).toBeTrue();
    expect(execution.result.data?.summary).toMatchObject({ passed: 1, failed: 1 });
  });

  test("turns a thrown required member into a retained failure and stops queued work", async () => {
    const execution = await runTargetPool(
      { name: "throwing", pool: pool({ maxConcurrency: 1, failFast: true }) },
      async () => {
        throw new Error("adapter disappeared");
      },
    );

    expect(execution.exitCode).toBe(ExitCode.Internal);
    expect(execution.result.data?.members[0]).toMatchObject({
      id: "usb",
      status: "failed",
      exitCode: ExitCode.Internal,
    });
    expect(
      execution.result.data?.members.slice(1).every(({ status }) => status === "cancelled"),
    ).toBeTrue();
  });

  test("cancels every member before allocation when the parent is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("workflow cancelled"));
    let runnerCalls = 0;
    const finished: string[] = [];

    const execution = await runTargetPool(
      {
        name: "cancelled",
        pool: pool(),
        signal: controller.signal,
        onMemberFinish: ({ id, status }) => finished.push(`${id}:${status}`),
      },
      async (member) => {
        runnerCalls += 1;
        return { exitCode: ExitCode.Success, result: envelope(member.id, true) };
      },
    );

    expect(runnerCalls).toBe(0);
    expect(execution.exitCode).toBe(ExitCode.Interrupted);
    expect(execution.result.data?.summary).toEqual({
      passed: 0,
      failed: 0,
      cancelled: 3,
      skipped: 0,
    });
    expect(finished).toEqual(["usb:cancelled", "emulator:cancelled", "lab:cancelled"]);
  });

  test("builds isolated child argv without leaking pool or competing selectors", () => {
    expect(
      targetPoolMemberArguments(
        [
          "run",
          "--pool",
          "smoke",
          "--max-concurrency=2",
          "--fail-fast",
          "--device",
          "OLD",
          "--json",
          "--",
          "npm",
          "test",
        ],
        members[2] as Extract<(typeof members)[number], { kind: "remote-adb" }>,
      ),
    ).toEqual([
      "run",
      "--format",
      "json",
      "--non-interactive",
      "--no-color",
      "--no-animation",
      "--adb-host",
      "lab.internal",
      "--adb-port",
      "5038",
      "--device",
      "REMOTE-1",
      "--",
      "npm",
      "test",
    ]);
  });
});
