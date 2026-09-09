import { randomUUID } from "node:crypto";
import { AdbClient } from "../adb/client.js";
import type { AdbDevice, AdbMdnsService, AdbVersion } from "../adb/parsers.js";
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
  targetSelectionProblem,
} from "../domain/problems.js";
import { locateAdb } from "../platform/executable.js";
import type { ProcessResult, ProcessRunner } from "../platform/process-runner.js";
import { detectRuntime, type RuntimeInfo } from "../platform/runtime.js";
import { type AndroidTarget, buildTargetInventory, isStableAdbSerial } from "../target/model.js";
import { type SelectedTarget, selectTarget } from "../target/selection.js";

export interface CommandConfig {
  adbPath?: string;
  adbHost?: string;
  adbPort?: number;
  timeoutMs?: number;
  targetSelector?: string;
  targetTransportId?: string;
  targetAliases?: Readonly<Record<string, string>>;
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
  targets: AndroidTarget[];
  discovery: TargetDiscoveryData;
}

export interface DevicesData {
  adbPath: string;
  devices: AdbDevice[];
  targets: AndroidTarget[];
  discovery: TargetDiscoveryData;
  selected?: SelectedTarget;
}

export interface TargetDiscoveryData {
  mdns: {
    available: boolean;
    services: AdbMdnsService[];
  };
  identity: {
    probed: number;
    resolved: number;
  };
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

interface TargetInspection {
  targets: AndroidTarget[];
  discovery: TargetDiscoveryData;
  optionalProblems: Problem[];
  interruption?: Problem;
}

function normalizedHardwareSerial(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" || normalized.toLowerCase() === "unknown"
    ? undefined
    : normalized;
}

async function inspectTargets(
  client: AdbClient,
  devices: readonly AdbDevice[],
  commandId: string,
  signal: AbortSignal | undefined,
): Promise<TargetInspection> {
  const identityCandidates = devices.filter(
    ({ serial, state }) => state === "device" && isStableAdbSerial(serial),
  );
  const [mdns, identities] = await Promise.all([
    client.mdnsServices(signal),
    Promise.all(identityCandidates.map(({ serial }) => client.getHardwareSerial(serial, signal))),
  ]);
  const optionalProblems: Problem[] = [];
  const allObservations = [mdns, ...identities];
  const interrupted = allObservations.find(({ process }) => process.aborted);
  if (interrupted !== undefined) {
    return {
      targets: [],
      discovery: {
        mdns: { available: false, services: [] },
        identity: { probed: identityCandidates.length, resolved: 0 },
      },
      optionalProblems,
      interruption: operationProblem("target-discovery", interrupted, commandId),
    };
  }

  const mdnsAvailable = processSucceeded(mdns.process);
  if (!mdnsAvailable) {
    optionalProblems.push(
      adbOptionalProbeProblem("mdns-services", mdns.process, {
        commandId,
        operationId: mdns.operationId,
      }),
    );
  }

  const identityBySerial = new Map<string, string>();
  identities.forEach((identity, index) => {
    if (!processSucceeded(identity.process)) {
      return;
    }
    const hardwareSerial = normalizedHardwareSerial(identity.value);
    const candidate = identityCandidates[index];
    if (hardwareSerial !== undefined && candidate !== undefined) {
      identityBySerial.set(candidate.serial, hardwareSerial);
    }
  });
  const services = mdnsAvailable ? mdns.value : [];
  const inventory = buildTargetInventory(
    devices.map((device) => {
      const hardwareSerial = identityBySerial.get(device.serial);
      return {
        device,
        ...(hardwareSerial === undefined ? {} : { hardwareSerial }),
      };
    }),
    services,
  );

  return {
    targets: inventory.targets,
    discovery: {
      mdns: { available: mdnsAvailable, services: inventory.services },
      identity: { probed: identityCandidates.length, resolved: identityBySerial.size },
    },
    optionalProblems,
  };
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
  const inspection = await inspectTargets(client, devices.value, context.commandId, signal);
  if (inspection.interruption !== undefined) {
    problems.push(inspection.interruption);
    return finish<DoctorData>(context, null, problems);
  }
  problems.push(...inspection.optionalProblems);

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
      targets: inspection.targets,
      discovery: inspection.discovery,
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

  const inspection = await inspectTargets(client, devices.value, context.commandId, signal);
  if (inspection.interruption !== undefined) {
    problems.push(inspection.interruption);
    return finish<DevicesData>(context, null, problems);
  }

  let selected: SelectedTarget | undefined;
  if (config.targetSelector !== undefined || config.targetTransportId !== undefined) {
    const selection = selectTarget(inspection.targets, {
      ...(config.targetSelector === undefined ? {} : { selector: config.targetSelector }),
      ...(config.targetTransportId === undefined ? {} : { transportId: config.targetTransportId }),
      ...(config.targetAliases === undefined ? {} : { aliases: config.targetAliases }),
    });
    if (selection.kind !== "selected") {
      problems.push(targetSelectionProblem(selection, { commandId: context.commandId }));
    } else {
      selected = selection.selection;
    }
  }

  return finish(
    context,
    {
      adbPath: redactedPath(executable),
      devices: devices.value,
      targets: inspection.targets,
      discovery: inspection.discovery,
      ...(selected === undefined ? {} : { selected }),
    },
    problems,
  );
}
