import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdbClient,
  AdbCommandOptions,
  AdbObservation,
  AdbTargetSelector,
} from "../../src/adb/client.js";
import { captureUiHierarchy } from "../../src/evidence/ui-hierarchy-capture.js";
import type { ProcessResult } from "../../src/platform/process-runner.js";
import { acquireTargetLease } from "../../src/state/target-lease.js";

function processResult(stdout: string): ProcessResult {
  return {
    executable: "adb",
    args: ["exec-out", "uiautomator", "dump", "/dev/tty"],
    startedAt: "2026-09-21T10:00:00.000Z",
    finishedAt: "2026-09-21T10:00:00.010Z",
    durationMs: 10,
    exitCode: 0,
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

function client(run: (target: AdbTargetSelector) => Promise<string>): AdbClient {
  return {
    async targetCommand<T>(
      target: string | AdbTargetSelector,
      _operation: string,
      _message: string,
      _args: readonly string[],
      parse: (output: string) => T,
      _signal?: AbortSignal,
      _options?: AdbCommandOptions,
    ): Promise<AdbObservation<T>> {
      const selected = typeof target === "string" ? { serial: target } : target;
      const output = await run(selected);
      return { operationId: "ui-dump", process: processResult(output), value: parse(output) };
    },
  } as AdbClient;
}

function capture(
  adb: AdbClient,
  directory: string,
  targetIdentity: string,
  signal?: AbortSignal,
  timeoutMs = 1_000,
) {
  return captureUiHierarchy({
    client: adb,
    target: { serial: targetIdentity },
    targetIdentity,
    commandId: "command-1",
    operation: "inspect-ui",
    message: "Reading Android accessibility hierarchy",
    timeoutMs,
    maxBufferBytes: 1_024,
    ...(signal === undefined ? {} : { signal }),
    lock: { lease: { directory, heartbeatIntervalMs: 0 }, pollIntervalMs: 5 },
  });
}

describe("UI hierarchy capture coordination", () => {
  test("serializes concurrent captures for one Android target", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-ui-lock-"));
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    let releaseFirst = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let enteredFirst = (): void => undefined;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const adb = client(async () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 1) {
        enteredFirst();
        await firstGate;
      }
      active -= 1;
      return "<hierarchy />";
    });
    try {
      const first = capture(adb, directory, "hardware:pixel-1");
      await firstEntered;
      const second = capture(adb, directory, "hardware:pixel-1");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toBe(1);
      releaseFirst();
      expect((await first).ok).toBeTrue();
      expect((await second).ok).toBeTrue();
      expect(maximumActive).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not serialize independent Android targets", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-ui-lock-"));
    let active = 0;
    let maximumActive = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let bothEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      bothEntered = resolve;
    });
    const adb = client(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (active === 2) bothEntered();
      await gate;
      active -= 1;
      return "<hierarchy />";
    });
    try {
      const first = capture(adb, directory, "hardware:pixel-1");
      const second = capture(adb, directory, "hardware:pixel-2");
      await entered;
      release();
      expect((await first).ok).toBeTrue();
      expect((await second).ok).toBeTrue();
      expect(maximumActive).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("returns bounded busy, cancellation, and unavailable-state problems", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-ui-lock-"));
    let calls = 0;
    const adb = client(async () => {
      calls += 1;
      return "<hierarchy />";
    });
    const held = await acquireTargetLease(
      {
        targetIdentity: "ui-automation:hardware:pixel-1",
        projectRoot: process.cwd(),
        purpose: "fixture",
      },
      { directory, heartbeatIntervalMs: 0 },
    );
    expect(held.ok).toBeTrue();
    try {
      const busy = await capture(adb, directory, "hardware:pixel-1", undefined, 20);
      expect(busy).toMatchObject({
        ok: false,
        problem: { code: "UI_HIERARCHY_BUSY", retryable: true },
      });

      const controller = new AbortController();
      const cancelled = capture(adb, directory, "hardware:pixel-1", controller.signal);
      controller.abort();
      expect(await cancelled).toMatchObject({
        ok: false,
        problem: { code: "UI_HIERARCHY_CANCELLED" },
      });
      expect(calls).toBe(0);
    } finally {
      if (held.ok) await held.lease.release();
      await rm(directory, { recursive: true, force: true });
    }

    const blockedRoot = await mkdtemp(path.join(tmpdir(), "adb-ready-ui-lock-"));
    const unavailable = path.join(blockedRoot, "state-file");
    try {
      await writeFile(unavailable, "blocked\n");
      const result = await capture(adb, unavailable, "hardware:pixel-1");
      expect(result).toMatchObject({
        ok: false,
        problem: { code: "UI_HIERARCHY_LOCK_UNAVAILABLE", category: "environment.state" },
      });
    } finally {
      await rm(blockedRoot, { recursive: true, force: true });
    }
  });
});
