import {
  type RecoveryPolicyInput,
  recoveryAttemptAllowed,
  recoveryDelayMs,
  resolveRecoveryPolicy,
} from "./recovery-policy.js";
import { SessionStateMachine } from "./state-machine.js";

export interface WatchedPort {
  device: string;
  host: string;
}

export interface SessionHealth {
  targetReady: boolean;
  targetSerial: string;
  missingPorts: WatchedPort[];
  conflictingPorts: WatchedPort[];
  detail?: string;
}

export interface RecoveryOutcome {
  changedTarget: boolean;
  detail?: string;
}

export interface SessionWatchEvent {
  type:
    | "health.checked"
    | "session.degraded"
    | "recovery.started"
    | "recovery.failed"
    | "recovery.completed"
    | "watch.failed";
  health?: SessionHealth;
  attempt?: number;
  detail?: string;
}

export interface SessionWatchSummary {
  checks: number;
  degradations: number;
  recoveryAttempts: number;
  recoveries: number;
  targetChanges: number;
  failed: boolean;
  lastHealth?: SessionHealth;
}

export interface SessionWatchOptions {
  signal: AbortSignal;
  observe: (signal: AbortSignal) => Promise<SessionHealth>;
  recover: (
    health: SessionHealth,
    attempt: number,
    signal: AbortSignal,
  ) => Promise<RecoveryOutcome>;
  intervalMs?: number;
  policy?: RecoveryPolicyInput;
  clock?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<boolean>;
  onEvent?: (event: SessionWatchEvent) => void;
}

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

export function sessionHealthy(health: SessionHealth): boolean {
  return (
    health.targetReady && health.missingPorts.length === 0 && health.conflictingPorts.length === 0
  );
}

function failureDetail(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? `Health operation failed: ${error.message}`
    : "Health operation failed unexpectedly.";
}

export async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  positiveInteger(milliseconds, "milliseconds");
  if (signal.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function watchSession(options: SessionWatchOptions): Promise<SessionWatchSummary> {
  const intervalMs = options.intervalMs ?? 1_000;
  positiveInteger(intervalMs, "intervalMs");
  const policy = resolveRecoveryPolicy(options.policy);
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? abortableDelay;
  const machine = new SessionStateMachine();
  machine.transition("acquiring-target", "watcher received selected target");
  machine.transition("preparing-ports", "watcher received verified ports");
  machine.transition("starting-child", "watcher received running child");
  machine.transition("ready", "watching session health");
  const summary: SessionWatchSummary = {
    checks: 0,
    degradations: 0,
    recoveryAttempts: 0,
    recoveries: 0,
    targetChanges: 0,
    failed: false,
  };

  while (!options.signal.aborted) {
    if (!(await sleep(intervalMs, options.signal))) break;
    let health: SessionHealth;
    try {
      health = await options.observe(options.signal);
    } catch (error) {
      summary.failed = true;
      options.onEvent?.({ type: "watch.failed", detail: failureDetail(error) });
      return summary;
    }
    summary.checks += 1;
    summary.lastHealth = health;
    options.onEvent?.({ type: "health.checked", health });
    if (sessionHealthy(health)) continue;

    summary.degradations += 1;
    machine.transition("degraded", health.detail ?? "session health check failed");
    options.onEvent?.({
      type: "session.degraded",
      health,
      ...(health.detail === undefined ? {} : { detail: health.detail }),
    });
    const startedAt = clock();
    let recovered = false;
    let lastHealth = health;
    for (let attempt = 1; ; attempt += 1) {
      const elapsedMs = Math.max(0, clock() - startedAt);
      if (!recoveryAttemptAllowed(policy, attempt, elapsedMs)) break;
      machine.transition("recovering", `recovery attempt ${String(attempt)}`);
      summary.recoveryAttempts += 1;
      options.onEvent?.({ type: "recovery.started", health: lastHealth, attempt });
      if (!(await sleep(recoveryDelayMs(policy, attempt), options.signal))) break;
      let outcome: RecoveryOutcome;
      try {
        outcome = await options.recover(lastHealth, attempt, options.signal);
      } catch (error) {
        outcome = { changedTarget: false, detail: failureDetail(error) };
      }
      if (outcome.changedTarget) summary.targetChanges += 1;
      if (options.signal.aborted) break;
      let verified: SessionHealth;
      try {
        verified = await options.observe(options.signal);
      } catch (error) {
        machine.transition("degraded", "recovery verification failed unexpectedly");
        options.onEvent?.({
          type: "recovery.failed",
          health: lastHealth,
          attempt,
          detail: failureDetail(error),
        });
        continue;
      }
      summary.checks += 1;
      summary.lastHealth = verified;
      options.onEvent?.({ type: "health.checked", health: verified, attempt });
      if (sessionHealthy(verified)) {
        machine.transition("ready", "recovery independently verified");
        summary.recoveries += 1;
        recovered = true;
        options.onEvent?.({
          type: "recovery.completed",
          health: verified,
          attempt,
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        });
        break;
      }
      lastHealth = verified;
      machine.transition("degraded", verified.detail ?? "recovery verification failed");
      options.onEvent?.({
        type: "recovery.failed",
        health: verified,
        attempt,
        ...(outcome.detail === undefined && verified.detail === undefined
          ? {}
          : { detail: outcome.detail ?? verified.detail }),
      });
    }
    if (!recovered && !options.signal.aborted) {
      machine.transition("failed", "recovery budget exhausted");
      summary.failed = true;
      options.onEvent?.({
        type: "watch.failed",
        health: summary.lastHealth,
        detail: "Recovery budget exhausted.",
      });
      return summary;
    }
  }
  return summary;
}
