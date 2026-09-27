import process from "node:process";
import type { AdbClient, AdbObservation, AdbTargetSelector } from "../adb/client.js";
import { operationProblem, problem, succeeded } from "../app/app-commands.js";
import type { Problem } from "../domain/contracts.js";
import { acquireTargetLease, type TargetLeaseOptions } from "../state/target-lease.js";
import {
  classifyUiHierarchyFailure,
  FAST_UI_SNAPSHOT_TIMEOUT_MS,
  parseUiHierarchy,
  type UiAcquisitionProfile,
  type UiHierarchySnapshot,
} from "./ui-hierarchy.js";

const DEFAULT_LOCK_POLL_INTERVAL_MS = 50;

export interface UiHierarchyLockOptions {
  lease?: TargetLeaseOptions;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface UiHierarchyCaptureOptions {
  client: AdbClient;
  target: AdbTargetSelector;
  targetIdentity: string;
  commandId: string;
  operation: string;
  message: string;
  timeoutMs: number;
  maxBufferBytes: number;
  signal?: AbortSignal;
  lock?: UiHierarchyLockOptions;
}

export type UiHierarchyCaptureResult =
  | { ok: true; observation: AdbObservation<string> }
  | { ok: false; problem: Problem };

export interface UiSnapshotAcquisitionOptions extends UiHierarchyCaptureOptions {
  profile?: UiAcquisitionProfile;
  interactiveOnly?: boolean;
  maxDepth?: number;
  maxNodes?: number;
  clock?: () => Date;
  settle?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export type UiSnapshotAcquisitionResult =
  | { ok: true; snapshot: UiHierarchySnapshot }
  | { ok: false; problem: Problem };

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function lockProblem(
  code: "UI_HIERARCHY_CANCELLED" | "UI_HIERARCHY_LOCK_UNAVAILABLE" | "UI_HIERARCHY_BUSY",
  commandId: string,
): Problem {
  if (code === "UI_HIERARCHY_CANCELLED") {
    return problem(
      code,
      "evidence.ui.cancelled",
      "UI hierarchy capture was cancelled.",
      "Retry the operation when a hierarchy snapshot is still needed.",
      commandId,
    );
  }
  if (code === "UI_HIERARCHY_LOCK_UNAVAILABLE") {
    return problem(
      code,
      "environment.state",
      "ADB Ready could not coordinate Android UI hierarchy capture.",
      "Ensure the per-user ADB Ready state directory is writable, then retry.",
      commandId,
    );
  }
  return problem(
    code,
    "evidence.ui.busy",
    "Android UI hierarchy capture is busy on the selected target.",
    "Another process is using Android UI Automator. Wait for that capture to finish or increase the UI timeout, then retry.",
    commandId,
  );
}

export async function captureUiHierarchy(
  options: UiHierarchyCaptureOptions,
): Promise<UiHierarchyCaptureResult> {
  const now = options.lock?.now ?? Date.now;
  const sleep = options.lock?.sleep ?? defaultSleep;
  const pollIntervalMs = options.lock?.pollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new RangeError("UI hierarchy timeoutMs must be a positive integer");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new RangeError("UI hierarchy lock pollIntervalMs must be a positive integer");
  }

