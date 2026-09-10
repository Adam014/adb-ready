import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { AdbClient } from "../adb/client.js";
import {
  type AdbDevice,
  type AdbMdnsService,
  type AdbVersion,
  parseAdbNetworkEndpoint,
  parseLogcatThreadtimeLine,
} from "../adb/parsers.js";
import { EventBus } from "../core/event-bus.js";
import { EventJournal, type EventJournalSnapshot } from "../core/event-journal.js";
import { redactText } from "../core/redaction.js";
import { TextLineBuffer } from "../core/text-lines.js";
import {
  type DevPreset,
  detectProject,
  type PackageManagerName,
  type ProjectDetection,
  packageScriptCommand,
} from "../dev/project.js";
import {
  ExitCode,
  type OperationPlan,
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
  problemsForServerStatus,
  targetInventoryProblems,
  targetSelectionProblem,
} from "../domain/problems.js";
import { locateAdb, locateExecutable } from "../platform/executable.js";
import { type ProcessResult, type ProcessRunner, runProcess } from "../platform/process-runner.js";
import { detectRuntime, type RuntimeInfo } from "../platform/runtime.js";
import {
  mappingArguments,
  normalizePortMapping,
  type PortDirection,
  type TcpPortMapping,
  tcpEndpoint,
} from "../ports/model.js";
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
  rememberedSerial?: string;
  rememberedHardwareSerial?: string;
  rememberedOnly?: boolean;
  dryRun?: boolean;
  endpointWasDiscovered?: boolean;
  discoveredEndpointCandidates?: readonly string[];
}

export interface CommandDependencies {
  bus?: EventBus;
  clock?: () => Date;
  idFactory?: () => string;
  locateAdb?: typeof locateAdb;
  runner?: ProcessRunner;
  runtime?: () => RuntimeInfo;
  detectProject?: typeof detectProject;
  locateExecutable?: typeof locateExecutable;
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
    method: "legacy" | "legacy-fallback" | "track";
    services: AdbMdnsService[];
  };
  identity: {
    probed: number;
    resolved: number;
  };
}

export interface ConnectedData {
  adbPath: string;
  endpoint: string;
  status: "already-connected" | "connected";
  serial: string;
  state: "device";
  hardwareSerial?: string;
  discovered: boolean;
  attemptedEndpoints?: string[];
}

export interface PairedData {
  adbPath: string;
  endpoint: string;
  paired: true;
  discovered: boolean;
}

export interface WirelessPlanData {
  endpoint: string;
  discovered: boolean;
  plan: OperationPlan;
}

export type ConnectData = ConnectedData | WirelessPlanData;
export type PairData = PairedData | WirelessPlanData;

export interface WirelessDiscoveryData {
  adbPath: string;
  kind: "connect" | "pairing";
  services: AdbMdnsService[];
}

export type PortAction = "add" | "list" | "remove";

export interface PortCommandRequest {
  direction: PortDirection;
  action: PortAction;
  hostPort?: string | number;
  devicePort?: string | number;
}

export interface PortsData {
  adbPath: string;
  action: PortAction;
  direction: PortDirection;
  selected: SelectedTarget;
  mappings: TcpPortMapping[];
  status: "added" | "already-exists" | "listed" | "not-found" | "removed" | "planned";
  requested?: {
    host: string;
    device: string;
  };
  plan?: OperationPlan;
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
    result.spawnError === undefined &&
    result.streamError === undefined &&
    (result.exitCode === 0 || result.stoppedAfterIdle) &&
    !result.timedOut &&
    !result.aborted
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
  if (errors.some(({ category }) => category.startsWith("input."))) {
    return ExitCode.InvalidInput;
  }
  if (errors.some(({ category }) => category.startsWith("environment."))) {
    return ExitCode.Environment;
  }
  if (errors.some(({ category }) => category.startsWith("target."))) {
    return ExitCode.Target;
  }
  if (errors.some(({ category }) => category.startsWith("child."))) {
    return ExitCode.ChildProcess;
  }
  return ExitCode.AdbOperation;
}

