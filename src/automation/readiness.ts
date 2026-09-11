import { connect } from "node:net";
import type { AdbClient, AdbTargetSelector } from "../adb/client.js";
import { parseForegroundActivity } from "../app/android-app.js";
import type { Problem } from "../domain/contracts.js";
import { ProblemCode } from "../domain/problems.js";
import { parseUiHierarchy, type UiNode } from "../evidence/ui-hierarchy.js";

export type ReadinessAssertion =
  | { kind: "activity"; value: string }
  | { kind: "boot" }
  | { kind: "foreground"; package: string }
  | { kind: "host-port"; host?: string; port: number }
  | { kind: "http"; url: string; status?: number[] }
  | { kind: "log"; contains: string; absent?: boolean }
  | { kind: "process"; package: string }
  | { kind: "ui"; selector: string; state?: "gone" | "visible" }
  | { kind: "unlocked" };

export type ReadinessAssertionStatus = "failed" | "passed" | "skipped" | "unsupported";

export interface ReadinessAssertionResult {
  assertion: ReadinessAssertion;
  status: ReadinessAssertionStatus;
  detail: string;
  durationMs: number;
}

export interface ReadinessResult {
  ready: boolean;
  attempts: number;
  durationMs: number;
  timedOut: boolean;
  assertions: ReadinessAssertionResult[];
}

export type ReadinessProbe = (
  assertion: ReadinessAssertion,
  signal?: AbortSignal,
) => Promise<ReadinessAssertionResult>;

export interface WaitForReadinessOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  clock?: () => Date;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  onAttempt?: (attempt: number, results: readonly ReadinessAssertionResult[]) => void;
}

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

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

export async function waitForReadiness(
  assertions: readonly ReadinessAssertion[],
  probe: ReadinessProbe,
  options: WaitForReadinessOptions = {},
): Promise<ReadinessResult> {
  const clock = options.clock ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("readiness timeoutMs must be a positive integer");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new RangeError("readiness pollIntervalMs must be a positive integer");
  }
  const startedAt = clock().getTime();
  if (assertions.length === 0) {
    return { ready: true, attempts: 0, durationMs: 0, timedOut: false, assertions: [] };
  }
  let attempts = 0;
  let latest: ReadinessAssertionResult[] = [];
  while (options.signal?.aborted !== true) {
    attempts += 1;
    latest = [];
    for (const assertion of assertions) {
      latest.push(await probe(assertion, options.signal));
    }
    options.onAttempt?.(attempts, latest);
    if (latest.length === assertions.length && latest.every(({ status }) => status === "passed")) {
      return {
        ready: true,
        attempts,
        durationMs: Math.max(0, clock().getTime() - startedAt),
        timedOut: false,
        assertions: latest,
      };
    }
    if (latest.some(({ status }) => status === "unsupported")) break;
    const elapsed = clock().getTime() - startedAt;
    if (elapsed >= timeoutMs) break;
    await sleep(Math.min(pollIntervalMs, timeoutMs - elapsed), options.signal);
  }
  const durationMs = Math.max(0, clock().getTime() - startedAt);
  return {
    ready: false,
    attempts,
    durationMs,
    timedOut: durationMs >= timeoutMs,
    assertions: latest,
  };
}

export interface AdbReadinessProbeOptions {
  client: AdbClient;
  target: AdbTargetSelector;
  logLines?: () => readonly string[];
  clock?: () => Date;
  connectPort?: (host: string, port: number, signal?: AbortSignal) => Promise<boolean>;
  fetchUrl?: (url: string, signal?: AbortSignal) => Promise<number>;
}

function succeeded(process: {
  exitCode: number | null;
  spawnError?: unknown;
  timedOut: boolean;
}): boolean {
  return process.spawnError === undefined && process.exitCode === 0 && !process.timedOut;
}