  const startedAt = now();
  while (options.signal?.aborted !== true) {
    const elapsed = Math.max(0, now() - startedAt);
    const remainingMs = options.timeoutMs - elapsed;
    if (remainingMs <= 0) {
      return { ok: false, problem: lockProblem("UI_HIERARCHY_BUSY", options.commandId) };
    }
    const acquired = await acquireTargetLease(
      {
        targetIdentity: `ui-automation:${options.targetIdentity}`,
        projectRoot: process.cwd(),
        purpose: "UI hierarchy capture",
      },
      options.lock?.lease,
    );
    if (acquired.ok) {
      try {
        return {
          ok: true,
          observation: await options.client.targetCommand(
            options.target,
            options.operation,
            options.message,
            ["exec-out", "uiautomator", "dump", "/dev/tty"],
            (output) => output,
            options.signal,
            { maxBufferBytes: options.maxBufferBytes, timeoutMs: remainingMs },
          ),
        };
      } finally {
        await acquired.lease.release();
      }
    }
    if (acquired.code === "TARGET_LEASE_UNAVAILABLE") {
      return {
        ok: false,
        problem: lockProblem("UI_HIERARCHY_LOCK_UNAVAILABLE", options.commandId),
      };
    }
    const waitMs = Math.min(pollIntervalMs, remainingMs);
    await sleep(waitMs, options.signal);
  }
  return { ok: false, problem: lockProblem("UI_HIERARCHY_CANCELLED", options.commandId) };
}

function acquisitionProblem(
  code:
    | "UI_HIERARCHY_CANCELLED"
    | "UI_HIERARCHY_EMPTY"
    | "UI_HIERARCHY_UNAVAILABLE"
    | "UI_HIERARCHY_UNSTABLE"
    | "UI_NOT_IDLE"
    | "UI_SNAPSHOT_TIMEOUT",
  commandId: string,
): Problem {
  if (code === "UI_HIERARCHY_CANCELLED") {
    return problem(
      code,
      "evidence.ui.cancelled",
      "UI hierarchy acquisition was cancelled.",
      "Retry only if a fresh UI observation is still required.",
      commandId,
    );
  }
  if (code === "UI_SNAPSHOT_TIMEOUT") {
    return problem(
      code,
      "evidence.ui.timeout",
      "Android did not return a UI hierarchy within the acquisition budget.",
      "Retry with the balanced or strict acquisition profile, or inspect whether the current screen is continuously changing.",
      commandId,
    );
  }
  if (code === "UI_NOT_IDLE") {
    return problem(
      code,
      "evidence.ui.busy",
      "Android UI did not become idle for hierarchy capture.",
      "Pause continuous animation or accessibility updates, then retry. Use fast only when a bounded failure is preferable to waiting.",
      commandId,
    );
  }
  if (code === "UI_HIERARCHY_EMPTY") {
    return problem(
      code,
      "evidence.ui.empty",
      "Android returned an empty UI hierarchy.",
      "The foreground window may be secure or its framework may not expose semantics. Capture a screenshot explicitly and inspect the app accessibility configuration.",
      commandId,
    );
  }
  if (code === "UI_HIERARCHY_UNSTABLE") {
    return problem(
      code,
      "evidence.ui.unstable",
      "The UI hierarchy kept changing during strict acquisition.",
      "Wait for the screen to settle or use the balanced profile when one fresh observation is sufficient.",
      commandId,
    );
  }
  return problem(
    code,
    "evidence.ui",
    "Android returned no readable UI hierarchy.",
    "The current window may be secure, inaccessible, or unsupported by UI Automator. Capture a screenshot explicitly when semantic evidence is unavailable.",
    commandId,
  );
}

export async function acquireUiSnapshot(
  options: UiSnapshotAcquisitionOptions,
): Promise<UiSnapshotAcquisitionResult> {
  const profile = options.profile ?? "balanced";
  const attemptsRequired = profile === "strict" ? 3 : 1;
  const timeoutMs =
    profile === "fast"
      ? Math.min(options.timeoutMs, FAST_UI_SNAPSHOT_TIMEOUT_MS)
      : options.timeoutMs;
  const startedAt = Date.now();
  const clock = options.clock ?? (() => new Date());
  const settle = options.settle ?? defaultSleep;
  let previous: UiHierarchySnapshot | undefined;
  let durationMs = 0;

  for (let attempt = 1; attempt <= attemptsRequired; attempt += 1) {
    const elapsed = Math.max(0, Date.now() - startedAt);
    if (elapsed >= timeoutMs) {
      return { ok: false, problem: acquisitionProblem("UI_SNAPSHOT_TIMEOUT", options.commandId) };
    }
    const remainingMs = timeoutMs - elapsed;
    const captured = await captureUiHierarchy({ ...options, timeoutMs: remainingMs });
    if (!captured.ok) return captured;
    durationMs += captured.observation.process.durationMs;
    const process = captured.observation.process;
    if (process.aborted || options.signal?.aborted === true) {
      return {
        ok: false,
        problem: acquisitionProblem("UI_HIERARCHY_CANCELLED", options.commandId),
      };
    }
    if (process.timedOut) {
      return { ok: false, problem: acquisitionProblem("UI_SNAPSHOT_TIMEOUT", options.commandId) };
    }
    if (!succeeded(process)) {
      return {
        ok: false,
        problem: operationProblem(options.operation, captured.observation, options.commandId),
      };
    }
    const snapshot = parseUiHierarchy(captured.observation.value, {
      ...(options.interactiveOnly === undefined
        ? {}
        : { interactiveOnly: options.interactiveOnly }),
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
      ...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
    });
    if (snapshot === undefined) {
      const reason = classifyUiHierarchyFailure(`${process.stdout}\n${process.stderr}`);
      return {
        ok: false,
        problem: acquisitionProblem(
          reason === "not-idle" ? "UI_NOT_IDLE" : "UI_HIERARCHY_UNAVAILABLE",
          options.commandId,
        ),
      };
    }
    if (snapshot.totalNodes === 0) {
      return { ok: false, problem: acquisitionProblem("UI_HIERARCHY_EMPTY", options.commandId) };
    }
    const observed = {
      ...snapshot,
      acquisition: {
        profile,
        source: "uiautomator" as const,
        idleStrategy: "platform-idle" as const,
        observedAt: clock().toISOString(),
        freshness: "fresh" as const,
        durationMs,
        attempts: attempt,
        stability: profile === "strict" ? ("verified" as const) : ("not-assessed" as const),
      },
    };
    if (profile !== "strict") return { ok: true, snapshot: observed };
    if (previous?.digest === snapshot.digest) return { ok: true, snapshot: observed };
    previous = snapshot;
    if (attempt < attemptsRequired) await settle(100, options.signal);
  }
  return { ok: false, problem: acquisitionProblem("UI_HIERARCHY_UNSTABLE", options.commandId) };
}
