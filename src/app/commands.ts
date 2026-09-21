import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { AdbClient, type AdbTargetSelector } from "../adb/client.js";
import {
  type AdbDevice,
  type AdbMdnsService,
  type AdbVersion,
  parseAdbNetworkEndpoint,
  parseLogcatThreadtimeLine,
} from "../adb/parsers.js";
import {
  createAdbReadinessProbe,
  type ReadinessAssertion,
  type ReadinessResult,
  readinessProblem,
  waitForReadiness,
} from "../automation/readiness.js";
import { EventBus } from "../core/event-bus.js";
import { EventJournal, type EventJournalSnapshot } from "../core/event-journal.js";
import { redactText } from "../core/redaction.js";
import { TextLineBuffer } from "../core/text-lines.js";
import {
  type DevLiveControlsBinding,
  type DevLiveControlsReady,
  type ExpoControlAction,
  sendExpoControl,
} from "../dev/expo-controls.js";
import { type ExpoLaunchResolution, resolveExpoLaunch } from "../dev/expo-launch.js";
import { type DevHook, type DevHookEvent, type HookRun, runHooks } from "../dev/hooks.js";
import { type DiscoveredLocalService, discoverExpoLocalServices } from "../dev/local-services.js";
import { ensureLoopbackBridge, type LoopbackBridge } from "../dev/loopback-bridge.js";
import { type MetroServiceProbeResult, probeMetroService } from "../dev/metro-service.js";
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
import type { UiHierarchyLockOptions } from "../evidence/ui-hierarchy-capture.js";
import { classifyLogRecord, type LogAttribution, type LogFinding } from "../logs/classifier.js";
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
import type { RecoveryPolicyInput } from "../session/recovery-policy.js";
import { type SessionState, SessionStateMachine } from "../session/state-machine.js";
import { planTargetAcquisition } from "../session/target-acquisition.js";
import { type SessionHealth, type SessionWatchSummary, watchSession } from "../session/watcher.js";
import { SessionRecorder, type SessionStoreOptions } from "../state/session-store.js";
import {
  type AndroidTarget,
  buildTargetInventory,
  correlateMdnsTransportIdentities,
  isStableAdbSerial,
} from "../target/model.js";
import { type SelectedTarget, selectTarget } from "../target/selection.js";
import { parseResolvedActivity } from "./android-app.js";

export interface CommandConfig {
  adbPath?: string;
  adbHost?: string;
  adbPort?: number;
  timeoutMs?: number;
  uiTimeoutMs?: number;
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
  discoverExpoLocalServices?: typeof discoverExpoLocalServices;
  env?: NodeJS.ProcessEnv;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<boolean>;
  probeMetroService?: (options: {
    host: string;
    port: number;
    expectedProjectRoot?: string;
    signal?: AbortSignal;
  }) => Promise<MetroServiceProbeResult>;
  ensureLoopbackBridge?: typeof ensureLoopbackBridge;
  resolveExpoLaunch?: typeof resolveExpoLaunch;
  sendExpoControl?: typeof sendExpoControl;
  uiHierarchyLock?: UiHierarchyLockOptions;
}