async function portReachable(host: string, port: number, signal?: AbortSignal): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    const finish = (ready: boolean): void => {
      signal?.removeEventListener("abort", abort);
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    const abort = () => finish(false);
    socket.setTimeout(750);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function httpStatus(url: string, signal?: AbortSignal): Promise<number> {
  const response = await fetch(url, signal === undefined ? {} : { signal });
  await response.body?.cancel();
  return response.status;
}

function activityMatches(actual: string, expected: string): boolean {
  return actual === expected || actual.endsWith(`/${expected}`) || actual.endsWith(expected);
}

function selectorMatches(selector: string, node: UiNode): boolean {
  const separator = selector.indexOf("=");
  const kind = selector.slice(0, separator);
  const value = selector.slice(separator + 1);
  if (separator < 1 || value === "") return false;
  if (kind === "id") return node.resourceId === value;
  if (kind === "text") return node.text === value;
  if (kind === "desc") return node.contentDescription === value;
  return kind === "package" && node.packageName === value;
}

export function createAdbReadinessProbe(options: AdbReadinessProbeOptions): ReadinessProbe {
  const clock = options.clock ?? (() => new Date());
  return async (assertion, signal) => {
    const startedAt = clock().getTime();
    const result = (
      status: ReadinessAssertionStatus,
      detail: string,
    ): ReadinessAssertionResult => ({
      assertion,
      status,
      detail,
      durationMs: Math.max(0, clock().getTime() - startedAt),
    });
    try {
      if (assertion.kind === "host-port") {
        const host = assertion.host ?? "127.0.0.1";
        const ready = await (options.connectPort ?? portReachable)(host, assertion.port, signal);
        return result(
          ready ? "passed" : "failed",
          `${host}:${String(assertion.port)} is ${ready ? "reachable" : "not reachable"}.`,
        );
      }
      if (assertion.kind === "http") {
        const status = await (options.fetchUrl ?? httpStatus)(assertion.url, signal);
        const expected = assertion.status ?? [200, 204];
        return result(
          expected.includes(status) ? "passed" : "failed",
          `${assertion.url} returned HTTP ${String(status)}.`,
        );
      }
      if (assertion.kind === "log") {
        if (options.logLines === undefined) {
          return result("unsupported", "No bounded log stream is active for this run.");
        }
        const found = options.logLines().some((line) => line.includes(assertion.contains));
        const passed = assertion.absent === true ? !found : found;
        return result(
          passed ? "passed" : "failed",
          assertion.absent === true
            ? found
              ? "The forbidden log text was observed."
              : "The forbidden log text was not observed."
            : found
              ? "The expected log text was observed."
              : "The expected log text has not been observed yet.",
        );
      }
      if (assertion.kind === "boot") {
        const observation = await options.client.shell(
          options.target,
          ["getprop", "sys.boot_completed"],
          signal,
        );
        const passed = succeeded(observation.process) && observation.value?.trim() === "1";
        return result(
          passed ? "passed" : "failed",
          passed ? "Android boot completed." : "Android boot is not complete.",
        );
      }
      if (assertion.kind === "unlocked") {
        const observation = await options.client.shell(
          options.target,
          ["dumpsys", "window", "policy"],
          signal,
        );
        if (!succeeded(observation.process) || observation.value === undefined) {
          return result("failed", "Lock-screen state could not be read.");
        }
        const output = observation.value;
        const locked = /(?:isStatusBarKeyguard|mShowingLockscreen|showing)\s*[=:]\s*true/iu.test(
          output,
        );
        const known =
          /(?:isStatusBarKeyguard|mShowingLockscreen|showing)\s*[=:]\s*(?:true|false)/iu.test(
            output,
          );
        return !known
          ? result(
              "unsupported",
              "This Android build does not expose a recognized lock-screen state.",
            )
          : result(
              locked ? "failed" : "passed",
              locked ? "The target is locked." : "The target is unlocked.",
            );
      }
      if (assertion.kind === "process") {
        const observation = await options.client.shell(
          options.target,
          ["pidof", assertion.package],
          signal,
        );
        const passed =
          succeeded(observation.process) &&
          /^\d+(?:\s+\d+)*$/u.test(observation.value?.trim() ?? "");
        return result(
          passed ? "passed" : "failed",
          passed ? `${assertion.package} is running.` : `${assertion.package} is not running.`,
        );
      }
      if (assertion.kind === "foreground" || assertion.kind === "activity") {
        const observation = await options.client.shell(
          options.target,
          ["dumpsys", "activity", "activities"],
          signal,
        );
        const foreground =
          succeeded(observation.process) && observation.value !== undefined
            ? parseForegroundActivity(observation.value)
            : undefined;
        if (foreground === undefined)
          return result("failed", "The foreground activity could not be resolved.");
        const passed =
          assertion.kind === "foreground"
            ? foreground.applicationId === assertion.package
            : activityMatches(
                `${foreground.applicationId}/${foreground.activity}`,
                assertion.value,
              );
        return result(
          passed ? "passed" : "failed",
          `Foreground activity is ${foreground.applicationId}/${foreground.activity}.`,
        );
      }
      const observation = await options.client.targetCommand(
        options.target,
        "readiness-ui",
        `Checking UI selector ${assertion.selector}`,
        ["exec-out", "uiautomator", "dump", "/dev/tty"],
        (output) => output,
        signal,
        { maxBufferBytes: 4 * 1024 * 1024 },
      );
      if (!succeeded(observation.process))
        return result("failed", "The UI hierarchy could not be acquired.");
      const hierarchy = parseUiHierarchy(observation.value);
      if (hierarchy === undefined) {
        return result("unsupported", "Android returned no readable UI hierarchy.");
      }
      if (!/^(?:desc|id|package|text)=.{1,256}$/u.test(assertion.selector)) {
        return result("unsupported", `Unsupported UI selector: ${assertion.selector}.`);
      }
      const matches = hierarchy.nodes.filter((node) => selectorMatches(assertion.selector, node));
      const visible = matches.length > 0;
      const passed = (assertion.state ?? "visible") === "visible" ? visible : !visible;
      return result(
        passed ? "passed" : "failed",
        `${String(matches.length)} node(s) matched ${assertion.selector}.`,
      );
    } catch (error) {
      return result(
        signal?.aborted === true ? "skipped" : "failed",
        signal?.aborted === true
          ? "Readiness evaluation was cancelled."
          : `Readiness probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}

export function readinessProblem(
  readiness: ReadinessResult,
  commandId: string,
  targetId?: string,
): Problem {
  const unsupported = readiness.assertions.filter(({ status }) => status === "unsupported");
  return {
    code: unsupported.length > 0 ? ProblemCode.ReadinessUnsupported : ProblemCode.ReadinessFailed,
    category: "app.readiness",
    severity: "error",
    summary:
      unsupported.length > 0
        ? "One or more required readiness assertions are unsupported."
        : readiness.timedOut
          ? "The Android app did not become ready before the timeout."
          : "The Android app readiness contract failed.",
    detail:
      "Review each assertion result. Foreground, process, UI, network, and log checks are reported independently and are never inferred from one another.",
    retryable: unsupported.length === 0,
    evidence: readiness.assertions.map(({ assertion, detail, status }) => ({
      source: "readiness",
      field: assertion.kind,
      value: { status, detail },
    })),
    actions: [],
    correlation: { commandId, ...(targetId === undefined ? {} : { targetId }) },
  };
}
