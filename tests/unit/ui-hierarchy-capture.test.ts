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
import { acquireUiSnapshot, captureUiHierarchy } from "../../src/evidence/ui-hierarchy-capture.js";
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

  test("requires matching observations for strict acquisition and records its evidence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-ui-lock-"));
    const outputs = [
      '<hierarchy><node text="Loading" /></hierarchy>',
      '<hierarchy><node text="Ready" /></hierarchy>',
      '<hierarchy><node text="Ready" /></hierarchy>',
    ];
    let calls = 0;
    try {
      const acquired = await acquireUiSnapshot({
        client: client(async () => outputs[calls++] ?? outputs.at(-1) ?? ""),
        target: { serial: "emulator-5554" },
        targetIdentity: "hardware:pixel-1",
        commandId: "command-1",
        operation: "inspect-ui",
        message: "Reading hierarchy",
        timeoutMs: 1_000,
        maxBufferBytes: 1_024,
        profile: "strict",
        clock: () => new Date("2026-09-27T10:00:00.000Z"),
        settle: async () => undefined,
        lock: { lease: { directory, heartbeatIntervalMs: 0 }, pollIntervalMs: 5 },
      });
      expect(acquired).toMatchObject({
        ok: true,
        snapshot: {
          nodes: [{ text: "Ready" }],
          acquisition: {
            profile: "strict",
            source: "uiautomator",
            idleStrategy: "platform-idle",
            observedAt: "2026-09-27T10:00:00.000Z",
            freshness: "fresh",
            durationMs: 30,
            attempts: 3,
            stability: "verified",
          },
        },
      });
      expect(calls).toBe(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects empty and continuously unstable hierarchy observations", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-ui-lock-"));
    let calls = 0;
    try {
      const empty = await acquireUiSnapshot({
        client: client(async () => "<hierarchy />"),
        target: { serial: "emulator-5554" },
        targetIdentity: "hardware:pixel-1",
        commandId: "command-1",
        operation: "inspect-ui",
        message: "Reading hierarchy",
        timeoutMs: 1_000,
        maxBufferBytes: 1_024,
        lock: { lease: { directory, heartbeatIntervalMs: 0 }, pollIntervalMs: 5 },
      });
      expect(empty).toMatchObject({ ok: false, problem: { code: "UI_HIERARCHY_EMPTY" } });

      const unstable = await acquireUiSnapshot({
        client: client(async () => `<hierarchy><node text="${String(++calls)}" /></hierarchy>`),
        target: { serial: "emulator-5554" },
        targetIdentity: "hardware:pixel-1",
        commandId: "command-2",
        operation: "inspect-ui",
        message: "Reading hierarchy",
        timeoutMs: 1_000,
        maxBufferBytes: 1_024,
        profile: "strict",
        settle: async () => undefined,
        lock: { lease: { directory, heartbeatIntervalMs: 0 }, pollIntervalMs: 5 },
      });
      expect(unstable).toMatchObject({
        ok: false,
        problem: { code: "UI_HIERARCHY_UNSTABLE" },
      });
      expect(calls).toBe(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("classifies process cancellation and timeout during acquisition", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-ui-lock-"));
    const acquisitionClient = (state: "aborted" | "timedOut"): AdbClient =>
      ({
        async targetCommand<T>(
          _target: string | AdbTargetSelector,
          _operation: string,
          _message: string,
          _args: readonly string[],
          parse: (output: string) => T,
        ): Promise<AdbObservation<T>> {
          const output = '<hierarchy><node text="Ready" /></hierarchy>';
          return {
            operationId: "ui-dump",
            process: {
              ...processResult(output),
              ...(state === "aborted"
                ? { aborted: true, signal: "SIGTERM" }
                : { timedOut: true, exitCode: null, signal: "SIGTERM" }),
            },
            value: parse(output),
          };
        },
      }) as AdbClient;
    const acquire = (state: "aborted" | "timedOut") =>
      acquireUiSnapshot({
        client: acquisitionClient(state),
        target: { serial: "emulator-5554" },
        targetIdentity: "hardware:pixel-1",
        commandId: `command-${state}`,
        operation: "inspect-ui",
        message: "Reading hierarchy",
        timeoutMs: 1_000,
        maxBufferBytes: 1_024,
        lock: { lease: { directory, heartbeatIntervalMs: 0 }, pollIntervalMs: 5 },
      });

    try {
      expect(await acquire("aborted")).toMatchObject({
        ok: false,
        problem: { code: "UI_HIERARCHY_CANCELLED", category: "evidence.ui.cancelled" },
      });
      expect(await acquire("timedOut")).toMatchObject({
        ok: false,
        problem: { code: "UI_SNAPSHOT_TIMEOUT", category: "evidence.ui.timeout" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