export interface CommandExecution<T> {
  result: ResultEnvelope<T>;
  exitCode: number;
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

function preservedChildExitCode(result: ProcessResult): number | undefined {
  if (result.exitCode !== null && result.exitCode !== 0) return result.exitCode;
  if (result.signal === null) return undefined;
  const signalNumber = osConstants.signals[result.signal];
  return signalNumber === undefined ? undefined : 128 + signalNumber;
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
  const interrupted = exitCode === ExitCode.Interrupted;
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
    type: ok ? "command.completed" : interrupted ? "command.interrupted" : "command.failed",
    source: `command.${context.command}`,
    severity: ok ? "info" : interrupted ? "warning" : "error",
    message: ok
      ? `${context.command} completed`
      : interrupted
        ? `${context.command} interrupted`
        : `${context.command} failed`,
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
  const observations = devices.map((device) => {
    const hardwareSerial = identityBySerial.get(device.serial);
    return {
      device,
      ...(hardwareSerial === undefined ? {} : { hardwareSerial }),
    };
  });
  const inventory = buildTargetInventory(
    correlateMdnsTransportIdentities(observations, services),
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

function portPlanTitle(
  direction: PortDirection,
  action: Exclude<PortAction, "list">,
  mapping: { host: string; device: string },
): string {
  if (action === "remove") {
    return direction === "forward"
      ? `Remove forward listener on host ${mapping.host}`
      : `Remove reverse listener on device ${mapping.device}`;
  }
  return direction === "forward"
    ? `Add forward mapping from host ${mapping.host} to device ${mapping.device}`
    : `Add reverse mapping from device ${mapping.device} to host ${mapping.host}`;
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
              title: portPlanTitle(request.direction, request.action, requested),
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

export interface LogsOptions {
  packageName?: string;
  pid?: number;
  tags?: readonly string[];
  excludeTags?: readonly string[];
  minimumPriority?: "A" | "D" | "E" | "F" | "I" | "S" | "V" | "W";
  buffers?: readonly ("crash" | "main" | "system")[];
  since?: string;
  tail?: number;
  dump?: boolean;
  maxRecords?: number;
  onLine?: (line: string) => void;
}

export interface LogRecord {
  raw: string;
  parsed: boolean;
  message: string;
  priority?: string;
  tag?: string;
  pid?: number;
  tid?: number;
}

export interface LogsData {
  adbPath: string;
  selected: SelectedTarget;
  packageName?: string;
  pid?: number;
  uid?: number;
  buffers: string[];
  filters: string[];
  records: LogRecord[];
  findings: Array<LogFinding & { message: string; priority?: string; tag?: string }>;
  dropped: number;
  process: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    durationMs: number;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  };
}

interface PackageLogSelector {
  packageName: string;
  pid?: number;
  uid?: number;
}

function packageUid(output: string, packageName: string): number | undefined {
  for (const line of output.replaceAll("\r\n", "\n").split("\n")) {
    const match = line.trim().match(/^package:(\S+)\s+uid:(\d+)(?:\s|$)/u);
    if (match?.[1] !== packageName) continue;
    const uid = Number(match[2]);
    if (Number.isSafeInteger(uid) && uid >= 0) return uid;
  }
  return undefined;
}

function supportsLogcatUid(output: string): boolean {
  return /(?:^|\s)--uid(?:=|\s)/u.test(output);
}

async function resolvePackageLogSelector(
  client: AdbClient,
  target: AdbTargetSelector,
  packageName: string,
  signal?: AbortSignal,
): Promise<PackageLogSelector | undefined> {
  const packages = await client.targetCommand(
    target,
    "package-log-identity",
    `Resolving log identity for ${packageName}`,
    ["shell", "cmd", "package", "list", "packages", "-U", packageName],
    (output) => output,
    signal,
    { acceptExitCodes: [1] },
  );
  const uid = processSucceeded(packages.process)
    ? packageUid(packages.value, packageName)
    : undefined;
  if (uid !== undefined) {
    const logcatHelp = await client.targetCommand(
      target,
      "logcat-capabilities",
      "Checking app log filtering",
      ["logcat", "--help"],
      (output) => output,
      signal,
      { acceptExitCodes: [1] },
    );
    if (processSucceeded(logcatHelp.process) && supportsLogcatUid(logcatHelp.value)) {
      return { packageName, uid };
    }
  }
  const pid = await client.targetCommand(
    target,
    "package-log-pid",
    `Resolving current process for ${packageName}`,
    ["shell", "pidof", "-s", packageName],
    (output) => output.trim(),
    signal,
    { acceptExitCodes: [1] },
  );
  const parsedPid = processSucceeded(pid.process) ? Number(pid.value) : Number.NaN;
  return Number.isSafeInteger(parsedPid) && parsedPid > 0
    ? { packageName, pid: parsedPid }
    : undefined;
}

export async function runLogs(
  options: LogsOptions,
  config: CommandConfig = {},
  dependencies: CommandDependencies = {},
  signal?: AbortSignal,
): Promise<CommandExecution<LogsData>> {
  const context = createContext("logs", dependencies);
  const problems: Problem[] = [];
  const excludedTags = new Set(options.excludeTags ?? []);
  const conflictingTags = [...new Set((options.tags ?? []).filter((tag) => excludedTags.has(tag)))];
  if (conflictingTags.length > 0) {
    problems.push(
      commandProblem(
        ProblemCode.LogcatFailed,
        "input.logs.tags",
        "A log tag cannot be both included and excluded.",
        "Remove each conflicting tag from either the include or exclude filter.",
        context.commandId,
        [{ source: "logs.options", field: "conflictingTags", value: conflictingTags }],
      ),
    );
    return finish<LogsData>(context, null, problems);
  }
  const executable = await resolveAdb(context, config, dependencies);
  if (executable === undefined) {
    problems.push(adbNotFoundProblem({ commandId: context.commandId }, config.adbPath));
    return finish<LogsData>(context, null, problems);
  }
  const discoveryClient = createClient(executable, context, config, dependencies);
  const devices = await discoveryClient.devices(signal);
  if (!processSucceeded(devices.process)) {
    problems.push(operationProblem("devices", devices, context.commandId));
    return finish<LogsData>(context, null, problems);
  }
  const inspection = await inspectTargets(
    discoveryClient,
    devices.value,
    context.commandId,
    signal,
  );
  if (inspection.interruption !== undefined) {
    problems.push(inspection.interruption);
    return finish<LogsData>(context, null, problems);
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
    problems.push(targetSelectionProblem(selection, { commandId: context.commandId }));
    return finish<LogsData>(context, null, problems);
  }
  const selected = selection.selection;
  const target = targetForAdb(selected);
  const correlation = { commandId: context.commandId, targetId: selected.target.id };
  const client = new AdbClient({
    executable,
    bus: context.bus,
    correlation,
    ...(config.adbHost === undefined ? {} : { host: config.adbHost }),
    ...(config.adbPort === undefined ? {} : { port: config.adbPort }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(dependencies.runner === undefined ? {} : { runner: dependencies.runner }),
    ...(dependencies.idFactory === undefined ? {} : { idFactory: dependencies.idFactory }),
  });
  let resolvedPid = options.pid;
  let resolvedUid: number | undefined;
  if (resolvedPid === undefined && options.packageName !== undefined) {
    const selector = await resolvePackageLogSelector(client, target, options.packageName, signal);
    if (selector === undefined) {
      problems.push(
        commandProblem(
          ProblemCode.LogPackageNotRunning,
          "logcat.package",
          `Android package ${options.packageName} is not running on the selected target.`,
          "Start the app and retry, or omit --package to inspect target-wide logs.",
          context.commandId,
        ),
      );
      return finish<LogsData>(context, null, problems);
    }
    resolvedPid = selector.pid;
    resolvedUid = selector.uid;
  }
  const priority = options.minimumPriority ?? "I";
  const filters =
    options.tags === undefined || options.tags.length === 0
      ? [`*:${priority}`]
      : [...options.tags.map((tag) => `${tag}:${priority}`), "*:S"];
  for (const tag of options.excludeTags ?? []) {
    filters.unshift(`${tag}:S`);
  }
  const buffers = [...new Set(options.buffers ?? [])];
  if (options.tail !== undefined && (!Number.isSafeInteger(options.tail) || options.tail < 1)) {
    problems.push(
      commandProblem(
        ProblemCode.LogcatFailed,
        "input.logs.tail",
        "The log tail count must be a positive integer.",
        "Use --tail with a value of at least 1.",
        context.commandId,
      ),
    );
    return finish<LogsData>(context, null, problems);
  }
  if (options.tail !== undefined && options.since !== undefined) {
    problems.push(
      commandProblem(
        ProblemCode.LogcatFailed,
        "input.logs.window",
        "Only one log start window can be selected.",
        "Use either --tail or --since, not both.",
        context.commandId,
      ),
    );
    return finish<LogsData>(context, null, problems);
  }
  const maxRecords = options.maxRecords ?? 2_000;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
    problems.push(
      commandProblem(
        ProblemCode.LogcatFailed,
        "input.logs.max-records",
        "The log record limit must be a positive integer.",
        "Use --max-records with a value of at least 1.",
        context.commandId,
      ),
    );
    return finish<LogsData>(context, null, problems);
  }
  const records: LogRecord[] = [];
  const findings: LogsData["findings"] = [];
  const findingCodes = new Set<string>();
  let dropped = 0;
  const recordLine = (raw: string) => {
    if (raw === "" || /^-+ beginning of /u.test(raw)) return;
    const safeRaw = redactText(raw).value;
    const parsed = parseLogcatThreadtimeLine(safeRaw);
    const record: LogRecord = {
      raw: safeRaw,
      parsed: parsed !== undefined,
      message: parsed?.message ?? safeRaw,
      ...(parsed === undefined
        ? {}
        : { priority: parsed.priority, tag: parsed.tag, pid: parsed.pid, tid: parsed.tid }),
    };
    records.push(record);
    while (records.length > maxRecords) {
      records.shift();
      dropped += 1;
    }
    const attribution: LogAttribution =
      options.packageName !== undefined
        ? "application"
        : resolvedPid !== undefined
          ? "process"
          : "device";
    const finding = classifyLogRecord(parsed, safeRaw, attribution);
    if (finding !== undefined && !findingCodes.has(finding.code)) {
      findingCodes.add(finding.code);
      findings.push({
        ...finding,
        message: record.message,
        ...(record.priority === undefined ? {} : { priority: record.priority }),
        ...(record.tag === undefined ? {} : { tag: record.tag }),
      });
      context.bus.emit({
        type: "log.problem",
        source: "logcat",
        severity: "error",
        message: finding.summary,
        correlation,
        data: {
          code: finding.code,
          attribution: finding.attribution,
          detail: finding.detail,
          evidence: record.message,
          ...(record.priority === undefined ? {} : { priority: record.priority }),
          ...(record.tag === undefined ? {} : { tag: record.tag }),
        },
      });
    }
    context.bus.emit({
      type: "log.record",
      source: "logcat",
      severity: streamSeverity(parsed),
      message: record.message,
      correlation,
      data: {
        raw: record.raw,
        parsed: record.parsed,
        ...(record.priority === undefined ? {} : { priority: record.priority }),
        ...(record.tag === undefined ? {} : { tag: record.tag }),
        ...(record.pid === undefined ? {} : { pid: record.pid }),
        ...(record.tid === undefined ? {} : { tid: record.tid }),
        attribution,
      },
    });
    options.onLine?.(safeRaw);
  };
  const runner = dependencies.runner ?? runProcess;
  const selectorArgs =
    target.transportId === undefined ? ["-s", target.serial] : ["-t", target.transportId];
  const adbPrefix = [
    ...(config.adbHost === undefined ? [] : ["-H", config.adbHost]),
    ...(config.adbPort === undefined ? [] : ["-P", String(config.adbPort)]),
    ...selectorArgs,
  ];
  const logcatArgs = (window: readonly string[]) => [
    ...adbPrefix,
    "logcat",
    "-v",
    "threadtime",
    ...buffers.flatMap((buffer) => ["-b", buffer]),
    ...window,
    ...(resolvedUid === undefined ? [] : [`--uid=${String(resolvedUid)}`]),
    ...(resolvedPid === undefined ? [] : [`--pid=${String(resolvedPid)}`]),
    ...filters,
  ];
  const runLogcat = async (
    window: readonly string[],
    lineBuffer: TextLineBuffer,
  ): Promise<ProcessResult> =>
    await runner({
      executable,
      args: logcatArgs(window),
      ...(signal === undefined ? {} : { signal }),
      maxBufferBytes: 4 * 1024 * 1024,
      onStdoutChunk: (chunk) => lineBuffer.push(chunk),
      onStderrChunk: (chunk) => lineBuffer.push(chunk),
    });

  const setupProcesses: ProcessResult[] = [];
  let processResult: ProcessResult;
  if (options.tail === undefined) {
    const lines = new TextLineBuffer(recordLine);
    processResult = await runLogcat(
      options.since === undefined
        ? options.dump
          ? ["-d"]
          : ["-T", "1"]
        : [options.dump ? "-t" : "-T", options.since],
      lines,
    );
    lines.flush();
  } else {
    const tailCount = options.tail;
    let followBoundary = "1";
    if (!options.dump) {
      const boundaryResult = await runner({
        executable,
        args: [...adbPrefix, "shell", "date", "+%s.000"],
        ...(signal === undefined ? {} : { signal }),
        maxBufferBytes: 1_024,
      });
      const value = boundaryResult.stdout.trim();
      if (!processSucceeded(boundaryResult) || !/^\d{9,}\.\d{3}$/u.test(value)) {
        problems.push(
          commandProblem(
            ProblemCode.LogcatFailed,
            "logcat.tail-boundary",
            "ADB Ready could not establish a gap-free log tail boundary.",
            "Verify that the selected target supports the Android date command and retry.",
            context.commandId,
          ),
        );
        return finish<LogsData>(context, null, problems);
      }
      followBoundary = value;
      setupProcesses.push(boundaryResult);
    }

    const recentLines: string[] = [];
    const snapshotLines = new TextLineBuffer((raw) => {
      if (raw === "" || /^-+ beginning of /u.test(raw)) return;
      recentLines.push(raw);
      while (recentLines.length > tailCount) recentLines.shift();
    });
    const snapshotResult = await runLogcat(["-d"], snapshotLines);
    snapshotLines.flush();
    for (const line of recentLines) recordLine(line);

    if (options.dump || !processSucceeded(snapshotResult)) {
      processResult = snapshotResult;
    } else {
      setupProcesses.push(snapshotResult);
      const replayed = new Map<string, number>();
      for (const line of recentLines) replayed.set(line, (replayed.get(line) ?? 0) + 1);
      const liveLines = new TextLineBuffer((raw) => {
        const remaining = replayed.get(raw) ?? 0;
        if (remaining > 0) {
          if (remaining === 1) replayed.delete(raw);
          else replayed.set(raw, remaining - 1);
          return;
        }
        recordLine(raw);
      });
      processResult = await runLogcat(["-T", followBoundary], liveLines);
      liveLines.flush();
    }
  }
  if (processResult.aborted && signal?.aborted === true) {
    problems.push(
      commandProblem(
        ProblemCode.OperationInterrupted,
        "logcat.interrupted",
        "Log streaming was interrupted.",
        "ADB Ready stopped its owned logcat process safely.",
        context.commandId,
      ),
    );
  } else if (!processSucceeded(processResult)) {
    problems.push(
      commandProblem(
        ProblemCode.LogcatFailed,
        "logcat.exit",
        "Logcat failed for the selected target.",
        `The process exited with ${processResult.exitCode === null ? String(processResult.signal) : String(processResult.exitCode)}.`,
        context.commandId,
      ),
    );
  }
  return finish(
    context,
    {
      adbPath: redactedPath(executable),
      selected,
      ...(options.packageName === undefined ? {} : { packageName: options.packageName }),
      ...(resolvedPid === undefined ? {} : { pid: resolvedPid }),
      ...(resolvedUid === undefined ? {} : { uid: resolvedUid }),
      buffers,
      filters,
      records,
      findings,
      dropped,
      process: {
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        durationMs:
          setupProcesses.reduce((total, process) => total + process.durationMs, 0) +
          processResult.durationMs,
        stdoutTruncated:
          setupProcesses.some(({ stdoutTruncated }) => stdoutTruncated) ||
          processResult.stdoutTruncated,
        stderrTruncated:
          setupProcesses.some(({ stderrTruncated }) => stderrTruncated) ||
          processResult.stderrTruncated,
      },
    },
    problems,
  );
}

export interface DevCommand {
  executable: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

const TARGET_SERIAL_PLACEHOLDER = "{target.serial}";

function bindTargetSerial(command: DevCommand, serial: string): DevCommand {
  return {
    ...command,
    args: command.args.map((argument) => argument.replaceAll(TARGET_SERIAL_PLACEHOLDER, serial)),
  };
}

export interface DevOptions {
  cwd: string;
  applicationId?: string;
  mode?: "dev" | "run";
  preset?: DevPreset;
  packageManager?: PackageManagerName;
  command?: DevCommand;
  reversePorts?: readonly DevPort[];
  autoReverseLocalhost?: boolean;
  cleanupPorts?: boolean;
  logs?: boolean;
  journal?: {
    maxEntries?: number;
    maxBytes?: number;
    sources?: readonly string[];
    minimumSeverity?: "debug" | "error" | "info" | "warning";
    redaction?: {
      additionalLiterals?: readonly string[];
    };
  };
  childStdin?: "ignore" | "inherit";
  onLiveControlsReady?: DevLiveControlsReady;
  onChildLine?: (stream: "stderr" | "stdout", line: string) => void;
  hooks?: Partial<Record<DevHookEvent, readonly DevHook[]>>;
  watch?: boolean;
  watchIntervalMs?: number;
  recovery?: RecoveryPolicyInput;
  readiness?: {
    all: readonly ReadinessAssertion[];
    timeoutMs?: number;
    pollIntervalMs?: number;
  };
  verification?: {
    command: DevCommand;
    timeoutMs?: number;
  };
  sessionStore?: false | SessionStoreOptions;
}

export interface DevData {
  sessionId: string;
  status: "completed" | "failed" | "interrupted" | "planned";
  /** Present on new results; optional when reading sessions persisted by earlier releases. */
  reachedReady?: boolean;
  adbPath?: string;
  selected?: SelectedTarget;
  planScope?: "offline" | "target";
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
  localServices: DiscoveredLocalService[];
  command: {
    executable: string;
    args: string[];
    cwd: string;
    envKeys: string[];
  };
  attachedService?: {
    kind: "metro";
    endpoint: string;
    ownership: "external";
  };
  expoLaunch?: {
    url: string;
    runtime: "custom" | "expo";
    source: "link" | "open";
    applicationId: string;
    activity: string;
    verified: true;
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
  hooks: {
    completed: number;
    failed: number;
  };
  recovery: SessionWatchSummary;
  readiness?: ReadinessResult;
  verification?: {
    command: DevData["command"];
    passed: boolean;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    durationMs: number;
    timedOut: boolean;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    /** Bounded, redacted native verifier output retained for evidence export. */
    stdout?: string;
    /** Bounded, redacted native verifier output retained for evidence export. */
    stderr?: string;
  };
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
  targetSerial?: string,
): Promise<DevCommand | undefined> {
  if (options.command !== undefined) return options.command;
  if (preset === "custom") return undefined;
  if (preset === "flutter") {
    const flutter = await (dependencies.locateExecutable ?? locateExecutable)("flutter");
    return flutter === undefined
      ? undefined
      : { executable: flutter, args: ["run", "-d", targetSerial ?? "<selected-target>"] };
  }
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
  if (preset === "capacitor") {
    return directPackageCommand(manager.name, manager.executable, "cap", [
      "run",
      "android",
      "--target",
      targetSerial ?? "<selected-target>",
    ]);
  }
  const script = preset === "expo" ? "start" : "android";
  const frameworkArgs: string[] = [];
  if (project.packageJson?.scripts[script] !== undefined) {
    return {
      ...packageScriptCommand(manager.name, manager.executable, script, frameworkArgs),
    };
  }
  return directPackageCommand(
    manager.name,
    manager.executable,
    preset === "expo" ? "expo" : "react-native",
    preset === "expo" ? ["start"] : ["run-android"],
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

function devReadinessAssertions(
  options: DevOptions,
  preset: DevPreset,
  mappings: readonly { device: string; host: string }[],
  localServices: readonly DiscoveredLocalService[],
): readonly ReadinessAssertion[] {
  if (options.readiness !== undefined) return options.readiness.all;
  if (preset === "custom") return [];
  const metro = mappings.find(({ device }) => device === "tcp:8081") ?? mappings[0];
  const port = metro?.host.match(/^tcp:(\d+)$/u)?.[1];
  const localServiceHostPorts = localServices.flatMap(({ devicePort }) => {
    const mapping = mappings.find(({ device }) => device === `tcp:${String(devicePort)}`);
    const hostPort = mapping?.host.match(/^tcp:(\d+)$/u)?.[1];
    return hostPort === undefined ? [] : [Number(hostPort)];
  });
  const hostPorts = [
    ...new Set([...(port === undefined ? [] : [Number(port)]), ...localServiceHostPorts]),
  ];
  return [
    { kind: "boot" },
    ...(preset !== "expo" && preset !== "react-native"
      ? []
      : hostPorts.map((hostPort) => ({
          kind: "host-port" as const,
          host: "localhost",
          port: hostPort,
        }))),
  ];
}

function metroServicePort(
  preset: DevPreset,
  mappings: readonly { device: string; host: string }[],
): number | undefined {
  if (preset !== "expo" && preset !== "react-native") return undefined;
  const mapping = mappings.find(({ device }) => device === "tcp:8081") ?? mappings[0];
  const port = mapping?.host.match(/^tcp:(\d+)$/u)?.[1];
  return port === undefined ? undefined : Number(port);
}

function expoDevicePort(mappings: readonly { device: string; host: string }[]): number | undefined {
  const mapping = mappings.find(({ device }) => device === "tcp:8081") ?? mappings[0];
  const port = mapping?.device.match(/^tcp:(\d+)$/u)?.[1];
  return port === undefined ? undefined : Number(port);
}

async function launchExpoOnSelectedTarget(options: {
  client: AdbClient;
  target: import("../adb/client.js").AdbTargetSelector;
  endpoint: string;
  devicePort: number;
  runtime: "custom" | "expo";
  commandId: string;
  problems: Problem[];
  dependencies: CommandDependencies;
  signal?: AbortSignal;
}): Promise<DevData["expoLaunch"] | undefined> {
  const resolution: ExpoLaunchResolution = await (
    options.dependencies.resolveExpoLaunch ?? resolveExpoLaunch
  )({
    endpoint: options.endpoint,
    runtime: options.runtime,
    devicePort: options.devicePort,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (resolution.status === "aborted") {
    options.problems.push(
      commandProblem(
        ProblemCode.OperationInterrupted,
        "child.interrupted",
        "The Expo launch was interrupted.",
        "ADB Ready did not open the project on any Android target.",
        options.commandId,
      ),
    );
    return undefined;
  }
  if (resolution.status === "unavailable") {
    options.problems.push(
      commandProblem(
        ProblemCode.ExpoLaunchFailed,
        "child.expo-launch",
        "Expo did not provide a valid Android launch URL.",
        `${resolution.detail} Ensure the configured host port belongs to the Expo development server.`,
        options.commandId,
        [{ source: "expo.dev-server", field: "endpoint", value: options.endpoint }],
      ),
    );
    return undefined;
  }

  const resolved = await options.client.targetCommand(
    options.target,
    "expo-activity-resolve",
    "Resolving the Expo URL handler on the selected target",
    [
      "shell",
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      resolution.target.url,
    ],
    parseResolvedActivity,
    options.signal,
  );
  if (!processSucceeded(resolved.process) || resolved.value === undefined) {
    options.problems.push(
      commandProblem(
        ProblemCode.ExpoLaunchFailed,
        "child.expo-launch",
        "No app on the selected target can open this Expo project.",
        resolution.target.runtime === "custom"
          ? "Install the project's Android development build on the selected target, then retry."
          : "Install or update Expo Go on the selected target, then retry.",
        options.commandId,
        [
          { source: "expo.launch", field: "runtime", value: resolution.target.runtime },
          ...(resolution.target.applicationId === undefined
            ? []
            : [
                {
                  source: "expo.launch",
                  field: "applicationId",
                  value: resolution.target.applicationId,
                },
              ]),
        ],
      ),
    );
    return undefined;
  }

  const component = `${resolved.value.applicationId}/${resolved.value.activity}`;
  const launched = await options.client.targetCommand(
    options.target,
    "expo-target-launch",
    `Opening the Expo project on ${options.target.serial}`,
    [
      "shell",
      "am",
      "start",
      "-W",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      resolution.target.url,
      "-n",
      component,
    ],
    (output) => output,
    options.signal,
  );
  if (!processSucceeded(launched.process) || /\b(?:Error|Exception):/iu.test(launched.value)) {
    options.problems.push(
      commandProblem(
        ProblemCode.ExpoLaunchFailed,
        "child.expo-launch",
        "The Expo project could not be opened on the selected target.",
        "Android Activity Manager rejected the target-scoped launch request.",
        options.commandId,
        [
          { source: "adb.expo-target-launch", field: "exitCode", value: launched.process.exitCode },
          { source: "expo.launch", field: "applicationId", value: resolved.value.applicationId },
        ],
      ),
    );
    return undefined;
  }

  return {
    ...resolution.target,
    applicationId: resolved.value.applicationId,
    activity: resolved.value.activity,
    verified: true,
  };
}

interface ResolvedDevDefinition {
  project: ProjectDetection;
  preset: DevPreset;
  childCommand: DevCommand;
  mappings: Array<{ device: string; host: string }>;
  localServices: DiscoveredLocalService[];
}

function missingFrameworkLauncherProblem(
  preset: DevPreset,
  commandId: string,
): Problem | undefined {
  if (preset === "flutter") {
    return {
      ...commandProblem(
        ProblemCode.FrameworkLauncherNotFound,
        "environment.framework",
        "The Flutter executable was not found.",
        "Install the Flutter SDK, add its bin directory to PATH, and confirm `flutter doctor` succeeds before retrying. Setup: https://docs.flutter.dev/install",
        commandId,
        [
          { source: "project", field: "preset", value: preset },
          { source: "host", field: "attemptedExecutable", value: "flutter" },
        ],
      ),
      actions: [
        {
          id: "install_flutter_sdk",
          title: "Install Flutter and add its bin directory to PATH",
          kind: "documentation",
          risk: "none",
          automatic: false,
        },
      ],
    };
  }
  if (preset === "gradle") {
    return {
      ...commandProblem(
        ProblemCode.FrameworkLauncherNotFound,
        "environment.framework",
        "No runnable Gradle Wrapper was found.",
        "Restore the project's gradlew, gradlew.bat, and Gradle Wrapper files. Existing Gradle projects should run through their checked-in Wrapper.",
        commandId,
        [
          { source: "project", field: "preset", value: preset },
          {
            source: "project",
            field: "attemptedLaunchers",
            value: ["gradlew", "gradlew.bat", "gradle/wrapper/gradle-wrapper.jar"],
          },
        ],
      ),
      actions: [
        {
          id: "restore_gradle_wrapper",
          title: "Restore the project's Gradle Wrapper files",
          kind: "documentation",
          risk: "none",
          automatic: false,
        },
      ],
    };
  }
  return undefined;
}

async function resolveDevDefinition(
  options: DevOptions,
  dependencies: CommandDependencies,
  commandId: string,
  targetSerial?: string,
): Promise<{ definition?: ResolvedDevDefinition; problems: Problem[] }> {
  const problems: Problem[] = [];
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
        "Choose --preset expo, react-native, flutter, capacitor, gradle, or pass a custom command after --.",
        commandId,
      ),
    );
    return { problems };
  }
  if (
    project.packageManager.conflicts.length > 0 &&
    (preset === "expo" || preset === "react-native" || preset === "capacitor")
  ) {
    problems.push(
      commandProblem(
        ProblemCode.PackageManagerConflict,
        "input.dev.package-manager",
        "Multiple package-manager signals conflict.",
        "Declare packageManager in package.json, use --package-manager, or remove stale metadata or lockfiles.",
        commandId,
        [{ source: "project", field: "candidates", value: project.packageManager.conflicts }],
      ),
    );
    return { problems };
  }
  if (
    (preset === "expo" || preset === "react-native" || preset === "capacitor") &&
    (project.packageManager.name === undefined || project.packageManager.executable === undefined)
  ) {
    problems.push(
      commandProblem(
        ProblemCode.PackageManagerNotFound,
        "environment.package-manager",
        "The project's package manager is unavailable.",
        "Install the declared package manager or select an available one with --package-manager.",
        commandId,
      ),
    );
    return { problems };
  }
  const childCommand = await resolveDevCommand(
    preset,
    project,
    options,
    dependencies,
    targetSerial,
  );
  if (childCommand === undefined || childCommand.executable.trim() === "") {
    const frameworkProblem =
      options.command === undefined
        ? missingFrameworkLauncherProblem(preset, commandId)
        : undefined;
    problems.push(
      frameworkProblem ??
        commandProblem(
          ProblemCode.DevCommandNotFound,
          "input.dev.command",
          "No runnable development command was found.",
          "Configure an executable and argument array or pass a custom command after --.",
          commandId,
        ),
    );
    return { problems };
  }
  const defaultPorts = preset === "expo" || preset === "react-native" ? [{ device: 8081 }] : [];
  let localServices: DiscoveredLocalService[] = [];
  if (preset === "expo" && options.autoReverseLocalhost !== false) {
    try {
      localServices = (dependencies.discoverExpoLocalServices ?? discoverExpoLocalServices)({
        projectRoot: project.root,
        env: dependencies.env ?? process.env,
      });
    } catch {
      problems.push(
        commandProblem(
          ProblemCode.ExpoEnvironmentDiscoveryFailed,
          "environment.project",
          "Expo localhost services could not be discovered safely.",
          "Fix the project environment-file syntax, or use --no-auto-reverse-localhost and declare every required service with --port.",
          commandId,
        ),
      );
      return { problems };
    }
  }
  const configuredPorts = options.reversePorts ?? defaultPorts;
  const coveredDevicePorts = new Set(configuredPorts.map(({ device }) => Number(device)));
  const discoveredPorts = localServices
    .filter(({ devicePort }) => !coveredDevicePorts.has(devicePort))
    .map(({ devicePort, hostPort }) => ({ device: devicePort, host: hostPort }));
  const normalized = normalizeDevPorts([...configuredPorts, ...discoveredPorts], commandId);
  problems.push(...normalized.problems);
  return normalized.problems.length > 0
    ? { problems }
    : {
        problems,
        definition: {
          project,
          preset,
          childCommand,
          mappings: normalized.mappings,
          localServices,
        },
      };
}

export async function runDevOfflinePlan(
  options: DevOptions,
  dependencies: CommandDependencies = {},
): Promise<CommandExecution<DevData>> {
  const bus = dependencies.bus ?? new EventBus(dependencies.clock);
  const idFactory = dependencies.idFactory ?? randomUUID;
  const context = createContext(options.mode ?? "dev", { ...dependencies, bus, idFactory });
  const sessionId = idFactory();
  const journal = new EventJournal(bus, options.journal);
  const resolved = await resolveDevDefinition(options, dependencies, context.commandId);
  if (resolved.definition === undefined) {
    const execution = finish<DevData>(context, null, resolved.problems);
    journal.close();
    return execution;
  }
  const { project, preset, childCommand, mappings, localServices } = resolved.definition;
  if (localServices.length > 0) {
    bus.emit({
      type: "local.service.discovered",
      source: "project.env",
      severity: "info",
      message: `${String(localServices.length)} public Expo localhost service(s) added to the session`,
      correlation: { commandId: context.commandId, sessionId },
      data: {
        services: localServices.map(({ devicePort, hostPort, variables, environmentFiles }) => ({
          devicePort,
          hostPort,
          variables,
          environmentFiles,
        })),
      },
    });
  }
  const readinessAssertions = devReadinessAssertions(options, preset, mappings, localServices);
  const commandCwd = path.resolve(project.root, childCommand.cwd ?? ".");
  const hookSteps = (event: DevHookEvent) =>
    (options.hooks?.[event] ?? []).map((hook, index) => ({
      id: `hook-${event}-${String(index + 1)}`,
      title: `Run ${event} hook ${String(index + 1)}`,
      risk: "open-world" as const,
      executable: redactText(hook.run[0]).value,
      args: hook.run.slice(1).map((argument) => redactText(argument).value),
    }));
  const steps = [
    {
      id: "acquire-target",
      title: "Select and exclusively lease one ready Android target",
      risk: "device-reversible" as const,
    },
    ...hookSteps("beforeDev"),
    ...hookSteps("onTargetReady"),
    ...mappings.map((mapping, index) => ({
      id: `reverse-${String(index + 1)}`,
      title: `Ensure device ${mapping.device} maps to host ${mapping.host}`,
      risk: "device-reversible" as const,
    })),
    ...hookSteps("onPortsReady"),
    {
      id: "start-child",
      title: `Start ${preset} development command`,
      risk: "open-world" as const,
      executable: redactedPath(childCommand.executable),
      args: childCommand.args.map((argument) => redactText(argument).value),
    },
    ...readinessAssertions.map((assertion, index) => ({
      id: `ready-${String(index + 1)}`,
      title: `Verify ${assertion.kind} readiness`,
      risk: "read-only" as const,
    })),
    ...(preset === "expo"
      ? [
          {
            id: "resolve-expo-launch",
            title: "Resolve Expo's Android deep link from the verified Metro server",
            risk: "read-only" as const,
          },
          {
            id: "launch-expo-target",
            title: "Open the Expo project only on the selected Android target",
            risk: "device-reversible" as const,
          },
        ]
      : []),
    ...hookSteps("onReady"),
    ...(options.verification === undefined
      ? []
      : [
          {
            id: "run-verification",
            title: "Run the bounded verification command",
            risk: "open-world" as const,
            executable: redactedPath(options.verification.command.executable),
            args: options.verification.command.args.map((argument) => redactText(argument).value),
          },
        ]),
    ...hookSteps("onChildExit"),
    ...hookSteps("finally"),
  ];
  bus.emit({
    type: "session.planned",
    source: "session",
    severity: "info",
    message: "Offline development session plan is ready",
    correlation: { commandId: context.commandId, sessionId },
  });
  const snapshot = journal.close();
  return finish<DevData>(
    context,
    {
      sessionId,
      status: "planned",
      reachedReady: false,
      planScope: "offline",
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
      ports: { requested: mappings, created: [], reused: [], cleaned: false },
      localServices,
      command: {
        executable: redactedPath(childCommand.executable),
        args: childCommand.args.map((argument) => redactText(argument).value),
        cwd: redactedPath(commandCwd),
        envKeys: [...new Set(["ANDROID_SERIAL", ...Object.keys(childCommand.env ?? {})])].sort(),
      },
      plan: { schemaVersion: SCHEMA_VERSION, dryRun: true, steps },
      journal: snapshot,
      hooks: { completed: 0, failed: 0 },
      recovery: {
        checks: 0,
        degradations: 0,
        recoveryAttempts: 0,
        recoveries: 0,
        targetChanges: 0,
        failed: false,
      },
    },
    resolved.problems,
  );
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

const CHILD_DIAGNOSTIC_PATTERN =
  /(?:commanderror|error|fatal|exception|failed|failure|unable|cannot|could not|not found|not installed)(?::|\b)/iu;
const CHILD_STARTUP_SETTLE_MS = 250;

function childFailureDiagnostic(result: ProcessResult): string | undefined {
  const lines = [result.stderr, result.stdout].flatMap((output) =>
    output
      .replaceAll("\r\n", "\n")
      .split("\n")
      .map((line) => line.replace(/\s+/gu, " ").trim())
      .filter((line) => line !== ""),
  );
  const diagnostic = lines.find((line) => CHILD_DIAGNOSTIC_PATTERN.test(line)) ?? lines.at(-1);
  if (diagnostic === undefined) return undefined;
  return redactText(diagnostic).value.slice(0, 500);
}

function childProcessFailureProblem(
  result: ProcessResult,
  commandId: string,
  beforeReady: boolean,
): Problem {
  const diagnostic = childFailureDiagnostic(result);
  const exit = result.exitCode === null ? String(result.signal) : String(result.exitCode);
  return commandProblem(
    ProblemCode.ChildProcessFailed,
    "child.exit",
    beforeReady
      ? "The development command failed before the session became ready."
      : "The development command failed.",
    diagnostic === undefined ? `The child exited with ${exit}.` : diagnostic,
    commandId,
    [
      { source: "child", field: "exitCode", value: result.exitCode },
      { source: "child", field: "signal", value: result.signal },
      ...(diagnostic === undefined
        ? []
        : [{ source: "child", field: "diagnostic", value: diagnostic }]),
    ],
  );
}

async function observeChildStartup(
  child: Promise<ProcessResult>,
  signal?: AbortSignal,
): Promise<ProcessResult | undefined> {
  if (signal?.aborted === true) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finishBoundary: (() => void) | undefined;
  const boundary = new Promise<undefined>((resolve) => {
    finishBoundary = () => resolve(undefined);
    timer = setTimeout(finishBoundary, CHILD_STARTUP_SETTLE_MS);
    signal?.addEventListener("abort", finishBoundary, { once: true });
  });
  try {
    return await Promise.race([child, boundary]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (finishBoundary !== undefined) signal?.removeEventListener("abort", finishBoundary);
  }
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
  const context = createContext(options.mode ?? "dev", { ...dependencies, bus, idFactory });
  const problems: Problem[] = [];
  const stateMachine = new SessionStateMachine(dependencies.clock);
  let reachedReady = false;
  const transition = (to: SessionState, reason: string): void => {
    if (!stateMachine.canTransition(to)) return;
    const state = stateMachine.transition(to, reason);
    if (to === "ready") reachedReady = true;
    bus.emit({
      type: "session.state.changed",
      source: "session",
      severity: to === "failed" ? "error" : to === "degraded" ? "warning" : "info",
      message: `Development session is ${to}`,
      correlation: { commandId: context.commandId, sessionId },
      data: { from: state.from, to: state.to, reason: state.reason },
    });
  };
  let recorder: SessionRecorder | undefined;
  if (options.sessionStore !== undefined && options.sessionStore !== false && !config.dryRun) {
    try {
      recorder = await SessionRecorder.create(
        bus,
        {
          sessionId,
          command: options.mode ?? "dev",
          startedAt: (dependencies.clock ?? (() => new Date()))().toISOString(),
          projectRoot: options.cwd,
        },
        {
          ...options.sessionStore,
          projectRoot: options.sessionStore.projectRoot ?? options.cwd,
        },
      );
    } catch {
      problems.push({
        ...commandProblem(
          ProblemCode.SessionPersistenceFailed,
          "session.persistence",
          "Session history could not be started.",
          "The development session can continue, but this run will not be available afterward.",
          context.commandId,
        ),
        severity: "warning",
      });
    }
  }
  const complete = async (
    data: Omit<DevData, "journal"> | null,
  ): Promise<CommandExecution<DevData>> => {
    const interrupted = problems.some(({ code }) => code === ProblemCode.OperationInterrupted);
    const failed = problems.some(
      ({ code, severity }) => severity === "error" && code !== ProblemCode.OperationInterrupted,
    );
    if (failed) {
      transition(
        "failed",
        problems.find(
          ({ code, severity }) => severity === "error" && code !== ProblemCode.OperationInterrupted,
        )?.summary ?? "failed",
      );
    }
    transition("stopping", "finalizing owned session resources");
    transition("ended", "session command finalized");
    bus.emit({
      type: "session.ended",
      source: "session",
      severity: failed ? "error" : interrupted ? "warning" : "info",
      message: interrupted
        ? "Development session ended safely after interruption"
        : "Development session ended",
      correlation: { commandId: context.commandId, sessionId },
    });
    const execution = finish<DevData>(context, data as DevData | null, problems);
    const snapshot = journal.close();
    if (execution.result.data !== null) execution.result.data.journal = snapshot;
    if (recorder !== undefined) {
      const targetIdentity =
        data?.selected?.target.hardwareSerial ?? data?.selected?.transport.serial;
      const persisted = await recorder.finish({
        status: execution.result.problems.some(
          ({ code }) => code === ProblemCode.OperationInterrupted,
        )
          ? "interrupted"
          : execution.result.ok
            ? "completed"
            : "failed",
        finishedAt: (dependencies.clock ?? (() => new Date()))().toISOString(),
        problems: execution.result.problems,
        ...(targetIdentity === undefined ? {} : { targetIdentity }),
        ...(data?.preset === undefined ? {} : { preset: data.preset }),
      });
      if (!persisted.ok) {
        execution.result.problems.push({
          ...commandProblem(
            ProblemCode.SessionPersistenceFailed,
            "session.persistence",
            persisted.message,
            "The development session completed, but its local history is incomplete.",
            context.commandId,
          ),
          severity: "warning",
        });
      }
    }
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
  transition("acquiring-target", "discovering and selecting one Android target");

  const executable = await resolveAdb(context, config, dependencies);
  if (executable === undefined) {
    problems.push(adbNotFoundProblem(correlation, config.adbPath));
    return await complete(null);
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
    return await complete(null);
  }
  const inspection = await inspectTargets(
    discoveryClient,
    devices.value,
    context.commandId,
    signal,
  );
  if (inspection.interruption !== undefined) {
    problems.push(inspection.interruption);
    return await complete(null);
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
    return await complete(null);
  }
  let selected = selection.selection;
  let target = targetForAdb(selected);
  recorder?.addPrivateLiteral(selected.transport.serial);
  recorder?.addPrivateLiteral(selected.target.hardwareSerial);
  recorder?.addPrivateLiteral(selected.target.id);
  bus.emit({
    type: "target.selected",
    source: "target",
    severity: "info",
    message: `Selected ${selected.transport.serial}`,
    correlation: { ...correlation, targetId: selected.target.id },
    data: { serial: selected.transport.serial, reason: selected.reason },
  });
  const resolved = await resolveDevDefinition(
    options,
    dependencies,
    context.commandId,
    selected.transport.serial,
  );
  problems.push(...resolved.problems);
  if (resolved.definition === undefined) return await complete(null);
  const {
    project,
    preset,
    childCommand,
    mappings: requestedMappings,
    localServices,
  } = resolved.definition;
  recorder?.addPrivateLiteral(project.root);
  bus.emit({
    type: "session.configured",
    source: "session",
    severity: "info",
    message: `Development session configured for ${preset}`,
    correlation: { commandId: context.commandId, sessionId, targetId: selected.target.id },
    data: { preset },
  });
  if (localServices.length > 0) {
    bus.emit({
      type: "local.service.discovered",
      source: "project.env",
      severity: "info",
      message: `${String(localServices.length)} public Expo localhost service(s) added to the session`,
      correlation: { commandId: context.commandId, sessionId, targetId: selected.target.id },
      data: {
        services: localServices.map(({ devicePort, hostPort, variables, environmentFiles }) => ({
          devicePort,
          hostPort,
          variables,
          environmentFiles,
        })),
      },
    });
  }
  transition("preparing-ports", "target selected and project configuration resolved");
  const normalizedPorts = { mappings: requestedMappings };
  const readinessAssertions = devReadinessAssertions(
    options,
    preset,
    requestedMappings,
    localServices,
  );

  const targetCorrelation = { ...correlation, targetId: selected.target.id };
  const clientOptions = {
    executable,
    bus,
    correlation: targetCorrelation,
    ...(config.adbHost === undefined ? {} : { host: config.adbHost }),
    ...(config.adbPort === undefined ? {} : { port: config.adbPort }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(dependencies.runner === undefined ? {} : { runner: dependencies.runner }),
    idFactory,
  };
  const client = new AdbClient(clientOptions);
  const healthClient = new AdbClient({ ...clientOptions, presentation: "background" });
  const listed = await client.listPortMappings(target, "reverse", signal);
  if (!processSucceeded(listed.process)) {
    problems.push(operationProblem("reverse-list", listed, context.commandId));
    return await complete(null);
  }
  const existing = listed.value.map((mapping) => normalizePortMapping("reverse", mapping));
  const created: Array<{ device: string; host: string }> = [];
  const reused: Array<{ device: string; host: string }> = [];
  const loopbackBridges: LoopbackBridge[] = [];
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
  if (problems.some(({ severity }) => severity === "error")) return await complete(null);
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
  let attachedService: DevData["attachedService"];
  let expoLaunch: DevData["expoLaunch"];
  let expoControlEndpoint: string | undefined;
  const baseData = () => ({
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
    localServices,
    ...(attachedService === undefined ? {} : { attachedService }),
    ...(expoLaunch === undefined ? {} : { expoLaunch }),
  });
  let recoverySummary: SessionWatchSummary = {
    checks: 0,
    degradations: 0,
    recoveryAttempts: 0,
    recoveries: 0,
    targetChanges: 0,
    failed: false,
  };
  const hookRuns: HookRun[] = [];
  const hookSummary = (): DevData["hooks"] => ({
    completed: hookRuns.filter(({ ok }) => ok).length,
    failed: hookRuns.filter(({ ok }) => !ok).length,
  });
  const hookEnvironment = () => ({
    ANDROID_SERIAL: selected.transport.serial,
    ADB_READY_SESSION_ID: sessionId,
    ADB_READY_PRESET: preset,
    ADB_READY_TARGET_ID: selected.target.id,
  });
  const runHookPhase = async (
    event: DevHookEvent,
    extraEnvironment: Record<string, string> = {},
    useSessionSignal = true,
  ): Promise<boolean> => {
    const runs = await runHooks({
      hooks: options.hooks ?? {},
      event,
      projectRoot: project.root,
      environment: { ...hookEnvironment(), ...extraEnvironment },
      bus,
      correlation: targetCorrelation,
      ...(dependencies.runner === undefined ? {} : { runner: dependencies.runner }),
      ...(useSessionSignal && signal !== undefined ? { signal } : {}),
    });
    hookRuns.push(...runs);
    for (const run of runs) {
      if (run.ok || run.failure === "ignore") continue;
      if (run.result.aborted && signal?.aborted === true) {
        if (!problems.some(({ code }) => code === ProblemCode.OperationInterrupted)) {
          problems.push(
            commandProblem(
              ProblemCode.OperationInterrupted,
              "child.interrupted",
              "The development session was interrupted.",
              `The ${run.event} hook and owned session resources were stopped safely.`,
              context.commandId,
            ),
          );
        }
        continue;
      }
      problems.push({
        code: ProblemCode.HookFailed,
        category: "child.hook",
        severity: run.failure === "warn" ? "warning" : "error",
        summary: `${run.event} hook ${String(run.index + 1)} failed.`,
        detail: run.result.timedOut
          ? "The hook exceeded its configured timeout."
          : run.result.spawnError === undefined
            ? `The hook exited with ${run.result.exitCode === null ? String(run.result.signal) : String(run.result.exitCode)}.`
            : "The hook executable could not be started.",
        retryable: true,
        evidence: [
          { source: `hook.${run.event}`, field: "exitCode", value: run.result.exitCode },
          { source: `hook.${run.event}`, field: "signal", value: run.result.signal },
          { source: `hook.${run.event}`, field: "timedOut", value: run.result.timedOut },
        ],
        actions: [],
        correlation: {
          ...targetCorrelation,
          operationId: `hook:${run.event}:${String(run.index)}`,
        },
      });
    }
    return !runs.some(({ failure, ok }) => !ok && failure === "fail");
  };
  const hookPlanSteps = (event: DevHookEvent) =>
    (options.hooks?.[event] ?? []).map((hook, index) => ({
      id: `hook-${event}-${String(index + 1)}`,
      title: `Run ${event} hook ${String(index + 1)}`,
      risk: "open-world" as const,
      executable: redactText(hook.run[0]).value,
      args: hook.run.slice(1).map((argument) => redactText(argument).value),
    }));
  if (config.dryRun) {
    const selectorArgs =
      target.transportId === undefined ? ["-s", target.serial] : ["-t", target.transportId];
    const steps = [
      ...hookPlanSteps("beforeDev"),
      ...hookPlanSteps("onTargetReady"),
      ...pending.map((mapping, index) => ({
        id: `reverse-${String(index + 1)}`,
        title: `Map device ${mapping.device} to host ${mapping.host}`,
        risk: "device-reversible" as const,
        executable: redactedPath(executable),
        args: [...selectorArgs, "reverse", "--no-rebind", mapping.device, mapping.host],
      })),
      ...hookPlanSteps("onPortsReady"),
      {
        id: "start-child",
        title: `Start ${preset} development command`,
        risk: "open-world" as const,
        executable: commandData.executable,
        args: commandData.args,
      },
      ...readinessAssertions.map((assertion, index) => ({
        id: `ready-${String(index + 1)}`,
        title: `Verify ${assertion.kind} readiness`,
        risk: "read-only" as const,
      })),
      ...(preset === "expo"
        ? [
            {
              id: "resolve-expo-launch",
              title: "Resolve Expo's Android deep link from the verified Metro server",
              risk: "read-only" as const,
            },
            {
              id: "launch-expo-target",
              title: "Open the Expo project only on the selected Android target",
              risk: "device-reversible" as const,
              executable: redactedPath(executable),
              args: [...selectorArgs, "shell", "am", "start", "-W", "<resolved-expo-url>"],
            },
          ]
        : []),
      ...hookPlanSteps("onReady"),
      ...(options.verification === undefined
        ? []
        : [
            {
              id: "run-verification",
              title: "Run the bounded verification command",
              risk: "open-world" as const,
              executable: redactedPath(options.verification.command.executable),
              args: bindTargetSerial(options.verification.command, target.serial).args.map(
                (argument) => redactText(argument).value,
              ),
            },
          ]),
      ...hookPlanSteps("onChildExit"),
      ...hookPlanSteps("finally"),
    ];
    bus.emit({
      type: "session.planned",
      source: "session",
      severity: "info",
      message: "Development session plan is ready",
      correlation: targetCorrelation,
    });
    return await complete({
      ...baseData(),
      status: "planned",
      reachedReady: false,
      planScope: "target",
      ports: {
        requested: normalizedPorts.mappings,
        created,
        reused,
        cleaned: false,
      },
      hooks: hookSummary(),
      recovery: recoverySummary,
      plan: { schemaVersion: SCHEMA_VERSION, dryRun: true, steps },
    });
  }

  let cleaned = false;
  const failedData = (status: "failed" | "interrupted" = "failed"): Omit<DevData, "journal"> => ({
    ...baseData(),
    status,
    ports: {
      requested: normalizedPorts.mappings,
      created,
      reused,
      cleaned,
    },
    hooks: hookSummary(),
    recovery: recoverySummary,
  });

  if (!(await runHookPhase("beforeDev")) || !(await runHookPhase("onTargetReady"))) {
    await runHookPhase("finally", {}, false);
    return await complete(failedData());
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

  const cleanup = async (): Promise<void> => {
    if ((options.cleanupPorts === false || created.length === 0) && loopbackBridges.length === 0) {
      return;
    }
    if (options.cleanupPorts !== false && created.length > 0) {
      bus.emit({
        type: "session.stopping",
        source: "session",
        severity: "info",
        message: "Cleaning session-owned port mappings",
        correlation: targetCorrelation,
      });
    }
    let removalSucceeded = true;
    if (options.cleanupPorts !== false && created.length > 0) {
      for (const mapping of created) {
        const removed = await client.removePortMapping(target, "reverse", mapping.device);
        removalSucceeded = processSucceeded(removed.process) && removalSucceeded;
      }
      const remaining = await client.listPortMappings(target, "reverse");
      cleaned =
        removalSucceeded &&
        processSucceeded(remaining.process) &&
        !remaining.value
          .map((mapping) => normalizePortMapping("reverse", mapping))
          .some((mapping) => created.some((item) => item.device === mapping.device));
    }
    let bridgesCleaned = true;
    for (const bridge of loopbackBridges.splice(0).reverse()) {
      try {
        await bridge.close();
      } catch {
        bridgesCleaned = false;
      }
    }
    if ((options.cleanupPorts !== false && created.length > 0 && !cleaned) || !bridgesCleaned) {
      problems.push({
        code: ProblemCode.PortMappingCleanupFailed,
        category: "adb.port.cleanup",
        severity: "error",
        summary: "Session-owned port resources could not be fully removed.",
        detail:
          "ADB Ready attempted to remove its reverse mappings and local bridges, but at least one owned resource could not be verified as closed.",
        retryable: true,
        evidence: [
          {
            source: "adb.reverse",
            field: "ownedMappings",
            value: created.map(({ device, host }) => ({ device, host })),
          },
        ],
        actions: [],
        correlation: targetCorrelation,
      });
    }
  };

  const ensureBridgeForPort = async (port: number): Promise<boolean> => {
    if (loopbackBridges.some((bridge) => bridge.port === port)) return true;
    const result = await (dependencies.ensureLoopbackBridge ?? ensureLoopbackBridge)({
      port,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.status === "bridged") {
      loopbackBridges.push(result.bridge);
      bus.emit({
        type: "port.bridge.created",
        source: "port",
        severity: "info",
        message: `Bridged IPv4 localhost to the IPv6 service on port ${String(port)}`,
        correlation: targetCorrelation,
        data: { port, sourceHost: result.bridge.sourceHost, targetHost: result.bridge.targetHost },
      });
      return true;
    }
    if (result.status !== "failed") return true;
    problems.push(
      commandProblem(
        ProblemCode.ReadinessFailed,
        "readiness.host-port",
        `Android cannot reach the IPv6-only localhost service on port ${String(port)}.`,
        `${result.detail} ADB Ready left the service untouched; retry after the port is available or bind the service to IPv4 localhost.`,
        context.commandId,
        [{ source: "loopback.bridge", field: "port", value: port }],
      ),
    );
    return false;
  };
  if (problems.some(({ severity }) => severity === "error")) {
    await cleanup();
    await runHookPhase("finally", {}, false);
    return await complete(failedData());
  }

  bus.emit({
    type: "port.verified",
    source: "port",
    severity: "info",
    message: `${String(normalizedPorts.mappings.length)} reverse mapping(s) ready`,
    correlation: targetCorrelation,
    data: { created: created.length, reused: reused.length },
  });
  const metroPort = metroServicePort(preset, normalizedPorts.mappings);
  if (metroPort !== undefined) {
    const probe = await (dependencies.probeMetroService ?? probeMetroService)({
      host: "localhost",
      port: metroPort,
      expectedProjectRoot: project.root,
      ...(signal === undefined ? {} : { signal }),
    });
    if (probe.status === "available") {
      attachedService = {
        kind: "metro",
        endpoint: probe.endpoint,
        ownership: "external",
      };
      bus.emit({
        type: "service.attached",
        source: "service",
        severity: "info",
        message: `Attached to the existing Metro server at ${probe.endpoint}`,
        correlation: targetCorrelation,
        data: { kind: "metro", endpoint: probe.endpoint, ownership: "external", preset },
      });
    } else if (probe.status === "occupied") {
      problems.push(
        commandProblem(
          ProblemCode.DevelopmentServiceConflict,
          "child.service.conflict",
          `Port ${String(metroPort)} is occupied by a service ADB Ready cannot safely attach to.`,
          `${probe.detail} Stop that service or configure the matching Metro host port before retrying.`,
          context.commandId,
          [{ source: "metro.status", field: "endpoint", value: probe.endpoint }],
        ),
      );
    } else if (probe.status === "aborted") {
      problems.push(
        commandProblem(
          ProblemCode.OperationInterrupted,
          "child.interrupted",
          "The development session was interrupted.",
          "No development command was started.",
          context.commandId,
        ),
      );
    }
  }
  if (problems.some(({ severity }) => severity === "error")) {
    await cleanup();
    await runHookPhase("finally", {}, false);
    const errors = problems.filter(({ severity }) => severity === "error");
    return await complete(
      failedData(
        errors.every(({ code }) => code === ProblemCode.OperationInterrupted)
          ? "interrupted"
          : "failed",
      ),
    );
  }
  transition(
    attachedService === undefined ? "starting-child" : "attaching-child",
    attachedService === undefined
      ? "ports verified and development command prepared"
      : "verified existing Metro server selected without taking ownership",
  );
  if (!(await runHookPhase("onPortsReady"))) {
    await cleanup();
    await runHookPhase("finally", {}, false);
    return await complete(failedData());
  }
  const runner = dependencies.runner ?? runProcess;
  let activeLogController: AbortController | undefined;
  let activeLogPromise: Promise<ProcessResult> | undefined;
  let logStreamFailed = false;
  const logFindings = new Map<string, LogFinding & { evidence: string }>();
  const recentLogLines: string[] = [];
  let applicationLogSelector =
    options.logs === false || options.applicationId === undefined
      ? undefined
      : await resolvePackageLogSelector(healthClient, target, options.applicationId, signal);
  const abortLogs = () => activeLogController?.abort();
  signal?.addEventListener("abort", abortLogs, { once: true });
  const startLogStream = (): void => {
    if (options.logs === false || signal?.aborted === true) return;
    const controller = new AbortController();
    const selector = applicationLogSelector;
    activeLogController = controller;
    logStreamFailed = false;
    const logLines = new TextLineBuffer((raw) => {
      const parsed = parseLogcatThreadtimeLine(raw);
      const safeRaw = redactText(raw).value;
      const safeMessage = parsed === undefined ? safeRaw : redactText(parsed.message).value;
      const attribution: LogAttribution = selector === undefined ? "unattributed" : "application";
      const finding = classifyLogRecord(parsed, safeRaw, attribution);
      recentLogLines.push(safeMessage);
      if (recentLogLines.length > 200) recentLogLines.shift();
      bus.emit({
        type: attribution === "application" ? "log.record" : "log.unattributed",
        source: "logcat",
        severity: attribution === "application" ? streamSeverity(parsed) : "info",
        message: safeMessage,
        correlation: { ...correlation, targetId: selected.target.id },
        data: {
          raw: safeRaw,
          parsed: parsed !== undefined,
          ...(parsed === undefined
            ? {}
            : { tag: parsed.tag, pid: parsed.pid, tid: parsed.tid, priority: parsed.priority }),
          attribution,
          ...(finding === undefined ? {} : { findingCode: finding.code }),
        },
      });
      if (
        finding !== undefined &&
        finding.attribution === "application" &&
        !logFindings.has(finding.code)
      ) {
        logFindings.set(finding.code, { ...finding, evidence: safeMessage });
        bus.emit({
          type: "log.problem",
          source: "logcat",
          severity: "error",
          message: finding.summary,
          correlation: { ...correlation, targetId: selected.target.id },
          data: {
            code: finding.code,
            attribution: finding.attribution,
            detail: finding.detail,
            evidence: safeMessage,
          },
        });
      }
    });
    const selectorArgs =
      target.transportId === undefined ? ["-s", target.serial] : ["-t", target.transportId];
    const promise = runner({
      executable,
      args: [
        ...(config.adbHost === undefined ? [] : ["-H", config.adbHost]),
        ...(config.adbPort === undefined ? [] : ["-P", String(config.adbPort)]),
        ...selectorArgs,
        "logcat",
        "-v",
        "threadtime",
        "-T",
        "1",
        ...(selector?.uid === undefined ? [] : [`--uid=${String(selector.uid)}`]),
        ...(selector?.pid === undefined ? [] : [`--pid=${String(selector.pid)}`]),
        "ReactNativeJS:V",
        "ReactNative:V",
        "AndroidRuntime:E",
        "*:S",
      ],
      signal: controller.signal,
      maxBufferBytes: 256 * 1024,
      onStdoutChunk: (chunk) => logLines.push(chunk),
      onStderrChunk: (chunk) => logLines.push(chunk),
    })
      .then((result) => {
        if (!controller.signal.aborted && activeLogController === controller) {
          logStreamFailed = true;
          bus.emit({
            type: "log.stream.failed",
            source: "logcat",
            severity: "warning",
            message: "The target log stream ended unexpectedly.",
            correlation: { ...correlation, targetId: selected.target.id },
            data: { exitCode: result.exitCode, signal: result.signal },
          });
        }
        return result;
      })
      .finally(() => logLines.flush());
    activeLogPromise = promise;
  };
  const stopLogStream = async (): Promise<void> => {
    const controller = activeLogController;
    const promise = activeLogPromise;
    activeLogController = undefined;
    activeLogPromise = undefined;
    controller?.abort();
    if (promise !== undefined) await promise;
  };
  const scopeLogStream = async (applicationId: string): Promise<void> => {
    if (applicationLogSelector?.packageName === applicationId) return;
    const selector = await resolvePackageLogSelector(healthClient, target, applicationId, signal);
    if (selector === undefined) {
      bus.emit({
        type: "log.scope.unavailable",
        source: "logcat",
        severity: "warning",
        message: "App-scoped diagnostics are not available yet",
        correlation: targetCorrelation,
        data: { applicationId, attribution: "unattributed" },
      });
      return;
    }
    await stopLogStream();
    applicationLogSelector = selector;
    bus.emit({
      type: "log.scope.changed",
      source: "logcat",
      severity: "info",
      message: `Diagnostics are scoped to ${applicationId}`,
      correlation: targetCorrelation,
      data: {
        applicationId,
        attribution: "application",
        selector: selector.uid === undefined ? "pid" : "uid",
      },
    });
    startLogStream();
  };
  startLogStream();
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
  const childController = attachedService === undefined ? new AbortController() : undefined;
  if (signal?.aborted === true) childController?.abort();
  const abortChild = () => childController?.abort();
  signal?.addEventListener("abort", abortChild, { once: true });
  let settledChild: ProcessResult | undefined;
  const childPromise =
    childController === undefined
      ? undefined
      : (() => {
          bus.emit({
            type: "child.started",
            source: "child",
            severity: "info",
            message: `Starting ${preset} development command`,
            correlation: targetCorrelation,
            data: { ...commandData, preset },
          });
          return runner({
            executable: childCommand.executable,
            args: childCommand.args,
            cwd: commandCwd,
            env: { ...childCommand.env, ANDROID_SERIAL: selected.transport.serial },
            signal: childController.signal,
            stdin:
              preset === "expo" && options.onLiveControlsReady !== undefined
                ? "ignore"
                : (options.childStdin ?? "ignore"),
            maxBufferBytes: 4 * 1024 * 1024,
            onStdoutChunk: (chunk) => childStdout.push(chunk),
            onStderrChunk: (chunk) => childStderr.push(chunk),
          }).then((result) => {
            settledChild = result;
            return result;
          });
        })();
  const readinessController = new AbortController();
  if (signal?.aborted === true) readinessController.abort();
  const abortReadiness = () => readinessController.abort();
  signal?.addEventListener("abort", abortReadiness, { once: true });
  bus.emit({
    type: "readiness.started",
    source: "readiness",
    severity: "info",
    message:
      readinessAssertions.length === 0
        ? "No additional readiness checks are configured"
        : `Waiting for ${String(readinessAssertions.length)} configured readiness check(s)`,
    correlation: targetCorrelation,
    data: { count: readinessAssertions.length },
  });
  const readinessPromise = waitForReadiness(
    readinessAssertions,
    createAdbReadinessProbe({
      client: healthClient,
      target,
      targetIdentity: selected.target.id,
      commandId: context.commandId,
      logLines: () => recentLogLines,
      ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
      uiHierarchyLock: {
        ...dependencies.uiHierarchyLock,
        lease: {
          ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
          ...dependencies.uiHierarchyLock?.lease,
        },
      },
    }),
    {
      signal: readinessController.signal,
      ...(options.readiness?.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.readiness.timeoutMs }),
      ...(options.readiness?.pollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: options.readiness.pollIntervalMs }),
      ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
      ...(dependencies.sleep === undefined
        ? {}
        : {
            sleep: async (milliseconds: number, readinessSignal?: AbortSignal) => {
              await dependencies.sleep?.(
                milliseconds,
                readinessSignal ?? readinessController.signal,
              );
            },
          }),
    },
  );
  const readinessRace =
    readinessAssertions.length === 0
      ? ("readiness" as const)
      : await Promise.race([
          readinessPromise.then(() => "readiness" as const),
          ...(childPromise === undefined ? [] : [childPromise.then(() => "child" as const)]),
        ]);
  if (readinessRace === "child") readinessController.abort();
  const readiness = await readinessPromise;
  signal?.removeEventListener("abort", abortReadiness);
  if (!readiness.ready && signal?.aborted !== true) {
    problems.push(readinessProblem(readiness, context.commandId, selected.target.id));
    bus.emit({
      type: "readiness.failed",
      source: "readiness",
      severity: "error",
      message: "Configured readiness checks did not pass",
      correlation: targetCorrelation,
      data: {
        attempts: readiness.attempts,
        timedOut: readiness.timedOut,
        assertions: readiness.assertions.map(({ assertion, status }) => ({
          kind: assertion.kind,
          status,
        })),
      },
    });
  } else if (readiness.ready) {
    bus.emit({
      type: "readiness.passed",
      source: "readiness",
      severity: "info",
      message: "Configured readiness checks passed",
      correlation: targetCorrelation,
      data: { attempts: readiness.attempts, durationMs: readiness.durationMs },
    });
  }
  if (readiness.ready) {
    const hostPorts = [
      ...new Set(
        normalizedPorts.mappings.flatMap(({ host }) => {
          const port = host.match(/^tcp:(\d+)$/u)?.[1];
          return port === undefined ? [] : [Number(port)];
        }),
      ),
    ];
    for (const port of hostPorts) {
      if (!(await ensureBridgeForPort(port))) break;
    }
  }
  if (
    readiness.ready &&
    !problems.some(({ severity }) => severity === "error") &&
    preset === "expo"
  ) {
    const hostPort = metroServicePort(preset, normalizedPorts.mappings);
    const devicePort = expoDevicePort(normalizedPorts.mappings);
    if (hostPort === undefined || devicePort === undefined) {
      problems.push(
        commandProblem(
          ProblemCode.ExpoLaunchFailed,
          "child.expo-launch",
          "The Expo development-server mapping is missing.",
          "Map a device port to the Expo Metro host port with --port, then retry.",
          context.commandId,
        ),
      );
    } else {
      let endpoint = attachedService?.endpoint;
      if (endpoint === undefined) {
        const probe = await (dependencies.probeMetroService ?? probeMetroService)({
          host: "localhost",
          port: hostPort,
          ...(signal === undefined ? {} : { signal }),
        });
        if (probe.status === "available") {
          endpoint = probe.endpoint;
        } else if (probe.status !== "aborted") {
          problems.push(
            commandProblem(
              ProblemCode.ExpoLaunchFailed,
              "child.expo-launch",
              "The started Expo server did not expose a valid Metro endpoint.",
              probe.status === "occupied"
                ? `${probe.detail} Check the configured Expo command and host port.`
                : `No Metro service was reachable on localhost:${String(hostPort)} after readiness passed.`,
              context.commandId,
              [{ source: "metro.status", field: "endpoint", value: probe.endpoint }],
            ),
          );
        }
      }
      if (endpoint === undefined) {
        expoLaunch = undefined;
      } else {
        expoLaunch = await launchExpoOnSelectedTarget({
          client,
          target,
          endpoint,
          devicePort,
          runtime: project.packageJson?.hasExpoDevClient === true ? "custom" : "expo",
          commandId: context.commandId,
          problems,
          dependencies,
          ...(signal === undefined ? {} : { signal }),
        });
        if (expoLaunch !== undefined && attachedService === undefined) {
          expoControlEndpoint = endpoint;
        }
      }
    }
  }
  const diagnosticApplicationId = expoLaunch?.applicationId ?? options.applicationId;
  if (
    readiness.ready &&
    options.logs !== false &&
    signal?.aborted !== true &&
    diagnosticApplicationId !== undefined
  ) {
    await scopeLogStream(diagnosticApplicationId);
  }
  const expoLaunchSucceeded = preset !== "expo" || expoLaunch !== undefined;
  if (
    readiness.ready &&
    expoLaunchSucceeded &&
    childPromise !== undefined &&
    settledChild === undefined
  ) {
    settledChild = await observeChildStartup(childPromise, signal);
  }
  let childFailureRecorded = false;
  if (settledChild !== undefined && !processSucceeded(settledChild) && !settledChild.aborted) {
    problems.push(childProcessFailureProblem(settledChild, context.commandId, true));
    childFailureRecorded = true;
  }
  const readyPreconditionsPassed =
    readiness.ready &&
    expoLaunchSucceeded &&
    (settledChild === undefined || processSucceeded(settledChild));
  const onReadyHooksSucceeded = readyPreconditionsPassed && (await runHookPhase("onReady"));
  await Promise.resolve();
  if (
    !childFailureRecorded &&
    settledChild !== undefined &&
    !processSucceeded(settledChild) &&
    !settledChild.aborted
  ) {
    problems.push(childProcessFailureProblem(settledChild, context.commandId, true));
    childFailureRecorded = true;
  }
  const readyHooksSucceeded =
    onReadyHooksSucceeded && (settledChild === undefined || processSucceeded(settledChild));
  if (!readyHooksSucceeded) childController?.abort();
  let liveControlsBinding: DevLiveControlsBinding | undefined;
  if (
    readyHooksSucceeded &&
    preset === "expo" &&
    attachedService === undefined &&
    expoControlEndpoint !== undefined &&
    options.onLiveControlsReady !== undefined
  ) {
    try {
      const executeControl = async (action: ExpoControlAction, controlSignal?: AbortSignal) => {
        bus.emit({
          type: "dev.control.requested",
          source: "dev.controls",
          severity: "info",
          message: action === "reload" ? "Reloading Expo app" : "Opening Expo developer menu",
          correlation: targetCorrelation,
          data: { action, preset: "expo" },
        });
        const result = await (dependencies.sendExpoControl ?? sendExpoControl)({
          action,
          endpoint: expoControlEndpoint,
          ...(controlSignal === undefined ? {} : { signal: controlSignal }),
        });
        bus.emit({
          type: result.ok ? "dev.control.completed" : "dev.control.failed",
          source: "dev.controls",
          severity: result.ok ? "info" : "warning",
          message: result.detail,
          correlation: targetCorrelation,
          data: { action, connectedClients: result.connectedClients, preset: "expo" },
        });
        return result;
      };
      liveControlsBinding = options.onLiveControlsReady({
        preset: "expo",
        execute: executeControl,
      });
      if (liveControlsBinding !== undefined) {
        bus.emit({
          type: "dev.controls.available",
          source: "dev.controls",
          severity: "info",
          message: "Interactive Expo controls are active",
          correlation: targetCorrelation,
          data: { actions: ["reload", "dev-menu", "help", "stop"], preset: "expo" },
        });
      }
    } catch {
      bus.emit({
        type: "dev.controls.unavailable",
        source: "dev.controls",
        severity: "warning",
        message: "Interactive Expo controls could not be activated; the session is still ready",
        correlation: targetCorrelation,
        data: { preset: "expo" },
      });
    }
  }
  if (readyHooksSucceeded) {
    transition(
      "ready",
      attachedService === undefined
        ? "target, ports, logs, and child are ready"
        : "target, ports, logs, and attached Metro server are ready",
    );
  }

  const watchController = new AbortController();
  if (signal?.aborted === true || !readyHooksSucceeded) watchController.abort();
  const abortWatcher = () => watchController.abort();
  signal?.addEventListener("abort", abortWatcher, { once: true });
  const observeSession = async (watchSignal: AbortSignal): Promise<SessionHealth> => {
    const state = await healthClient.getState(target.serial, watchSignal);
    if (!processSucceeded(state.process) || state.value !== "device") {
      return {
        targetReady: false,
        logReady: options.logs === false || !logStreamFailed,
        targetSerial: target.serial,
        missingPorts: [...normalizedPorts.mappings],
        conflictingPorts: [],
        detail: `Target ${target.serial} is not ready.`,
      };
    }
    const mappings = await healthClient.listPortMappings(target, "reverse", watchSignal);
    if (!processSucceeded(mappings.process)) {
      return {
        targetReady: true,
        logReady: options.logs === false || !logStreamFailed,
        targetSerial: target.serial,
        missingPorts: [...normalizedPorts.mappings],
        conflictingPorts: [],
        detail: "Reverse mappings could not be inspected.",
      };
    }
    const current = mappings.value.map((mapping) => normalizePortMapping("reverse", mapping));
    const conflictingPorts = normalizedPorts.mappings.filter((requested) =>
      current.some(
        (mapping) => mapping.device === requested.device && mapping.host !== requested.host,
      ),
    );
    const missingPorts = normalizedPorts.mappings.filter(
      (requested) =>
        !current.some(
          (mapping) => mapping.device === requested.device && mapping.host === requested.host,
        ),
    );
    const attachedProbe =
      attachedService === undefined
        ? undefined
        : await (dependencies.probeMetroService ?? probeMetroService)({
            host: "localhost",
            port: Number(new URL(attachedService.endpoint).port),
            expectedProjectRoot: project.root,
            signal: watchSignal,
          });
    const serviceReady = attachedProbe === undefined || attachedProbe.status === "available";
    return {
      targetReady: true,
      logReady: options.logs === false || !logStreamFailed,
      ...(attachedService === undefined ? {} : { serviceReady }),
      targetSerial: target.serial,
      missingPorts,
      conflictingPorts,
      ...(conflictingPorts.length > 0
        ? { detail: "A required device port is owned by another mapping." }
        : !serviceReady
          ? { detail: "The externally owned Metro server is no longer available." }
          : logStreamFailed
            ? { detail: "The target log stream stopped unexpectedly." }
            : {}),
    };
  };
  const recoverSession = async (
    health: SessionHealth,
    _attempt: number,
    watchSignal: AbortSignal,
  ): Promise<{ changedTarget: boolean; detail?: string }> => {
    const previousSerial = target.serial;
    if (!health.targetReady) {
      const visible = await discoveryClient.devices(watchSignal);
      if (!processSucceeded(visible.process)) {
        return { changedTarget: false, detail: "ADB target inventory is unavailable." };
      }
      const refreshed = await inspectTargets(
        discoveryClient,
        visible.value,
        context.commandId,
        watchSignal,
      );
      const remembered = selectTarget(refreshed.targets, {
        rememberedSerial: previousSerial,
        ...(selected.target.hardwareSerial === undefined
          ? {}
          : { rememberedHardwareSerial: selected.target.hardwareSerial }),
        rememberedOnly: true,
      });
      if (remembered.kind === "selected") {
        selected = remembered.selection;
        target = targetForAdb(selected);
        recorder?.addPrivateLiteral(selected.transport.serial);
        recorder?.addPrivateLiteral(selected.target.hardwareSerial);
        recorder?.addPrivateLiteral(selected.target.id);
      } else {
        const acquisition = planTargetAcquisition({
          remembered: {
            serial: previousSerial,
            ...(selected.target.hardwareSerial === undefined
              ? {}
              : { hardwareSerial: selected.target.hardwareSerial }),
          },
          services: refreshed.discovery.mdns.services,
        });
        if (acquisition.kind !== "connect") {
          return {
            changedTarget: false,
            detail:
              acquisition.kind === "ambiguous"
                ? "More than one wireless endpoint matches the recovery request."
                : "No safe endpoint is available for recovery.",
          };
        }
        const safeCandidates = acquisition.candidates.filter(
          (candidate) =>
            candidate === previousSerial || selected.target.hardwareSerial !== undefined,
        );
        let recoveredSelection: SelectedTarget | undefined;
        for (const endpoint of safeCandidates) {
          recorder?.addPrivateLiteral(endpoint);
          const connected = await discoveryClient.connect(endpoint, watchSignal);
          if (
            !processSucceeded(connected.process) ||
            (connected.value.status !== "connected" &&
              connected.value.status !== "already-connected")
          ) {
            continue;
          }
          const verified = await discoveryClient.getState(endpoint, watchSignal);
          if (!processSucceeded(verified.process) || verified.value !== "device") continue;
          const hardware = await discoveryClient.getHardwareSerial(endpoint, watchSignal);
          const hardwareSerial = processSucceeded(hardware.process)
            ? normalizedHardwareSerial(hardware.value)
            : undefined;
          if (
            selected.target.hardwareSerial !== undefined &&
            hardwareSerial !== selected.target.hardwareSerial
          ) {
            continue;
          }
          const afterConnect = await discoveryClient.devices(watchSignal);
          if (!processSucceeded(afterConnect.process)) continue;
          const afterInspection = await inspectTargets(
            discoveryClient,
            afterConnect.value,
            context.commandId,
            watchSignal,
          );
          const result = selectTarget(afterInspection.targets, {
            rememberedSerial: endpoint,
            ...(selected.target.hardwareSerial === undefined
              ? {}
              : { rememberedHardwareSerial: selected.target.hardwareSerial }),
            rememberedOnly: true,
          });
          if (result.kind === "selected") {
            recoveredSelection = result.selection;
            break;
          }
        }
        if (recoveredSelection === undefined) {
          return { changedTarget: false, detail: "The selected target could not be reconnected." };
        }
        selected = recoveredSelection;
        target = targetForAdb(selected);
        recorder?.addPrivateLiteral(selected.transport.serial);
        recorder?.addPrivateLiteral(selected.target.hardwareSerial);
        recorder?.addPrivateLiteral(selected.target.id);
      }
    }

    const listedAfterRecovery = await client.listPortMappings(target, "reverse", watchSignal);
    if (!processSucceeded(listedAfterRecovery.process)) {
      return { changedTarget: target.serial !== previousSerial, detail: "Ports are unavailable." };
    }
    const currentMappings = listedAfterRecovery.value.map((mapping) =>
      normalizePortMapping("reverse", mapping),
    );
    for (const mapping of normalizedPorts.mappings) {
      const occupying = currentMappings.find((item) => item.device === mapping.device);
      if (occupying !== undefined && occupying.host !== mapping.host) {
        return {
          changedTarget: target.serial !== previousSerial,
          detail: `Recovery refused to replace ${mapping.device}.`,
        };
      }
      if (occupying !== undefined) continue;
      const added = await client.addPortMapping(
        target,
        "reverse",
        mapping.device,
        mapping.host,
        watchSignal,
      );
      if (!processSucceeded(added.process)) {
        return {
          changedTarget: target.serial !== previousSerial,
          detail: `Recovery could not restore ${mapping.device}.`,
        };
      }
      if (!created.some((item) => item.device === mapping.device && item.host === mapping.host)) {
        created.push(mapping);
      }
    }
    if (target.serial !== previousSerial || health.logReady === false) {
      await stopLogStream();
      startLogStream();
    }
    if (health.serviceReady === false) {
      return {
        changedTarget: target.serial !== previousSerial,
        detail: "Waiting for the external Metro owner to restore the server.",
      };
    }
    return {
      changedTarget: target.serial !== previousSerial,
      detail:
        target.serial === previousSerial
          ? "Session resources restored."
          : `Target transport changed to ${target.serial}.`,
    };
  };
  const watchPromise =
    options.watch === false || !readyHooksSucceeded
      ? Promise.resolve(recoverySummary)
      : watchSession({
          signal: watchController.signal,
          observe: observeSession,
          recover: recoverSession,
          ...(options.watchIntervalMs === undefined ? {} : { intervalMs: options.watchIntervalMs }),
          ...(options.recovery === undefined ? {} : { policy: options.recovery }),
          ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
          onEvent: (event) => {
            if (event.type === "session.degraded") {
              transition("degraded", event.detail ?? "session health degraded");
            } else if (event.type === "recovery.started") {
              transition("recovering", `bounded recovery attempt ${String(event.attempt ?? 1)}`);
            } else if (event.type === "recovery.completed") {
              transition("ready", event.detail ?? "recovery independently verified");
            } else if (event.type === "recovery.failed") {
              transition("degraded", event.detail ?? "recovery verification failed");
            } else if (event.type === "watch.failed") {
              transition("failed", event.detail ?? "session watcher failed");
            }
            bus.emit({
              type: event.type,
              source: "recovery",
              severity:
                event.type === "watch.failed" || event.type === "recovery.failed"
                  ? "error"
                  : event.type === "session.degraded"
                    ? "warning"
                    : "info",
              message: event.detail ?? event.type,
              correlation: { ...correlation, targetId: selected.target.id },
              data: {
                ...(event.type === "health.checked"
                  ? { presentation: "background", retention: "transient" }
                  : {}),
                ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
                ...(event.health === undefined
                  ? {}
                  : {
                      health: {
                        targetReady: event.health.targetReady,
                        ...(event.health.logReady === undefined
                          ? {}
                          : { logReady: event.health.logReady }),
                        ...(event.health.serviceReady === undefined
                          ? {}
                          : { serviceReady: event.health.serviceReady }),
                        targetSerial: event.health.targetSerial,
                        missingPorts: event.health.missingPorts.map(({ device, host }) => ({
                          device,
                          host,
                        })),
                        conflictingPorts: event.health.conflictingPorts.map(({ device, host }) => ({
                          device,
                          host,
                        })),
                        ...(event.health.detail === undefined
                          ? {}
                          : { detail: event.health.detail }),
                      },
                    }),
              },
            });
          },
        });
  const verificationController = new AbortController();
  if (signal?.aborted === true || !readyHooksSucceeded) verificationController.abort();
  const abortVerification = () => verificationController.abort();
  signal?.addEventListener("abort", abortVerification, { once: true });
  const verificationCommand =
    options.verification === undefined
      ? undefined
      : bindTargetSerial(options.verification.command, selected.transport.serial);
  const verificationCommandData =
    verificationCommand === undefined
      ? undefined
      : {
          executable: redactedPath(verificationCommand.executable),
          args: verificationCommand.args.map((argument) => redactText(argument).value),
          cwd: redactedPath(path.resolve(project.root, verificationCommand.cwd ?? ".")),
          envKeys: ["ADB_READY_TARGET_SERIAL", "ANDROID_SERIAL"],
        };
  const verificationLines = (stream: "stderr" | "stdout") =>
    new TextLineBuffer((line) => {
      const safe = redactText(line).value;
      bus.emit({
        type: `verification.${stream}`,
        source: `verification.${stream}`,
        severity: stream === "stderr" ? "warning" : "info",
        message: safe,
        correlation: targetCorrelation,
        data: { raw: safe },
      });
      options.onChildLine?.(stream, safe);
    });
  const verificationStdout = verificationLines("stdout");
  const verificationStderr = verificationLines("stderr");
  const verificationPromise =
    verificationCommand === undefined || !readyHooksSucceeded
      ? undefined
      : (() => {
          bus.emit({
            type: "verification.started",
            source: "verification",
            severity: "info",
            message: "Starting bounded verification command",
            correlation: targetCorrelation,
            data: verificationCommandData ?? {},
          });
          return runner({
            executable: verificationCommand.executable,
            args: verificationCommand.args,
            cwd: path.resolve(project.root, verificationCommand.cwd ?? "."),
            env: {
              ...verificationCommand.env,
              ADB_READY_TARGET_SERIAL: selected.transport.serial,
              ANDROID_SERIAL: selected.transport.serial,
            },
            signal: verificationController.signal,
            stdin: "ignore",
            ...(options.verification?.timeoutMs === undefined
              ? {}
              : { timeoutMs: options.verification.timeoutMs }),
            maxBufferBytes: 4 * 1024 * 1024,
            onStdoutChunk: (chunk) => verificationStdout.push(chunk),
            onStderrChunk: (chunk) => verificationStderr.push(chunk),
          });
        })();
  let resolveSessionAbort: (() => void) | undefined;
  const sessionAbortPromise = new Promise<"signal">((resolve) => {
    resolveSessionAbort = () => resolve("signal");
  });
  const notifySessionAbort = () => resolveSessionAbort?.();
  if (signal?.aborted === true) notifySessionAbort();
  else signal?.addEventListener("abort", notifySessionAbort, { once: true });
  const watchFailurePromise = watchPromise.then(async (summary) => {
    if (summary.failed) return "watch-failed" as const;
    return await new Promise<never>(() => undefined);
  });
  const firstCompletion = await Promise.race([
    ...(childPromise === undefined ? [] : [childPromise.then(() => "child" as const)]),
    watchFailurePromise,
    ...(verificationPromise === undefined
      ? []
      : [verificationPromise.then(() => "verification" as const)]),
    ...(liveControlsBinding === undefined
      ? []
      : [liveControlsBinding.stopRequested.then(() => "controls-stop" as const)]),
    sessionAbortPromise,
  ]);
  liveControlsBinding?.dispose();
  signal?.removeEventListener("abort", notifySessionAbort);
  watchController.abort();
  recoverySummary = await watchPromise;
  signal?.removeEventListener("abort", abortWatcher);
  if (
    firstCompletion === "watch-failed" ||
    firstCompletion === "signal" ||
    firstCompletion === "controls-stop"
  ) {
    childController?.abort();
    verificationController.abort();
  } else if (firstCompletion === "child") {
    verificationController.abort();
  } else if (firstCompletion === "verification") {
    childController?.abort();
  }
  const verificationProcess = await verificationPromise;
  if (verificationProcess !== undefined) childController?.abort();
  verificationStdout.flush();
  verificationStderr.flush();
  signal?.removeEventListener("abort", abortVerification);
  const verification: DevData["verification"] =
    verificationProcess === undefined || verificationCommandData === undefined
      ? undefined
      : {
          command: verificationCommandData,
          passed: processSucceeded(verificationProcess),
          exitCode: verificationProcess.exitCode,
          signal: verificationProcess.signal,
          durationMs: verificationProcess.durationMs,
          timedOut: verificationProcess.timedOut,
          stdoutTruncated: verificationProcess.stdoutTruncated,
          stderrTruncated: verificationProcess.stderrTruncated,
          stdout: redactText(verificationProcess.stdout).value,
          stderr: redactText(verificationProcess.stderr).value,
        };
  if (verification !== undefined) {
    bus.emit({
      type: "verification.completed",
      source: "verification",
      severity: verification.passed ? "info" : "error",
      message: verification.passed ? "Verification command passed" : "Verification command failed",
      correlation: targetCorrelation,
      data: {
        passed: verification.passed,
        exitCode: verification.exitCode,
        signal: verification.signal,
        timedOut: verification.timedOut,
        durationMs: verification.durationMs,
      },
    });
  }
  const child = await childPromise;
  signal?.removeEventListener("abort", abortChild);
  childStdout.flush();
  childStderr.flush();
  await stopLogStream();
  signal?.removeEventListener("abort", abortLogs);
  if (child !== undefined) {
    bus.emit({
      type: "child.exited",
      source: "child",
      severity: child.exitCode === 0 ? "info" : "error",
      message: `Development command exited ${child.exitCode === null ? `by ${String(child.signal)}` : `with ${String(child.exitCode)}`}`,
      correlation: targetCorrelation,
      data: { exitCode: child.exitCode, signal: child.signal, durationMs: child.durationMs },
    });
    await runHookPhase(
      "onChildExit",
      {
        ADB_READY_CHILD_EXIT_CODE: child.exitCode === null ? "" : String(child.exitCode),
        ADB_READY_CHILD_SIGNAL: child.signal ?? "",
      },
      false,
    );
  }
  await cleanup();
  if (recoverySummary.failed) {
    problems.push(
      commandProblem(
        ProblemCode.SessionRecoveryFailed,
        "session.recovery",
        "The development session could not be recovered safely.",
        attachedService === undefined
          ? "ADB Ready exhausted the bounded recovery budget and stopped its child process."
          : "ADB Ready exhausted the bounded recovery budget and stopped its session; the external Metro server was left untouched.",
        context.commandId,
        [
          {
            source: "session.watcher",
            field: "recoveryAttempts",
            value: recoverySummary.recoveryAttempts,
          },
          {
            source: "session.watcher",
            field: "lastHealth",
            value:
              recoverySummary.lastHealth === undefined
                ? null
                : {
                    targetReady: recoverySummary.lastHealth.targetReady,
                    targetSerial: recoverySummary.lastHealth.targetSerial,
                    missingPorts: recoverySummary.lastHealth.missingPorts.map(
                      ({ device, host }) => ({
                        device,
                        host,
                      }),
                    ),
                    conflictingPorts: recoverySummary.lastHealth.conflictingPorts.map(
                      ({ device, host }) => ({ device, host }),
                    ),
                    ...(recoverySummary.lastHealth.detail === undefined
                      ? {}
                      : { detail: recoverySummary.lastHealth.detail }),
                  },
          },
        ],
      ),
    );
  }
  for (const finding of logFindings.values()) {
    problems.push({
      code: finding.code,
      category: "app.runtime",
      severity: "warning",
      summary: finding.summary,
      detail: finding.detail,
      retryable: true,
      evidence: [{ source: "logcat", field: "message", value: finding.evidence }],
      actions: [
        {
          id: "export_session_context",
          title: `Export this session with adb-ready context ${sessionId}`,
          kind: "command",
          risk: "read-only",
          automatic: false,
          idempotent: true,
          command: { executable: "adb-ready", args: ["context", sessionId] },
        },
      ],
      correlation: { ...correlation, targetId: selected.target.id },
    });
  }
  if (
    (signal?.aborted === true || firstCompletion === "controls-stop") &&
    !problems.some(({ code }) => code === ProblemCode.OperationInterrupted)
  ) {
    problems.push(
      commandProblem(
        ProblemCode.OperationInterrupted,
        "child.interrupted",
        "The development session was interrupted.",
        attachedService === undefined
          ? "The owned child process and session-owned port mappings were stopped safely."
          : "Session-owned resources were stopped safely; the external Metro server remains running.",
        context.commandId,
      ),
    );
  } else if (
    child !== undefined &&
    !processSucceeded(child) &&
    !child.aborted &&
    !childFailureRecorded &&
    !recoverySummary.failed
  ) {
    problems.push(childProcessFailureProblem(child, context.commandId, !reachedReady));
  }
  if (verification !== undefined && !verification.passed && signal?.aborted !== true) {
    problems.push(
      commandProblem(
        ProblemCode.VerificationFailed,
        "verification.exit",
        verification.timedOut
          ? "The verification command exceeded its timeout."
          : "The verification command failed.",
        `The command exited with ${verification.exitCode === null ? String(verification.signal) : String(verification.exitCode)}.`,
        context.commandId,
        [
          { source: "verification", field: "exitCode", value: verification.exitCode },
          { source: "verification", field: "signal", value: verification.signal },
          { source: "verification", field: "timedOut", value: verification.timedOut },
        ],
      ),
    );
  }
  await runHookPhase("finally", {}, false);
  const execution = await complete({
    ...baseData(),
    status: problems.some(
      ({ code, severity }) => severity === "error" && code !== ProblemCode.OperationInterrupted,
    )
      ? "failed"
      : problems.some(({ code }) => code === ProblemCode.OperationInterrupted)
        ? "interrupted"
        : "completed",
    ports: {
      requested: normalizedPorts.mappings,
      created,
      reused,
      cleaned,
    },
    ...(child === undefined
      ? {}
      : {
          child: {
            exitCode: child.exitCode,
            signal: child.signal,
            durationMs: child.durationMs,
            stdoutTruncated: child.stdoutTruncated,
            stderrTruncated: child.stderrTruncated,
          },
        }),
    hooks: hookSummary(),
    recovery: recoverySummary,
    reachedReady,
    readiness,
    ...(verification === undefined ? {} : { verification }),
  });
  if (child !== undefined && problems.some(({ code }) => code === ProblemCode.ChildProcessFailed)) {
    execution.exitCode = preservedChildExitCode(child) ?? execution.exitCode;
  }
  if (verificationProcess !== undefined && !processSucceeded(verificationProcess)) {
    execution.exitCode = preservedChildExitCode(verificationProcess) ?? execution.exitCode;
  }
  return execution;
}
