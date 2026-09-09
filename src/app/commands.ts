import { randomUUID } from "node:crypto";
import { AdbClient } from "../adb/client.js";
import type { AdbDevice, AdbVersion } from "../adb/parsers.js";
import { EventBus } from "../core/event-bus.js";
import { redactText } from "../core/redaction.js";
import {
  ExitCode,
  type Problem,
  type ResultEnvelope,
  SCHEMA_VERSION,
} from "../domain/contracts.js";
import {
  adbNotFoundProblem,
  adbOptionalProbeProblem,
  adbProcessProblem,
  noTargetsProblem,
  ProblemCode,
  problemsForDevices,
} from "../domain/problems.js";
import { locateAdb } from "../platform/executable.js";
import type { ProcessResult, ProcessRunner } from "../platform/process-runner.js";
import { detectRuntime, type RuntimeInfo } from "../platform/runtime.js";

export interface CommandConfig {
  adbPath?: string;
  adbHost?: string;
  adbPort?: number;
  timeoutMs?: number;
}

export interface CommandDependencies {
  bus?: EventBus;
  clock?: () => Date;
  idFactory?: () => string;
  locateAdb?: typeof locateAdb;
  runner?: ProcessRunner;
  runtime?: () => RuntimeInfo;
}

export interface CommandExecution<T> {
  result: ResultEnvelope<T>;
  exitCode: ExitCode;
}

export interface DoctorData {
  runtime: RuntimeInfo;
  adb: {
    path: string;
    version: Omit<AdbVersion, "raw">;
    hostFeatures: string[];
    serverStatus: Record<string, string> | null;
  };
  devices: AdbDevice[];
}

export interface DevicesData {
  adbPath: string;
  devices: AdbDevice[];
}

interface CommandContext {
  bus: EventBus;
  clock: () => Date;
  command: string;
  commandId: string;
  started: Date;
}

function processSucceeded(result: ProcessResult): boolean {
  return (
    result.spawnError === undefined && result.exitCode === 0 && !result.timedOut && !result.aborted
  );
}

function exitCodeForProblems(problems: readonly Problem[]): ExitCode {
  const errors = problems.filter(({ severity }) => severity === "error");
  if (errors.length === 0) {
    return ExitCode.Success;
  }
  if (errors.some(({ code }) => code === ProblemCode.OperationInterrupted)) {
    return ExitCode.Interrupted;
  }
  if (errors.some(({ category }) => category.startsWith("environment."))) {
    return ExitCode.Environment;
  }
  if (errors.some(({ category }) => category.startsWith("target."))) {
    return ExitCode.Target;
  }
  return ExitCode.AdbOperation;
}

function createContext(command: string, dependencies: CommandDependencies): CommandContext {
  const clock = dependencies.clock ?? (() => new Date());
  const commandId = (dependencies.idFactory ?? randomUUID)();
  const bus = dependencies.bus ?? new EventBus(clock);
  const started = clock();

  bus.emit({
    type: "command.started",
    source: `command.${command}`,
    severity: "info",
    message: `Running ${command}`,
    correlation: { commandId },
  });

  return { bus, clock, command, commandId, started };
}

function finish<T>(
  context: CommandContext,
  data: T | null,
  problems: Problem[],
): CommandExecution<T> {
  const finished = context.clock();
  const exitCode = exitCodeForProblems(problems);
  const ok = exitCode === ExitCode.Success;
  const result: ResultEnvelope<T> = {
    schemaVersion: SCHEMA_VERSION,
    command: context.command,
    commandId: context.commandId,
    ok,
    startedAt: context.started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: Math.max(0, finished.getTime() - context.started.getTime()),
    data,
    problems,
  };

  context.bus.emit({
    type: ok ? "command.completed" : "command.failed",
    source: `command.${context.command}`,
    severity: ok ? "info" : "error",
    message: ok ? `${context.command} completed` : `${context.command} failed`,
    correlation: { commandId: context.commandId },
    data: { exitCode, problemCount: problems.length },
  });

  return { result, exitCode };
}

function redactedPath(value: string): string {
  return redactText(value).value;
}

function redactedRecord(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, redactText(value).value]),
  );
}

async function resolveAdb(
  context: CommandContext,
  config: CommandConfig,
  dependencies: CommandDependencies,
): Promise<string | undefined> {
  const operationId = (dependencies.idFactory ?? randomUUID)();
  const correlation = { commandId: context.commandId, operationId };
  context.bus.emit({
    type: "operation.started",
    source: "host.adb-path",
    severity: "info",
    message: "Locating ADB",
    correlation,
  });

  const executable = await (dependencies.locateAdb ?? locateAdb)({
    ...(config.adbPath === undefined ? {} : { explicitPath: config.adbPath }),
  });

  context.bus.emit({
    type: executable === undefined ? "operation.failed" : "operation.completed",
    source: "host.adb-path",
    severity: executable === undefined ? "error" : "info",
    message: executable === undefined ? "ADB was not found" : "ADB was found",
    correlation,
    ...(executable === undefined ? {} : { data: { path: redactedPath(executable) } }),
  });

  return executable;
}

