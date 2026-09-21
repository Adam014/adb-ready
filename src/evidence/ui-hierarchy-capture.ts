import process from "node:process";
import type { AdbClient, AdbObservation, AdbTargetSelector } from "../adb/client.js";
import { problem } from "../app/app-commands.js";
import type { Problem } from "../domain/contracts.js";
import { acquireTargetLease, type TargetLeaseOptions } from "../state/target-lease.js";

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