function commandProblem(
  code: string,
  category: string,
  summary: string,
  detail: string,
  commandId: string,
  evidence: Problem["evidence"] = [],
): Problem {
  return {
    code,
    category,
    severity: "error",
    summary,
    detail,
    retryable: true,
    evidence,
    actions: [],
    correlation: { commandId },
  };
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

interface MdnsDiscovery {
  observation: Awaited<ReturnType<AdbClient["mdnsServices"]>>;
  method: TargetDiscoveryData["mdns"]["method"];
}

interface WirelessEndpointResolution {
  endpoint?: string;
  candidates: string[];
  discovered: boolean;
  problem?: Problem;
}

function isConnectableDiscoveryService(service: AdbMdnsService): boolean {
  return (
    service.serviceType === "legacy" ||
    (service.serviceType === "connect" && service.knownDevice !== false)
  );
}

function pairingRequiredProblem(
  connectServices: readonly AdbMdnsService[],
  allServices: readonly AdbMdnsService[],
  commandId: string,
): Problem {
  const pairingEndpoints = [
    ...new Set(
      allServices
        .filter(({ serviceType }) => serviceType === "pairing")
        .map(({ endpoint }) => endpoint.serial),
    ),
  ].sort();
  const pairingEndpoint = pairingEndpoints.length === 1 ? pairingEndpoints[0] : undefined;
  return {
    code: ProblemCode.WirelessPairingRequired,
    category: "target.authorization",
    severity: "error",
    summary: "The discovered wireless target must be paired first.",
    detail:
      pairingEndpoint === undefined
        ? "ADB reports that this computer does not know the target. Open Pair device with pairing code on Android, then run adb-ready pair."
        : `ADB reports that this computer does not know the target. Run adb-ready pair ${pairingEndpoint}, then connect it.`,
    retryable: true,
    evidence: [
      {
        source: "adb.mdns",
        field: "unpairedEndpoints",
        value: connectServices.map(({ endpoint }) => endpoint.serial),
      },
    ],
    actions:
      pairingEndpoint === undefined
        ? [
            {
              id: "open_pairing_screen",
              title: "Open Pair device with pairing code on the Android target",
              kind: "user",
              risk: "none",
              automatic: false,
            },
          ]
        : [
            {
              id: "pair_discovered_target",
              title: `Pair ${pairingEndpoint}`,
              kind: "command",
              risk: "device-reversible",
              automatic: false,
              idempotent: false,
              command: { executable: "adb-ready", args: ["pair", pairingEndpoint] },
            },
          ],
    correlation: { commandId },
  };
}

function serviceEndpointCandidates(service: AdbMdnsService): string[] {
  return [
    ...new Set([
      service.endpoint.serial,
      ...(service.alternateEndpoints ?? []).map(({ serial }) => serial),
    ]),
  ].slice(0, 3);
}

function normalizeEndpointCandidates(primary: string, candidates: readonly string[]): string[] {
  return [
    ...new Set(
      [primary, ...candidates]
        .map((candidate) => parseAdbNetworkEndpoint(candidate)?.serial)
        .filter((candidate): candidate is string => candidate !== undefined),
    ),
  ].slice(0, 3);
}

async function discoverMdns(
  client: AdbClient,
  hostFeatures: readonly string[] | undefined,
  signal: AbortSignal | undefined,
): Promise<MdnsDiscovery> {
  let features = hostFeatures;
  if (features === undefined) {
    const observation = await client.hostFeatures(signal);
    if (observation.process.aborted) {
      return {
        observation: {
          operationId: observation.operationId,
          process: observation.process,
          value: [],
        },
        method: "legacy",
      };
    }
    features = processSucceeded(observation.process) ? observation.value : [];
  }
  if (features.includes("track_mdns")) {
    const tracked = await client.mdnsTrackServices(signal);
    if (processSucceeded(tracked.process) || tracked.process.aborted) {
      return { observation: tracked, method: "track" };
    }
    return { observation: await client.mdnsServices(signal), method: "legacy-fallback" };
  }
  return { observation: await client.mdnsServices(signal), method: "legacy" };
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
  hostFeatures?: readonly string[],
): Promise<TargetInspection> {
  const identityCandidates = devices.filter(
    ({ serial, state }) => state === "device" && isStableAdbSerial(serial),
  );
  const [mdnsDiscovery, identities] = await Promise.all([
    discoverMdns(client, hostFeatures, signal),
    Promise.all(identityCandidates.map(({ serial }) => client.getHardwareSerial(serial, signal))),
  ]);
  const mdns = mdnsDiscovery.observation;
  const optionalProblems: Problem[] = [];
  const allObservations = [mdns, ...identities];
  const interrupted = allObservations.find(({ process }) => process.aborted);
  if (interrupted !== undefined) {
    return {
      targets: [],
      discovery: {
        mdns: { available: false, method: mdnsDiscovery.method, services: [] },
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
      mdns: {
        available: mdnsAvailable,
        method: mdnsDiscovery.method,
        services: inventory.services,
      },
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
      problems.push(
        ...problemsForServerStatus(status.value, version.value.platformToolsVersion, {
          commandId: context.commandId,
          operationId: status.operationId,
        }),
      );
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
  const inspection = await inspectTargets(
    client,
    devices.value,
    context.commandId,
    signal,
    processSucceeded(hostFeatures.process) ? hostFeatures.value : [],
  );
  if (inspection.interruption !== undefined) {
    problems.push(inspection.interruption);
    return finish<DoctorData>(context, null, problems);
  }
  problems.push(...targetInventoryProblems(inspection.targets, { commandId: context.commandId }));
  problems.push(...inspection.optionalProblems);
  if (devices.value.length === 0) {
    problems.push(
      noTargetsProblem({ commandId: context.commandId }, inspection.discovery.mdns.services),
    );
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

  const inspection = await inspectTargets(client, devices.value, context.commandId, signal);
  if (inspection.interruption !== undefined) {
    problems.push(inspection.interruption);
    return finish<DevicesData>(context, null, problems);
  }
  problems.push(...targetInventoryProblems(inspection.targets, { commandId: context.commandId }));
  problems.push(...inspection.optionalProblems);
  if (devices.value.length === 0) {
    problems.push(
      noTargetsProblem({ commandId: context.commandId }, inspection.discovery.mdns.services),
    );
  }

  let selected: SelectedTarget | undefined;
  if (
    config.targetSelector !== undefined ||
    config.targetTransportId !== undefined ||
    config.rememberedOnly === true
  ) {
    const selection = selectTarget(inspection.targets, {
      ...(config.targetSelector === undefined ? {} : { selector: config.targetSelector }),
      ...(config.targetTransportId === undefined ? {} : { transportId: config.targetTransportId }),
      ...(config.targetAliases === undefined ? {} : { aliases: config.targetAliases }),
      ...(config.rememberedSerial === undefined
        ? {}
        : { rememberedSerial: config.rememberedSerial }),
      ...(config.rememberedHardwareSerial === undefined
        ? {}
        : { rememberedHardwareSerial: config.rememberedHardwareSerial }),
      ...(config.rememberedOnly === undefined ? {} : { rememberedOnly: config.rememberedOnly }),
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

function portInputProblem(
  field: "device" | "host",
  value: string | number | undefined,
  commandId: string,
): Problem {
  return commandProblem(
    ProblemCode.InvalidPort,
    "input.port",
    `The ${field} port is invalid.`,
    "Use a TCP port from 1 to 65535, for example 8081 or tcp:8081.",
    commandId,
    [{ source: "input", field: `${field}Port`, value: value === undefined ? null : String(value) }],
  );
}

function requestedPortMapping(
  request: PortCommandRequest,
  commandId: string,
): { host: string; device: string } | Problem {
  const primary = request.direction === "reverse" ? request.devicePort : request.hostPort;
  if (primary === undefined) {
    return portInputProblem(
      request.direction === "reverse" ? "device" : "host",
      primary,
      commandId,
    );
  }
  const primaryEndpoint = tcpEndpoint(primary);
  if (primaryEndpoint === undefined) {
    return portInputProblem(
      request.direction === "reverse" ? "device" : "host",
      primary,
      commandId,
    );
  }
  const secondary =
    request.direction === "reverse"
      ? (request.hostPort ?? request.devicePort)
      : (request.devicePort ?? request.hostPort);
  if (secondary === undefined) {
    return portInputProblem(
      request.direction === "reverse" ? "host" : "device",
      secondary,
      commandId,
    );
  }
  const secondaryEndpoint = tcpEndpoint(secondary);
  if (secondaryEndpoint === undefined) {
    return portInputProblem(
      request.direction === "reverse" ? "host" : "device",
      secondary,
      commandId,
    );
  }
  return request.direction === "reverse"
    ? { host: secondaryEndpoint, device: primaryEndpoint }
    : { host: primaryEndpoint, device: secondaryEndpoint };
}

function listenEndpoint(
  direction: PortDirection,
  mapping: { host: string; device: string },
): string {
  return direction === "forward" ? mapping.host : mapping.device;
}

function targetForAdb(selection: SelectedTarget): { serial: string; transportId?: string } {
  return {
    serial: selection.transport.serial,
    ...(selection.transport.transportId === undefined
      ? {}
      : { transportId: selection.transport.transportId }),
  };
}

export async function runPorts(
  request: PortCommandRequest,
  config: CommandConfig = {},
  dependencies: CommandDependencies = {},
  signal?: AbortSignal,
): Promise<CommandExecution<PortsData>> {
  const context = createContext(`ports ${request.direction} ${request.action}`, dependencies);
  const problems: Problem[] = [];
  const requested =
    request.action === "list" ? undefined : requestedPortMapping(request, context.commandId);
  if (requested !== undefined && "code" in requested) {
    problems.push(requested);
    return finish<PortsData>(context, null, problems);
  }

  const executable = await resolveAdb(context, config, dependencies);
  if (executable === undefined) {
    problems.push(adbNotFoundProblem({ commandId: context.commandId }, config.adbPath));
    return finish<PortsData>(context, null, problems);
  }
  const client = createClient(executable, context, config, dependencies);
  const devices = await client.devices(signal);
  if (!processSucceeded(devices.process)) {
    problems.push(operationProblem("devices", devices, context.commandId));
    return finish<PortsData>(context, null, problems);
  }
  const inspection = await inspectTargets(client, devices.value, context.commandId, signal);
  if (inspection.interruption !== undefined) {
    problems.push(inspection.interruption);
    return finish<PortsData>(context, null, problems);
  }
  problems.push(...inspection.optionalProblems);
  problems.push(...targetInventoryProblems(inspection.targets, { commandId: context.commandId }));
  const selection = selectTarget(inspection.targets, {
    ...(config.targetSelector === undefined ? {} : { selector: config.targetSelector }),
    ...(config.targetTransportId === undefined ? {} : { transportId: config.targetTransportId }),
    ...(config.targetAliases === undefined ? {} : { aliases: config.targetAliases }),
    ...(config.rememberedSerial === undefined ? {} : { rememberedSerial: config.rememberedSerial }),
    ...(config.rememberedHardwareSerial === undefined
      ? {}
      : { rememberedHardwareSerial: config.rememberedHardwareSerial }),
    ...(config.rememberedOnly === undefined ? {} : { rememberedOnly: config.rememberedOnly }),
  });
  if (selection.kind !== "selected") {
    problems.push(targetSelectionProblem(selection, { commandId: context.commandId }));
    return finish<PortsData>(context, null, problems);
  }

  const target = targetForAdb(selection.selection);
  const listed = await client.listPortMappings(target, request.direction, signal);
  if (!processSucceeded(listed.process)) {
    problems.push(operationProblem(`${request.direction}-list`, listed, context.commandId));
    return finish<PortsData>(context, null, problems);
  }
  const mappings = listed.value.map((mapping) => normalizePortMapping(request.direction, mapping));
  if (request.action === "list") {
    return finish(
      context,
      {
        adbPath: redactedPath(executable),
        action: request.action,
        direction: request.direction,
        selected: selection.selection,
        mappings,
        status: "listed",
      },
      problems,
    );
  }

  if (requested === undefined) {
    throw new Error("Port request validation did not produce a mapping.");
  }
  const requestedListen = listenEndpoint(request.direction, requested);
  const existingAtEndpoint = mappings.find(
    (mapping) => listenEndpoint(request.direction, mapping) === requestedListen,
  );
  const base = {
    adbPath: redactedPath(executable),
    action: request.action,
    direction: request.direction,
    selected: selection.selection,
    requested,
  };

  if (request.action === "add" && existingAtEndpoint !== undefined) {
    if (
      existingAtEndpoint.host === requested.host &&
      existingAtEndpoint.device === requested.device
    ) {
      return finish(context, { ...base, mappings, status: "already-exists" as const }, problems);
    }
    problems.push(
      commandProblem(
        ProblemCode.PortMappingConflict,
        "adb.port.conflict",
        `The ${request.direction} listen port is already mapped.`,
        "Remove the existing mapping explicitly or choose another port; ADB Ready will not overwrite it.",
        context.commandId,
        [
          { source: "adb.port", field: "listen", value: requestedListen },
          { source: "adb.port", field: "host", value: existingAtEndpoint.host },
          { source: "adb.port", field: "device", value: existingAtEndpoint.device },
        ],
      ),
    );
    return finish<PortsData>(context, { ...base, mappings, status: "already-exists" }, problems);
  }

  const [firstEndpoint, secondEndpoint] = mappingArguments(
    request.direction,
    requested.host,
    requested.device,
  );
  if (config.dryRun) {
    const args =
      request.action === "add"
        ? [
            ...(target.transportId === undefined
              ? ["-s", target.serial]
              : ["-t", target.transportId]),
            request.direction,
            "--no-rebind",
            firstEndpoint,
            secondEndpoint,
          ]
        : [
            ...(target.transportId === undefined
              ? ["-s", target.serial]
              : ["-t", target.transportId]),
            request.direction,
            "--remove",
            requestedListen,
          ];
    return finish(
      context,
      {
        ...base,
        mappings,
        status: "planned",
        plan: {
          schemaVersion: SCHEMA_VERSION,
          dryRun: true,
          steps: [
            {
              id: `${request.direction}-${request.action}`,
              title: `${request.action === "add" ? "Add" : "Remove"} ${request.direction} mapping ${requested.device} ↔ ${requested.host}`,
              risk: "device-reversible",
              executable: redactedPath(executable),
              args,
            },
            {
              id: "verify-port-mapping",
              title: `Verify ${request.direction} mappings`,
              risk: "read-only",
              executable: redactedPath(executable),
              args: [
                ...(target.transportId === undefined
                  ? ["-s", target.serial]
                  : ["-t", target.transportId]),
                request.direction,
                "--list",
              ],
            },
          ],
        },
      },
      problems,
    );
  }

  if (request.action === "remove" && existingAtEndpoint === undefined) {
    return finish(context, { ...base, mappings, status: "not-found" }, problems);
  }

  const mutation =
    request.action === "add"
      ? await client.addPortMapping(
          target,
          request.direction,
          firstEndpoint,
          secondEndpoint,
          signal,
        )
      : await client.removePortMapping(target, request.direction, requestedListen, signal);
  if (!processSucceeded(mutation.process)) {
    problems.push(
      operationProblem(`${request.direction}-${request.action}`, mutation, context.commandId),
    );
    return finish<PortsData>(context, { ...base, mappings, status: "not-found" }, problems);
  }
  const verified = await client.listPortMappings(target, request.direction, signal);
  if (!processSucceeded(verified.process)) {
    problems.push(operationProblem(`${request.direction}-verify`, verified, context.commandId));
    return finish<PortsData>(context, { ...base, mappings, status: "not-found" }, problems);
  }
  const verifiedMappings = verified.value.map((mapping) =>
    normalizePortMapping(request.direction, mapping),
  );
  const isPresent = verifiedMappings.some(
    (mapping) => mapping.host === requested.host && mapping.device === requested.device,
  );
  if ((request.action === "add" && !isPresent) || (request.action === "remove" && isPresent)) {
    problems.push(
      commandProblem(
        ProblemCode.PortMappingVerificationFailed,
        "adb.port.verification",
        `ADB did not verify the ${request.direction} mapping change.`,
        "The requested mutation returned success, but the follow-up mapping list disagreed.",
        context.commandId,
      ),
    );
  }
  return finish(
    context,
    {
      ...base,
      mappings: verifiedMappings,
      status: request.action === "add" ? "added" : "removed",
    },
    problems,
  );
}

async function resolveWirelessEndpoint(
  client: AdbClient,
  requested: string | undefined,
  serviceType: "connect" | "pairing",
  commandId: string,
  signal: AbortSignal | undefined,
  requestedWasDiscovered = false,
  requestedCandidates: readonly string[] = [],
): Promise<WirelessEndpointResolution> {
  if (requested !== undefined) {
    const endpoint = parseAdbNetworkEndpoint(requested);
    return endpoint === undefined
      ? {
          candidates: [],
          discovered: requestedWasDiscovered,
          problem: commandProblem(
            ProblemCode.InvalidEndpoint,
            "input.endpoint",
            "The wireless endpoint is invalid.",
            "Use HOST:PORT, IPv4:PORT, or [IPv6]:PORT with a port from 1 to 65535.",
            commandId,
            [{ source: "input", field: "endpoint", value: requested }],
          ),
        }
      : {
          endpoint: endpoint.serial,
          candidates: requestedWasDiscovered
            ? normalizeEndpointCandidates(endpoint.serial, requestedCandidates)
            : [endpoint.serial],
          discovered: requestedWasDiscovered,
        };
  }

  const mdnsDiscovery = await discoverMdns(client, undefined, signal);
  const mdns = mdnsDiscovery.observation;
  if (!processSucceeded(mdns.process)) {
    return {
      candidates: [],
      discovered: true,
      problem: operationProblem("mdns-services", mdns, commandId),
    };
  }
  const serviceKinds =
    serviceType === "connect" ? new Set(["connect", "legacy"]) : new Set(["pairing"]);
  const discoveredServices = mdns.value.filter((service) => serviceKinds.has(service.serviceType));
  const services =
    serviceType === "connect"
      ? discoveredServices.filter(isConnectableDiscoveryService)
      : discoveredServices;
  if (
    serviceType === "connect" &&
    services.length === 0 &&
    discoveredServices.some(({ knownDevice }) => knownDevice === false)
  ) {
    return {
      candidates: [],
      discovered: true,
      problem: pairingRequiredProblem(discoveredServices, mdns.value, commandId),
    };
  }
  const serviceGroups = new Map<string, AdbMdnsService[]>();
  for (const service of services) {
    const key = `${service.rawServiceType}\0${service.instance}`;
    const group = serviceGroups.get(key) ?? [];
    group.push(service);
    serviceGroups.set(key, group);
  }
  if (serviceGroups.size === 0) {
    return {
      candidates: [],
      discovered: true,
      problem: commandProblem(
        ProblemCode.WirelessEndpointNotFound,
        "target.discovery",
        `No wireless ${serviceType} endpoint was discovered.`,
        serviceType === "pairing"
          ? "Open Wireless debugging and choose Pair device with pairing code, or provide its displayed HOST:PORT explicitly."
          : "Enable Wireless debugging, keep the target on a reachable network, or provide HOST:PORT explicitly.",
        commandId,
      ),
    };
  }
  if (serviceGroups.size > 1) {
    const endpoints = [
      ...new Set(services.flatMap((service) => serviceEndpointCandidates(service))),
    ].sort();
    return {
      candidates: [],
      discovered: true,
      problem: commandProblem(
        ProblemCode.MultipleWirelessEndpoints,
        "target.selection",
        `Multiple wireless ${serviceType} endpoints require an explicit selection.`,
        `Run the command again with one of these endpoints: ${endpoints.join(", ")}`,
        commandId,
        [{ source: "adb.mdns", field: "endpoints", value: endpoints }],
      ),
    };
  }
  const serviceGroup = [...serviceGroups.values()][0] ?? [];
  const candidates = [
    ...new Set(serviceGroup.flatMap((service) => serviceEndpointCandidates(service))),
  ].slice(0, 3);
  const endpoint = candidates[0];
  return endpoint === undefined
    ? { candidates: [], discovered: true }
    : { endpoint, candidates, discovered: true };
}

export async function runWirelessDiscovery(
  kind: "connect" | "pairing",
  config: CommandConfig = {},
  dependencies: CommandDependencies = {},
  signal?: AbortSignal,
): Promise<CommandExecution<WirelessDiscoveryData>> {
  const context = createContext("wireless-discovery", dependencies);
  const problems: Problem[] = [];
  const executable = await resolveAdb(context, config, dependencies);
  if (executable === undefined) {
    problems.push(adbNotFoundProblem({ commandId: context.commandId }, config.adbPath));
    return finish<WirelessDiscoveryData>(context, null, problems);
  }
  const client = createClient(executable, context, config, dependencies);
  const mdnsDiscovery = await discoverMdns(client, undefined, signal);
  const mdns = mdnsDiscovery.observation;
  if (!processSucceeded(mdns.process)) {
    problems.push(operationProblem("mdns-services", mdns, context.commandId));
    return finish<WirelessDiscoveryData>(context, null, problems);
  }
  const accepted = kind === "connect" ? new Set(["connect", "legacy"]) : new Set(["pairing"]);
  const discoveredServices = mdns.value.filter((service) => accepted.has(service.serviceType));
  if (
    kind === "connect" &&
    discoveredServices.length > 0 &&
    discoveredServices.every(
      ({ knownDevice, serviceType }) => serviceType === "connect" && knownDevice === false,
    )
  ) {
    problems.push(pairingRequiredProblem(discoveredServices, mdns.value, context.commandId));
    return finish(context, { adbPath: redactedPath(executable), kind, services: [] }, problems);
  }
  const seen = new Set<string>();
  const services = discoveredServices.filter((service) => {
    if (
      (kind === "connect" && !isConnectableDiscoveryService(service)) ||
      seen.has(service.endpoint.serial)
    ) {
      return false;
    }
    seen.add(service.endpoint.serial);
    return true;
  });
  if (services.length === 0) {
    problems.push(
      commandProblem(
        ProblemCode.WirelessEndpointNotFound,
        "target.discovery",
        `No wireless ${kind} endpoint was discovered.`,
        kind === "pairing"
          ? "Open Wireless debugging and choose Pair device with pairing code, or provide its displayed HOST:PORT explicitly."
          : "Enable Wireless debugging, keep the target on a reachable network, or provide HOST:PORT explicitly.",
        context.commandId,
      ),
    );
  }
  return finish(context, { adbPath: redactedPath(executable), kind, services }, problems);
}

export async function runConnect(
  requestedEndpoint: string | undefined,
  config: CommandConfig = {},
  dependencies: CommandDependencies = {},
  signal?: AbortSignal,
): Promise<CommandExecution<ConnectData>> {
  const context = createContext("connect", dependencies);
  const problems: Problem[] = [];
  if (requestedEndpoint !== undefined && parseAdbNetworkEndpoint(requestedEndpoint) === undefined) {
    problems.push(
      commandProblem(
        ProblemCode.InvalidEndpoint,
        "input.endpoint",
        "The wireless endpoint is invalid.",
        "Use HOST:PORT, IPv4:PORT, or [IPv6]:PORT with a port from 1 to 65535.",
        context.commandId,
        [{ source: "input", field: "endpoint", value: requestedEndpoint }],
      ),
    );
    return finish<ConnectData>(context, null, problems);
  }
  const executable = await resolveAdb(context, config, dependencies);
  if (executable === undefined) {
    problems.push(adbNotFoundProblem({ commandId: context.commandId }, config.adbPath));
    return finish<ConnectData>(context, null, problems);
  }
  const client = createClient(executable, context, config, dependencies);
  const resolution = await resolveWirelessEndpoint(
    client,
    requestedEndpoint,
    "connect",
    context.commandId,
    signal,
    config.endpointWasDiscovered,
    config.discoveredEndpointCandidates,
  );
  if (resolution.problem !== undefined || resolution.endpoint === undefined) {
    if (resolution.problem !== undefined) {
      problems.push(resolution.problem);
    }
    return finish<ConnectData>(context, null, problems);
  }
  const candidates =
    resolution.candidates.length > 0 ? resolution.candidates : [resolution.endpoint];
  if (config.dryRun) {
    const steps = candidates.flatMap((candidate, index) => {
      const connectId = index === 0 ? "connect" : `connect-alternate-${String(index)}`;
      const verifyId = index === 0 ? "verify" : `verify-alternate-${String(index)}`;
      const previousConnectId = index <= 1 ? "connect" : `connect-alternate-${String(index - 1)}`;
      return [
        {
          id: connectId,
          title:
            index === 0
              ? `Connect wireless target ${candidate}`
              : `Try alternate address ${candidate}`,
          risk: "local-additive" as const,
          ...(index === 0
            ? {}
            : { when: { stepId: previousConnectId, outcome: "failure" as const } }),
          executable: redactedPath(executable),
          args: ["connect", candidate],
        },
        {
          id: verifyId,
          title: `Verify ${candidate} reports device state`,
          risk: "read-only" as const,
          when: { stepId: connectId, outcome: "success" as const },
          executable: redactedPath(executable),
          args: ["-s", candidate, "get-state"],
        },
      ];
    });
    return finish(
      context,
      {
        endpoint: resolution.endpoint,
        discovered: resolution.discovered,
        plan: {
          schemaVersion: SCHEMA_VERSION,
          dryRun: true,
          steps,
        },
      },
      problems,
    );
  }

  const attemptedEndpoints: string[] = [];
  let connected:
    | {
        endpoint: string;
        status: ConnectedData["status"];
      }
    | undefined;
  let lastConnectionProblem: Problem | undefined;
  for (const candidate of candidates) {
    attemptedEndpoints.push(candidate);
    const observation = await client.connect(candidate, signal);
    if (!processSucceeded(observation.process)) {
      lastConnectionProblem = operationProblem("connect", observation, context.commandId);
      if (
        lastConnectionProblem.code === ProblemCode.OperationInterrupted ||
        lastConnectionProblem.code === ProblemCode.AdbServerUnavailable ||
        lastConnectionProblem.code === ProblemCode.AdbFeatureUnavailable
      ) {
        break;
      }
      continue;
    }
    if (
      observation.value.status === "connected" ||
      observation.value.status === "already-connected"
    ) {
      const confirmedEndpoint =
        observation.value.endpoint === undefined
          ? undefined
          : parseAdbNetworkEndpoint(observation.value.endpoint)?.serial;
      connected = {
        endpoint: confirmedEndpoint ?? candidate,
        status: observation.value.status,
      };
      break;
    }
    lastConnectionProblem = commandProblem(
      ProblemCode.WirelessConnectionFailed,
      "adb.connect",
      "ADB did not confirm the wireless connection.",
      "The operation returned without a verified connected state.",
      context.commandId,
      [{ source: "adb.connect", field: "status", value: observation.value.status }],
    );
  }
  if (connected === undefined) {
    const problem =
      lastConnectionProblem ??
      commandProblem(
        ProblemCode.WirelessConnectionFailed,
        "adb.connect",
        "ADB could not connect to the discovered wireless target.",
        "None of the bounded address candidates produced a connected state.",
        context.commandId,
      );
    problem.evidence.push({
      source: "adb.discovery",
      field: "attemptedEndpoints",
      value: attemptedEndpoints,
    });
    problems.push(problem);
    return finish<ConnectData>(context, null, problems);
  }
  if (attemptedEndpoints.length > 1) {
    context.bus.emit({
      type: "recovery.completed",
      source: "command.connect",
      severity: "info",
      message: `Connected through alternate address ${connected.endpoint}`,
      correlation: { commandId: context.commandId },
      data: { attemptedEndpoints, selectedEndpoint: connected.endpoint },
    });
  }

  const state = await client.getState(connected.endpoint, signal);
  if (!processSucceeded(state.process)) {
    problems.push(operationProblem("get-state", state, context.commandId));
    return finish<ConnectData>(context, null, problems);
  }
  if (state.value !== "device") {
    problems.push(
      commandProblem(
        ProblemCode.WirelessConnectionFailed,
        "target.verification",
        "The wireless target could not be verified as ready.",
        `ADB reported ${state.value ?? "no state"} after connecting.`,
        context.commandId,
        [{ source: "adb.get-state", field: "state", value: state.value ?? null }],
      ),
    );
    return finish<ConnectData>(context, null, problems);
  }

  const identity = await client.getHardwareSerial(connected.endpoint, signal);
  if (identity.process.aborted) {
    problems.push(operationProblem("hardware-serial", identity, context.commandId));
    return finish<ConnectData>(context, null, problems);
  }
  const hardwareSerial = processSucceeded(identity.process)
    ? normalizedHardwareSerial(identity.value)
    : undefined;
  return finish(
    context,
    {
      adbPath: redactedPath(executable),
      endpoint: connected.endpoint,
      status: connected.status,
      serial: connected.endpoint,
      state: "device",
      ...(hardwareSerial === undefined ? {} : { hardwareSerial }),
      discovered: resolution.discovered,
      ...(attemptedEndpoints.length > 1 ? { attemptedEndpoints } : {}),
    },
    problems,
  );
}

export async function runPair(
  requestedEndpoint: string | undefined,
  pairingCode: string,
  config: CommandConfig = {},
  dependencies: CommandDependencies = {},
  signal?: AbortSignal,
): Promise<CommandExecution<PairData>> {
  const context = createContext("pair", dependencies);
  const problems: Problem[] = [];
  if (!config.dryRun && !/^\d{6}$/u.test(pairingCode)) {
    problems.push(
      commandProblem(
        ProblemCode.InvalidPairingCode,
        "input.pairing-code",
        "The pairing code must contain exactly six digits.",
        "Open Pair device with pairing code on Android and enter the current six-digit code.",
        context.commandId,
      ),
    );
    return finish<PairData>(context, null, problems);
  }
  if (requestedEndpoint !== undefined && parseAdbNetworkEndpoint(requestedEndpoint) === undefined) {
    problems.push(
      commandProblem(
        ProblemCode.InvalidEndpoint,
        "input.endpoint",
        "The wireless pairing endpoint is invalid.",
        "Use the HOST:PORT shown on Android's pairing-code screen.",
        context.commandId,
        [{ source: "input", field: "endpoint", value: requestedEndpoint }],
      ),
    );
    return finish<PairData>(context, null, problems);
  }
  const executable = await resolveAdb(context, config, dependencies);
  if (executable === undefined) {
    problems.push(adbNotFoundProblem({ commandId: context.commandId }, config.adbPath));
    return finish<PairData>(context, null, problems);
  }
  const client = createClient(executable, context, config, dependencies);
  const resolution = await resolveWirelessEndpoint(
    client,
    requestedEndpoint,
    "pairing",
    context.commandId,
    signal,
    config.endpointWasDiscovered,
    config.discoveredEndpointCandidates,
  );
  if (resolution.problem !== undefined || resolution.endpoint === undefined) {
    if (resolution.problem !== undefined) {
      problems.push(resolution.problem);
    }
    return finish<PairData>(context, null, problems);
  }
  if (config.dryRun) {
    return finish(
      context,
      {
        endpoint: resolution.endpoint,
        discovered: resolution.discovered,
        plan: {
          schemaVersion: SCHEMA_VERSION,
          dryRun: true,
          steps: [
            {
              id: "pair",
              title: `Pair wireless target ${resolution.endpoint}`,
              risk: "device-reversible",
              executable: redactedPath(executable),
              args: ["pair", resolution.endpoint],
            },
          ],
        },
      },
      problems,
    );
  }

  const pairing = await client.pair(resolution.endpoint, pairingCode, signal);
  if (!processSucceeded(pairing.process)) {
    problems.push(operationProblem("pair", pairing, context.commandId));
    return finish<PairData>(context, null, problems);
  }
  if (!pairing.value.paired) {
    problems.push(
      commandProblem(
        ProblemCode.WirelessPairingFailed,
        "adb.pair",
        "ADB did not confirm wireless pairing.",
        "Check that the pairing screen is still open and the six-digit code has not expired.",
        context.commandId,
      ),
    );
    return finish<PairData>(context, null, problems);
  }

  return finish(
    context,
    {
      adbPath: redactedPath(executable),
      endpoint: resolution.endpoint,
      paired: true,
      discovered: resolution.discovered,
    },
    problems,
  );
}

export interface DevPort {
  device: string | number;
  host?: string | number;
}

export interface DevCommand {
  executable: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface DevOptions {
  cwd: string;
  preset?: DevPreset;
  packageManager?: PackageManagerName;
  command?: DevCommand;
  reversePorts?: readonly DevPort[];
  cleanupPorts?: boolean;
  logs?: boolean;
  journal?: {
    maxEntries?: number;
    maxBytes?: number;
    sources?: readonly string[];
    minimumSeverity?: "debug" | "error" | "info" | "warning";
  };
  childStdin?: "ignore" | "inherit";
  onChildLine?: (stream: "stderr" | "stdout", line: string) => void;
}

export interface DevData {
  sessionId: string;
  status: "completed" | "planned";
  adbPath: string;
  selected: SelectedTarget;
  project: {
    root: string;
    name?: string;
  };
  preset: DevPreset;
  packageManager?: {
    name: PackageManagerName;
    source: NonNullable<ProjectDetection["packageManager"]["source"]>;
  };
  ports: {
    requested: Array<{ device: string; host: string }>;
    created: Array<{ device: string; host: string }>;
    reused: Array<{ device: string; host: string }>;
    cleaned: boolean;
  };
  command: {
    executable: string;
    args: string[];
    cwd: string;
    envKeys: string[];
  };
  child?: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    durationMs: number;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  };
  plan?: OperationPlan;
  journal: EventJournalSnapshot;
}

async function regularFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function directPackageCommand(
  manager: PackageManagerName,
  executable: string,
  binary: string,
  args: readonly string[],
): DevCommand {
  if (manager === "npm") {
    return { executable, args: ["exec", "--", binary, ...args] };
  }
  if (manager === "pnpm") {
    return { executable, args: ["exec", binary, ...args] };
  }
  if (manager === "bun") {
    return { executable, args: ["x", binary, ...args] };
  }
  return { executable, args: [binary, ...args] };
}

async function resolveDevCommand(
  preset: DevPreset,
  project: ProjectDetection,
  options: DevOptions,
  dependencies: CommandDependencies,
): Promise<DevCommand | undefined> {
  if (options.command !== undefined) return options.command;
  if (preset === "custom") return undefined;
  if (preset === "gradle") {
    const wrapperJar = path.join(project.root, "gradle", "wrapper", "gradle-wrapper.jar");
    const locate = dependencies.locateExecutable ?? locateExecutable;
    const java = await locate("java");
    if (java !== undefined && (await regularFile(wrapperJar))) {
      return {
        executable: java,
        args: ["-classpath", wrapperJar, "org.gradle.wrapper.GradleWrapperMain", "installDebug"],
      };
    }
    const wrapper = path.join(
      project.root,
      process.platform === "win32" ? "gradlew.bat" : "gradlew",
    );
    return (await regularFile(wrapper))
      ? { executable: wrapper, args: ["installDebug"] }
      : undefined;
  }
  const manager = project.packageManager;
  if (manager.name === undefined || manager.executable === undefined) return undefined;
  const script = preset === "expo" ? "start" : "android";
  const frameworkArgs = preset === "expo" ? ["--android"] : [];
  if (project.packageJson?.scripts[script] !== undefined) {
    return {
      ...packageScriptCommand(manager.name, manager.executable, script, frameworkArgs),
    };
  }
  return directPackageCommand(
    manager.name,
    manager.executable,
    preset === "expo" ? "expo" : "react-native",
    preset === "expo" ? ["start", "--android"] : ["run-android"],
  );
}

function normalizeDevPorts(
  ports: readonly DevPort[],
  commandId: string,
): { mappings: Array<{ device: string; host: string }>; problems: Problem[] } {
  const mappings: Array<{ device: string; host: string }> = [];
  const problems: Problem[] = [];
  const seen = new Set<string>();
  for (const port of ports) {
    const device = tcpEndpoint(port.device);
    const host = tcpEndpoint(port.host ?? port.device);
    if (device === undefined) {
      problems.push(portInputProblem("device", port.device, commandId));
      continue;
    }
    if (host === undefined) {
      problems.push(portInputProblem("host", port.host, commandId));
      continue;
    }
    const key = `${device}\0${host}`;
    if (!seen.has(key)) {
      seen.add(key);
      mappings.push({ device, host });
    }
  }
  return { mappings, problems };
}

function streamSeverity(
  priority: ReturnType<typeof parseLogcatThreadtimeLine>,
): "debug" | "error" | "info" | "warning" {
  if (priority?.priority === "E" || priority?.priority === "F" || priority?.priority === "A") {
    return "error";
  }
  if (priority?.priority === "W") return "warning";
  if (priority?.priority === "D" || priority?.priority === "V") return "debug";
  return "info";
}

export async function runDev(
  options: DevOptions,
  config: CommandConfig = {},
  dependencies: CommandDependencies = {},
  signal?: AbortSignal,
): Promise<CommandExecution<DevData>> {
  const bus = dependencies.bus ?? new EventBus(dependencies.clock);
  const idFactory = dependencies.idFactory ?? randomUUID;
  const sessionId = idFactory();
  const journal = new EventJournal(bus, options.journal);
  const context = createContext("dev", { ...dependencies, bus, idFactory });
  const problems: Problem[] = [];
  const complete = (data: Omit<DevData, "journal"> | null): CommandExecution<DevData> => {
    const execution = finish<DevData>(context, data as DevData | null, problems);
    const snapshot = journal.close();
    if (execution.result.data !== null) execution.result.data.journal = snapshot;
    return execution;
  };
  const correlation = { commandId: context.commandId, sessionId };
  bus.emit({
    type: "session.started",
    source: "session",
    severity: "info",
    message: "Development session started",
    correlation,
  });

  const executable = await resolveAdb(context, config, dependencies);
  if (executable === undefined) {
    problems.push(adbNotFoundProblem(correlation, config.adbPath));
    return complete(null);
  }
  const discoveryClient = new AdbClient({
    executable,
    bus,
    correlation,
    ...(config.adbHost === undefined ? {} : { host: config.adbHost }),
    ...(config.adbPort === undefined ? {} : { port: config.adbPort }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(dependencies.runner === undefined ? {} : { runner: dependencies.runner }),
    idFactory,
  });
  const devices = await discoveryClient.devices(signal);
  if (!processSucceeded(devices.process)) {
    problems.push(operationProblem("devices", devices, context.commandId));
    return complete(null);
  }
  const inspection = await inspectTargets(
    discoveryClient,
    devices.value,
    context.commandId,
    signal,
  );
  if (inspection.interruption !== undefined) {
    problems.push(inspection.interruption);
    return complete(null);
  }
  problems.push(...inspection.optionalProblems);
  const selection = selectTarget(inspection.targets, {
    ...(config.targetSelector === undefined ? {} : { selector: config.targetSelector }),
    ...(config.targetTransportId === undefined ? {} : { transportId: config.targetTransportId }),
    ...(config.targetAliases === undefined ? {} : { aliases: config.targetAliases }),
    ...(config.rememberedSerial === undefined ? {} : { rememberedSerial: config.rememberedSerial }),
    ...(config.rememberedHardwareSerial === undefined
      ? {}
      : { rememberedHardwareSerial: config.rememberedHardwareSerial }),
    ...(config.rememberedOnly === undefined ? {} : { rememberedOnly: config.rememberedOnly }),
  });
  if (selection.kind !== "selected") {
    problems.push(targetSelectionProblem(selection, correlation));
    return complete(null);
  }
  const selected = selection.selection;
  const target = targetForAdb(selected);
  bus.emit({
    type: "target.selected",
    source: "target",
    severity: "info",
    message: `Selected ${selected.transport.serial}`,
    correlation: { ...correlation, targetId: selected.target.id },
    data: { serial: selected.transport.serial, reason: selected.reason },
  });

  const project = await (dependencies.detectProject ?? detectProject)({
    cwd: options.cwd,
    ...(options.packageManager === undefined
      ? {}
      : { explicitPackageManager: options.packageManager }),
  });
  const preset = options.preset ?? (options.command === undefined ? project.preset : "custom");
  if (preset === undefined) {
    problems.push(
      commandProblem(
        ProblemCode.DevPresetNotFound,
        "input.dev.preset",
        "ADB Ready could not determine a development preset.",
        "Choose --preset expo, react-native, gradle, or pass a custom command after --.",
        context.commandId,
      ),
    );
    return complete(null);
  }
  if (
    project.packageManager.conflicts.length > 0 &&
    (preset === "expo" || preset === "react-native")
  ) {
    problems.push(
      commandProblem(
        ProblemCode.PackageManagerConflict,
        "input.dev.package-manager",
        "Multiple package-manager lockfiles conflict.",
        "Declare packageManager in package.json, use --package-manager, or remove stale lockfiles.",
        context.commandId,
        [{ source: "project", field: "lockfiles", value: project.packageManager.conflicts }],
      ),
    );
    return complete(null);
  }
  if (
    (preset === "expo" || preset === "react-native") &&
    (project.packageManager.name === undefined || project.packageManager.executable === undefined)
  ) {
    problems.push(
      commandProblem(
        ProblemCode.PackageManagerNotFound,
        "environment.package-manager",
        "The project's package manager is unavailable.",
        "Install the declared package manager or select an available one with --package-manager.",
        context.commandId,
      ),
    );
    return complete(null);
  }
  const childCommand = await resolveDevCommand(preset, project, options, dependencies);
  if (childCommand === undefined || childCommand.executable.trim() === "") {
    problems.push(
      commandProblem(
        ProblemCode.DevCommandNotFound,
        "input.dev.command",
        "No runnable development command was found.",
        "Configure an executable and argument array or pass a custom command after --.",
        context.commandId,
      ),
    );
    return complete(null);
  }
  const defaultPorts = preset === "expo" || preset === "react-native" ? [{ device: 8081 }] : [];
  const normalizedPorts = normalizeDevPorts(
    options.reversePorts ?? defaultPorts,
    context.commandId,
  );
  problems.push(...normalizedPorts.problems);
  if (normalizedPorts.problems.length > 0) return complete(null);

  const targetCorrelation = { ...correlation, targetId: selected.target.id };
  const client = new AdbClient({
    executable,
    bus,
    correlation: targetCorrelation,
    ...(config.adbHost === undefined ? {} : { host: config.adbHost }),
    ...(config.adbPort === undefined ? {} : { port: config.adbPort }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(dependencies.runner === undefined ? {} : { runner: dependencies.runner }),
    idFactory,
  });
  const listed = await client.listPortMappings(target, "reverse", signal);
  if (!processSucceeded(listed.process)) {
    problems.push(operationProblem("reverse-list", listed, context.commandId));
    return complete(null);
  }
  const existing = listed.value.map((mapping) => normalizePortMapping("reverse", mapping));
  const created: Array<{ device: string; host: string }> = [];
  const reused: Array<{ device: string; host: string }> = [];
  for (const requested of normalizedPorts.mappings) {
    const atDevicePort = existing.find((mapping) => mapping.device === requested.device);
    if (atDevicePort === undefined) continue;
    if (atDevicePort.host === requested.host) {
      reused.push(requested);
    } else {
      problems.push(
        commandProblem(
          ProblemCode.PortMappingConflict,
          "adb.port.conflict",
          `Device port ${requested.device} is already mapped to ${atDevicePort.host}.`,
          "ADB Ready will not replace a mapping owned by another tool or session.",
          context.commandId,
        ),
      );
    }
  }
  if (problems.some(({ severity }) => severity === "error")) return complete(null);
  const pending = normalizedPorts.mappings.filter(
    (mapping) =>
      !reused.some((item) => item.device === mapping.device && item.host === mapping.host),
  );
  const commandCwd = path.resolve(project.root, childCommand.cwd ?? ".");
  const commandData = {
    executable: redactedPath(childCommand.executable),
    args: childCommand.args.map((argument) => redactText(argument).value),
    cwd: redactedPath(commandCwd),
    envKeys: [...new Set(["ANDROID_SERIAL", ...Object.keys(childCommand.env ?? {})])].sort(),
  };
  const baseData = {
    sessionId,
    adbPath: redactedPath(executable),
    selected,
    project: {
      root: redactedPath(project.root),
      ...(project.packageJson?.name === undefined ? {} : { name: project.packageJson.name }),
    },
    preset,
    ...(project.packageManager.name === undefined || project.packageManager.source === undefined
      ? {}
      : {
          packageManager: {
            name: project.packageManager.name,
            source: project.packageManager.source,
          },
        }),
    command: commandData,
  };
  if (config.dryRun) {
    const selectorArgs =
      target.transportId === undefined ? ["-s", target.serial] : ["-t", target.transportId];
    const steps = [
      ...pending.map((mapping, index) => ({
        id: `reverse-${String(index + 1)}`,
        title: `Map device ${mapping.device} to host ${mapping.host}`,
        risk: "device-reversible" as const,
        executable: redactedPath(executable),
        args: [...selectorArgs, "reverse", "--no-rebind", mapping.device, mapping.host],
      })),
      {
        id: "start-child",
        title: `Start ${preset} development command`,
        risk: "open-world" as const,
        executable: commandData.executable,
        args: commandData.args,
      },
    ];
    bus.emit({
      type: "session.planned",
      source: "session",
      severity: "info",
      message: "Development session plan is ready",
      correlation: targetCorrelation,
    });
    return complete({
      ...baseData,
      status: "planned",
      ports: {
        requested: normalizedPorts.mappings,
        created,
        reused,
        cleaned: false,
      },
      plan: { schemaVersion: SCHEMA_VERSION, dryRun: true, steps },
    });
  }

  for (const mapping of pending) {
    const added = await client.addPortMapping(
      target,
      "reverse",
      mapping.device,
      mapping.host,
      signal,
    );
    if (!processSucceeded(added.process)) {
      problems.push(operationProblem("reverse-add", added, context.commandId));
      break;
    }
    created.push(mapping);
  }
  if (!problems.some(({ severity }) => severity === "error")) {
    const verified = await client.listPortMappings(target, "reverse", signal);
    if (!processSucceeded(verified.process)) {
      problems.push(operationProblem("reverse-verify", verified, context.commandId));
    } else {
      const after = verified.value.map((mapping) => normalizePortMapping("reverse", mapping));
      for (const mapping of normalizedPorts.mappings) {
        if (!after.some((item) => item.device === mapping.device && item.host === mapping.host)) {
          problems.push(
            commandProblem(
              ProblemCode.PortMappingVerificationFailed,
              "adb.port.verification",
              `Reverse mapping ${mapping.device} to ${mapping.host} was not verified.`,
              "ADB reported success but the mapping is absent from the follow-up list.",
              context.commandId,
            ),
          );
        }
      }
    }
  }

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (options.cleanupPorts === false || created.length === 0) return;
    bus.emit({
      type: "session.stopping",
      source: "session",
      severity: "info",
      message: "Cleaning session-owned port mappings",
      correlation: targetCorrelation,
    });
    for (const mapping of created) {
      await client.removePortMapping(target, "reverse", mapping.device);
    }
    const remaining = await client.listPortMappings(target, "reverse");
    cleaned =
      processSucceeded(remaining.process) &&
      !remaining.value
        .map((mapping) => normalizePortMapping("reverse", mapping))
        .some((mapping) => created.some((item) => item.device === mapping.device));
  };
  if (problems.some(({ severity }) => severity === "error")) {
    await cleanup();
    return complete(null);
  }

  bus.emit({
    type: "port.verified",
    source: "port",
    severity: "info",
    message: `${String(normalizedPorts.mappings.length)} reverse mapping(s) ready`,
    correlation: targetCorrelation,
    data: { created: created.length, reused: reused.length },
  });
  const runner = dependencies.runner ?? runProcess;
  const logController = new AbortController();
  if (signal?.aborted) logController.abort();
  const abortLogs = () => logController.abort();
  signal?.addEventListener("abort", abortLogs, { once: true });
  let logPromise: Promise<ProcessResult> | undefined;
  if (options.logs !== false) {
    const logLines = new TextLineBuffer((raw) => {
      const parsed = parseLogcatThreadtimeLine(raw);
      const safeRaw = redactText(raw).value;
      bus.emit({
        type: "log.record",
        source: "logcat",
        severity: streamSeverity(parsed),
        message: parsed === undefined ? safeRaw : redactText(parsed.message).value,
        correlation: targetCorrelation,
        data: {
          raw: safeRaw,
          parsed: parsed !== undefined,
          ...(parsed === undefined
            ? {}
            : { tag: parsed.tag, pid: parsed.pid, tid: parsed.tid, priority: parsed.priority }),
        },
      });
    });
    const selectorArgs =
      target.transportId === undefined ? ["-s", target.serial] : ["-t", target.transportId];
    logPromise = runner({
      executable,
      args: [
        ...(config.adbHost === undefined ? [] : ["-H", config.adbHost]),
        ...(config.adbPort === undefined ? [] : ["-P", String(config.adbPort)]),
        ...selectorArgs,
        "logcat",
        "-v",
        "threadtime",
        "ReactNativeJS:V",
        "ReactNative:V",
        "AndroidRuntime:E",
        "*:S",
      ],
      signal: logController.signal,
      maxBufferBytes: 256 * 1024,
      onStdoutChunk: (chunk) => logLines.push(chunk),
      onStderrChunk: (chunk) => logLines.push(chunk),
    }).finally(() => logLines.flush());
  }
  const childStdout = new TextLineBuffer((line) => {
    const safe = redactText(line).value;
    bus.emit({
      type: "child.stdout",
      source: "child.stdout",
      severity: "info",
      message: safe,
      correlation: targetCorrelation,
      data: { raw: safe },
    });
    options.onChildLine?.("stdout", safe);
  });
  const childStderr = new TextLineBuffer((line) => {
    const safe = redactText(line).value;
    bus.emit({
      type: "child.stderr",
      source: "child.stderr",
      severity: "info",
      message: safe,
      correlation: targetCorrelation,
      data: { raw: safe },
    });
    options.onChildLine?.("stderr", safe);
  });
  bus.emit({
    type: "child.started",
    source: "child",
    severity: "info",
    message: `Starting ${preset} development command`,
    correlation: targetCorrelation,
    data: commandData,
  });
  const child = await runner({
    executable: childCommand.executable,
    args: childCommand.args,
    cwd: commandCwd,
    env: { ...childCommand.env, ANDROID_SERIAL: selected.transport.serial },
    ...(signal === undefined ? {} : { signal }),
    stdin: options.childStdin ?? "ignore",
    maxBufferBytes: 4 * 1024 * 1024,
    onStdoutChunk: (chunk) => childStdout.push(chunk),
    onStderrChunk: (chunk) => childStderr.push(chunk),
  });
  childStdout.flush();
  childStderr.flush();
  logController.abort();
  if (logPromise !== undefined) await logPromise;
  signal?.removeEventListener("abort", abortLogs);
  bus.emit({
    type: "child.exited",
    source: "child",
    severity: child.exitCode === 0 ? "info" : "error",
    message: `Development command exited ${child.exitCode === null ? `by ${String(child.signal)}` : `with ${String(child.exitCode)}`}`,
    correlation: targetCorrelation,
    data: { exitCode: child.exitCode, signal: child.signal, durationMs: child.durationMs },
  });
  await cleanup();
  if (child.aborted) {
    problems.push(
      commandProblem(
        ProblemCode.OperationInterrupted,
        "child.interrupted",
        "The development session was interrupted.",
        "The owned child process and session-owned port mappings were stopped safely.",
        context.commandId,
      ),
    );
  } else if (!processSucceeded(child)) {
    problems.push(
      commandProblem(
        ProblemCode.ChildProcessFailed,
        "child.exit",
        "The development command failed.",
        `The child exited with ${child.exitCode === null ? String(child.signal) : String(child.exitCode)}.`,
        context.commandId,
        [
          { source: "child", field: "exitCode", value: child.exitCode },
          { source: "child", field: "signal", value: child.signal },
        ],
      ),
    );
  }
  bus.emit({
    type: "session.ended",
    source: "session",
    severity: problems.some(({ severity }) => severity === "error") ? "error" : "info",
    message: "Development session ended",
    correlation: targetCorrelation,
  });
  return complete({
    ...baseData,
    status: "completed",
    ports: {
      requested: normalizedPorts.mappings,
      created,
      reused,
      cleaned,
    },
    child: {
      exitCode: child.exitCode,
      signal: child.signal,
      durationMs: child.durationMs,
      stdoutTruncated: child.stdoutTruncated,
      stderrTruncated: child.stderrTruncated,
    },
  });
}