function createClient(
  executable: string,
  context: CommandContext,
  config: CommandConfig,
  dependencies: CommandDependencies,
): AdbClient {
  return new AdbClient({
    executable,
    bus: context.bus,
    correlation: { commandId: context.commandId },
    ...(config.adbHost === undefined ? {} : { host: config.adbHost }),
    ...(config.adbPort === undefined ? {} : { port: config.adbPort }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(dependencies.runner === undefined ? {} : { runner: dependencies.runner }),
    ...(dependencies.idFactory === undefined ? {} : { idFactory: dependencies.idFactory }),
  });
}

function operationProblem(
  operation: string,
  observation: { operationId: string; process: ProcessResult },
  commandId: string,
): Problem {
  return adbProcessProblem(operation, observation.process, {
    commandId,
    operationId: observation.operationId,
  });
}

export async function runDoctor(
  config: CommandConfig = {},
  dependencies: CommandDependencies = {},
  signal?: AbortSignal,
): Promise<CommandExecution<DoctorData>> {
  const context = createContext("doctor", dependencies);
  const problems: Problem[] = [];
  const executable = await resolveAdb(context, config, dependencies);
  if (executable === undefined) {
    problems.push(adbNotFoundProblem({ commandId: context.commandId }, config.adbPath));
    return finish<DoctorData>(context, null, problems);
  }

  const client = createClient(executable, context, config, dependencies);
  const version = await client.version(signal);
  if (!processSucceeded(version.process)) {
    problems.push(operationProblem("version", version, context.commandId));
    return finish<DoctorData>(context, null, problems);
  }

  const hostFeatures = await client.hostFeatures(signal);
  if (!processSucceeded(hostFeatures.process)) {
    const problem = operationProblem("host-features", hostFeatures, context.commandId);
    if (problem.code === ProblemCode.OperationInterrupted) {
      problems.push(problem);
      return finish<DoctorData>(context, null, problems);
    }
    problems.push(
      adbOptionalProbeProblem("host-features", hostFeatures.process, problem.correlation),
    );
  }

  let serverStatus: Record<string, string> | null = null;
  if (processSucceeded(hostFeatures.process) && hostFeatures.value.includes("server_status")) {
    const status = await client.serverStatus(signal);
    if (processSucceeded(status.process)) {
      serverStatus = redactedRecord(status.value);
    } else {
      const problem = operationProblem("server-status", status, context.commandId);
      if (problem.code === ProblemCode.OperationInterrupted) {
        problems.push(problem);
        return finish<DoctorData>(context, null, problems);
      }
      problems.push(adbOptionalProbeProblem("server-status", status.process, problem.correlation));
    }
  }

  const devices = await client.devices(signal);
  if (!processSucceeded(devices.process)) {
    problems.push(operationProblem("devices", devices, context.commandId));
    return finish<DoctorData>(context, null, problems);
  }

  problems.push(...problemsForDevices(devices.value, { commandId: context.commandId }, "warning"));
  if (devices.value.length === 0) {
    problems.push(noTargetsProblem({ commandId: context.commandId }));
  }

  const versionData: Omit<AdbVersion, "raw"> = {
    ...(version.value.protocolVersion === undefined
      ? {}
      : { protocolVersion: version.value.protocolVersion }),
    ...(version.value.platformToolsVersion === undefined
      ? {}
      : { platformToolsVersion: version.value.platformToolsVersion }),
    ...(version.value.installedAs === undefined
      ? {}
      : { installedAs: redactedPath(version.value.installedAs) }),
  };

  return finish(
    context,
    {
      runtime: (dependencies.runtime ?? detectRuntime)(),
      adb: {
        path: redactedPath(executable),
        version: versionData,
        hostFeatures: processSucceeded(hostFeatures.process) ? hostFeatures.value : [],
        serverStatus,
      },
      devices: devices.value,
    },
    problems,
  );
}

export async function runDevices(
  config: CommandConfig = {},
  dependencies: CommandDependencies = {},
  signal?: AbortSignal,
): Promise<CommandExecution<DevicesData>> {
  const context = createContext("devices", dependencies);
  const problems: Problem[] = [];
  const executable = await resolveAdb(context, config, dependencies);
  if (executable === undefined) {
    problems.push(adbNotFoundProblem({ commandId: context.commandId }, config.adbPath));
    return finish<DevicesData>(context, null, problems);
  }

  const client = createClient(executable, context, config, dependencies);
  const devices = await client.devices(signal);
  if (!processSucceeded(devices.process)) {
    problems.push(operationProblem("devices", devices, context.commandId));
    return finish<DevicesData>(context, null, problems);
  }

  problems.push(...problemsForDevices(devices.value, { commandId: context.commandId }, "warning"));
  if (devices.value.length === 0) {
    problems.push(noTargetsProblem({ commandId: context.commandId }));
  }

  return finish(context, { adbPath: redactedPath(executable), devices: devices.value }, problems);
}
