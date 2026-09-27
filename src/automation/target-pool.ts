import { randomUUID } from "node:crypto";
import type { ConfigTargetPool, ConfigTargetPoolMember } from "../config/types.js";
import {
  ExitCode,
  type Problem,
  type ResultEnvelope,
  SCHEMA_VERSION,
} from "../domain/contracts.js";

export type TargetPoolMemberStatus = "cancelled" | "failed" | "passed" | "skipped";

export interface TargetPoolMemberResult {
  id: string;
  kind: ConfigTargetPoolMember["kind"];
  required: boolean;
  status: TargetPoolMemberStatus;
  exitCode: number;
  result?: ResultEnvelope<unknown>;
}

export interface TargetPoolData {
  pool: string;
  maxConcurrency: number;
  failFast: boolean;
  coordination: "host-local-filesystem" | "provider-managed";
  members: TargetPoolMemberResult[];
  summary: { passed: number; failed: number; cancelled: number; skipped: number };
}

export interface TargetPoolExecution {
  exitCode: number;
  result: ResultEnvelope<TargetPoolData>;
}

export interface RunTargetPoolOptions {
  name: string;
  command?: "run pool" | "test firebase pool";
  pool: ConfigTargetPool;
  maxConcurrency?: number;
  failFast?: boolean;
  coordination?: TargetPoolData["coordination"];
  cancelRunningOnFailFast?: boolean;
  clock?: () => Date;
  idFactory?: () => string;
  signal?: AbortSignal;
  onMemberStart?: (member: ConfigTargetPoolMember) => void;
  onMemberFinish?: (result: TargetPoolMemberResult) => void;
}

export type TargetPoolMemberRunner = (
  member: ConfigTargetPoolMember,
  signal: AbortSignal,
) => Promise<{ exitCode: number; result: ResultEnvelope<unknown> }>;

function skipped(
  member: ConfigTargetPoolMember,
  status: "cancelled" | "skipped",
): TargetPoolMemberResult {
  return {
    id: member.id,
    kind: member.kind,
    required: member.required !== false,
    status,
    exitCode: ExitCode.Interrupted,
  };
}

