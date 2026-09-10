import { randomUUID } from "node:crypto";
import { AdbClient } from "../adb/client.js";
import {
  type AdbDevice,
  type AdbMdnsService,
  type AdbVersion,
  parseAdbNetworkEndpoint,
} from "../adb/parsers.js";
import { EventBus } from "../core/event-bus.js";
import { redactText } from "../core/redaction.js";
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
  rememberedSerial?: string;
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
  if (devices.value.length === 0) {
    problems.push(noTargetsProblem({ commandId: context.commandId }));
  }
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
  problems.push(...targetInventoryProblems(inspection.targets, { commandId: context.commandId }));

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
  const services = mdns.value.filter((service) => serviceKinds.has(service.serviceType));
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
  const seen = new Set<string>();
  const services = mdns.value.filter((service) => {
    if (!accepted.has(service.serviceType) || seen.has(service.endpoint.serial)) {
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
    const connectSteps = candidates.map((candidate, index) => ({
      id: index === 0 ? "connect" : `connect-alternate-${String(index)}`,
      title:
        index === 0
          ? `Connect wireless target ${candidate}`
          : `If needed, try alternate address ${candidate}`,
      risk: "local-additive" as const,
      executable: redactedPath(executable),
      args: ["connect", candidate],
    }));
    return finish(
      context,
      {
        endpoint: resolution.endpoint,
        discovered: resolution.discovered,
        plan: {
          schemaVersion: SCHEMA_VERSION,
          dryRun: true,
          steps: [
            ...connectSteps,
            {
              id: "verify",
              title: "Verify the successful address reports device state",
              risk: "read-only",
            },
          ],
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
      connected = { endpoint: candidate, status: observation.value.status };
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
