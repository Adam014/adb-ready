import path from "node:path";
import process from "node:process";
import type { EventBus } from "../core/event-bus.js";
import { redactText } from "../core/redaction.js";
import { TextLineBuffer } from "../core/text-lines.js";
import type { Correlation } from "../domain/contracts.js";
import { type ProcessResult, type ProcessRunner, runProcess } from "../platform/process-runner.js";

export type DevHookEvent =
  | "beforeDev"
  | "finally"
  | "onChildExit"
  | "onPortsReady"
  | "onReady"
  | "onTargetReady";

export type HookFailurePolicy = "fail" | "ignore" | "warn";

export interface DevHook {
  run: [string, ...string[]];
  timeoutMs?: number;
  failure?: HookFailurePolicy;
  cwd?: string;
  envAllowlist?: string[];
}

export interface HookRun {
  event: DevHookEvent;
  index: number;
  failure: HookFailurePolicy;
  executable: string;
  args: string[];
  result: ProcessResult;
  ok: boolean;
}

export interface RunHooksOptions {
  hooks: Partial<Record<DevHookEvent, readonly DevHook[]>>;
  event: DevHookEvent;
  projectRoot: string;
  environment: Record<string, string>;
  bus: EventBus;
  correlation: Correlation;
  runner?: ProcessRunner;
  signal?: AbortSignal;
  hostEnv?: NodeJS.ProcessEnv;
}

const REQUIRED_ENVIRONMENT = ["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec", "TEMP", "TMP"];

function hookEnvironment(
  host: NodeJS.ProcessEnv,
  allowlist: readonly string[],
  provided: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const names = new Set([...REQUIRED_ENVIRONMENT, ...allowlist]);
  const environment: NodeJS.ProcessEnv = {};
  for (const name of names) {
    if (host[name] !== undefined) environment[name] = host[name];
  }
  return { ...environment, ...provided };
}

function succeeded(result: ProcessResult): boolean {
  return (
    result.exitCode === 0 &&
    result.spawnError === undefined &&
    result.streamError === undefined &&
    !result.timedOut &&
    !result.aborted
  );
}

export async function runHooks(options: RunHooksOptions): Promise<HookRun[]> {
  const hooks = options.hooks[options.event] ?? [];
  const runs: HookRun[] = [];
  const runner = options.runner ?? runProcess;
  for (const [index, hook] of hooks.entries()) {
    const [executable, ...args] = hook.run;
    const failure = hook.failure ?? "fail";
    const hookCorrelation = {
      ...options.correlation,
      operationId: `hook:${options.event}:${String(index)}`,
    };
    options.bus.emit({
      type: "hook.started",
      source: `hook.${options.event}`,
      severity: "info",
      message: `Running ${options.event} hook ${String(index + 1)}`,
      correlation: hookCorrelation,
      data: {
        executable: redactText(executable).value,
        args: args.map((argument) => redactText(argument).value),
        failure,
      },
    });
    const emitLine = (stream: "stderr" | "stdout", raw: string): void => {
      const safe = redactText(raw).value;
      options.bus.emit({
        type: `hook.${stream}`,
        source: `hook.${options.event}`,
        severity: "info",
        message: safe,
        correlation: hookCorrelation,
        data: { raw: safe, stream },
      });
    };
    const stdout = new TextLineBuffer((line) => emitLine("stdout", line));
    const stderr = new TextLineBuffer((line) => emitLine("stderr", line));
    const result = await runner({
      executable,
      args,
      cwd: path.resolve(options.projectRoot, hook.cwd ?? "."),
      env: hookEnvironment(
        options.hostEnv ?? process.env,
        hook.envAllowlist ?? [],
        options.environment,
      ),
      inheritEnv: false,
      timeoutMs: hook.timeoutMs ?? 10_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      maxBufferBytes: 256 * 1024,
      onStdoutChunk: (chunk) => stdout.push(chunk),
      onStderrChunk: (chunk) => stderr.push(chunk),
    });
    stdout.flush();
    stderr.flush();
    const ok = succeeded(result);
    const run: HookRun = {
      event: options.event,
      index,
      failure,
      executable: redactText(executable).value,
      args: args.map((argument) => redactText(argument).value),
      result,
      ok,
    };
    runs.push(run);
    options.bus.emit({
      type: ok ? "hook.finished" : "hook.failed",
      source: `hook.${options.event}`,
      severity: ok || failure === "ignore" ? "info" : failure === "warn" ? "warning" : "error",
      message: ok
        ? `${options.event} hook ${String(index + 1)} completed`
        : `${options.event} hook ${String(index + 1)} failed`,
      correlation: hookCorrelation,
      data: {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        aborted: result.aborted,
        failure,
      },
    });
    if (!ok && failure === "fail") break;
  }
  return runs;
}