export async function runTargetPool(
  options: RunTargetPoolOptions,
  runMember: TargetPoolMemberRunner,
): Promise<TargetPoolExecution> {
  const started = (options.clock ?? (() => new Date()))();
  const commandId = options.idFactory?.() ?? randomUUID();
  const maxConcurrency = options.maxConcurrency ?? options.pool.maxConcurrency;
  const failFast = options.failFast ?? options.pool.failFast;
  const controller = new AbortController();
  const cancel = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted === true) cancel();

  const members = options.pool.members;
  const results = new Array<TargetPoolMemberResult | undefined>(members.length);
  let nextIndex = 0;
  let stopScheduling = controller.signal.aborted;

  const worker = async (): Promise<void> => {
    while (!stopScheduling) {
      const index = nextIndex;
      nextIndex += 1;
      const member = members[index];
      if (member === undefined) return;
      if (controller.signal.aborted) {
        results[index] = skipped(member, "cancelled");
        options.onMemberFinish?.(results[index]);
        return;
      }
      try {
        options.onMemberStart?.(member);
        const executed = await runMember(member, controller.signal);
        const status: TargetPoolMemberStatus =
          executed.exitCode === ExitCode.Success
            ? "passed"
            : controller.signal.aborted
              ? "cancelled"
              : "failed";
        results[index] = {
          id: member.id,
          kind: member.kind,
          required: member.required !== false,
          status,
          exitCode: executed.exitCode,
          result: executed.result,
        };
        options.onMemberFinish?.(results[index]);
        if (failFast && member.required !== false && status !== "passed") {
          stopScheduling = true;
          if (options.cancelRunningOnFailFast !== false) {
            controller.abort(new Error(`Required pool member ${member.id} failed.`));
          }
        }
      } catch (caught) {
        const interrupted = controller.signal.aborted;
        results[index] = {
          id: member.id,
          kind: member.kind,
          required: member.required !== false,
          status: interrupted ? "cancelled" : "failed",
          exitCode: interrupted ? ExitCode.Interrupted : ExitCode.Internal,
        };
        options.onMemberFinish?.(results[index]);
        if (failFast && member.required !== false) {
          stopScheduling = true;
          if (options.cancelRunningOnFailFast !== false) controller.abort(caught);
        }
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(maxConcurrency, members.length) }, async () => await worker()),
  );
  options.signal?.removeEventListener("abort", cancel);
  for (let index = 0; index < members.length; index += 1) {
    if (results[index] === undefined) {
      const member = members[index];
      if (member !== undefined) {
        const result = skipped(member, controller.signal.aborted ? "cancelled" : "skipped");
        results[index] = result;
        options.onMemberFinish?.(result);
      }
    }
  }

  const completed = results.filter(
    (result): result is TargetPoolMemberResult => result !== undefined,
  );
  const summary = {
    passed: completed.filter(({ status }) => status === "passed").length,
    failed: completed.filter(({ status }) => status === "failed").length,
    cancelled: completed.filter(({ status }) => status === "cancelled").length,
    skipped: completed.filter(({ status }) => status === "skipped").length,
  };
  const requiredFailure = completed.find(({ required, status }) => required && status !== "passed");
  const exitCode =
    requiredFailure === undefined
      ? ExitCode.Success
      : requiredFailure.status === "cancelled" || requiredFailure.status === "skipped"
        ? ExitCode.Interrupted
        : requiredFailure.exitCode;
  const finished = (options.clock ?? (() => new Date()))();
  const problems: Problem[] =
    requiredFailure === undefined
      ? []
      : [
          {
            code: "TARGET_POOL_REQUIRED_MEMBER_FAILED",
            category: "automation.pool",
            severity: "error",
            summary: `Required target pool member ${requiredFailure.id} did not pass.`,
            detail: `The aggregate preserves every member result and cannot succeed while a required member is ${requiredFailure.status}.`,
            retryable: true,
            evidence: [
              { source: "target.pool", field: "member", value: requiredFailure.id },
              { source: "target.pool", field: "status", value: requiredFailure.status },
            ],
            actions: [],
            correlation: { commandId },
          },
        ];
  return {
    exitCode,
    result: {
      schemaVersion: SCHEMA_VERSION,
      command: options.command ?? "run pool",
      commandId,
      ok: exitCode === ExitCode.Success,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: Math.max(0, finished.getTime() - started.getTime()),
      data: {
        pool: options.name,
        maxConcurrency,
        failFast,
        coordination: options.coordination ?? "host-local-filesystem",
        members: completed,
        summary,
      },
      problems,
    },
  };
}

const VALUE_OPTIONS = new Set([
  "--pool",
  "--max-concurrency",
  "--lease-wait",
  "--device",
  "--serial",
  "-s",
  "--transport-id",
  "--avd",
  "--adb-host",
  "--adb-port",
  "--format",
]);
const FLAG_OPTIONS = new Set([
  "--fail-fast",
  "--no-fail-fast",
  "--json",
  "--select",
  "--last",
  "--non-interactive",
  "--color",
  "--no-color",
  "--animation",
  "--no-animation",
]);

export function targetPoolMemberArguments(
  argv: readonly string[],
  member: Exclude<ConfigTargetPoolMember, { kind: "firebase" }>,
): string[] {
  const separator = argv.indexOf("--");
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const passthrough = separator === -1 ? [] : argv.slice(separator);
  const retained: string[] = [];
  for (let index = 0; index < options.length; index += 1) {
    const argument = options[index];
    if (argument === undefined) continue;
    const option = argument.split("=", 1)[0] ?? argument;
    if (VALUE_OPTIONS.has(option)) {
      if (!argument.includes("=")) index += 1;
      continue;
    }
    if (FLAG_OPTIONS.has(option)) continue;
    retained.push(argument);
  }
  retained.push("--format", "json", "--non-interactive", "--no-color", "--no-animation");
  if (member.kind === "adb") retained.push("--device", member.serial);
  else if (member.kind === "avd") retained.push("--avd", member.name);
  else {
    retained.push(
      "--adb-host",
      member.host,
      "--adb-port",
      String(member.port),
      "--device",
      member.serial,
    );
  }
  return [...retained, ...passthrough];
}
