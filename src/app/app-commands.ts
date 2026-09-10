import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { AdbClient, type AdbObservation, type AdbTargetSelector } from "../adb/client.js";
import type { AndroidPackage } from "../adb/parsers.js";
import { EventBus } from "../core/event-bus.js";
import { redactText } from "../core/redaction.js";
import { detectProject } from "../dev/project.js";
import {
  ExitCode,
  type OperationPlan,
  type Problem,
  type ResultEnvelope,
  SCHEMA_VERSION,
} from "../domain/contracts.js";
import {
  adbNotFoundProblem,
  adbProcessProblem,
  targetSelectionProblem,
} from "../domain/problems.js";
import { locateAdb } from "../platform/executable.js";
import type { ProcessResult } from "../platform/process-runner.js";
import { selectTarget } from "../target/selection.js";
import {
  type AndroidPackageInfo,
  type ForegroundActivity,
  parseForegroundActivity,
  parsePackageInfo,
  parsePackageList,
  parseResolvedActivity,
} from "./android-app.js";
import { type ApplicationIdResolution, resolveApplicationId } from "./application-id.js";
import {
  type CommandConfig,
  type CommandDependencies,
  type CommandExecution,
  runDevices,
} from "./commands.js";

export type AppAction =
  | "clear-data"
  | "info"
  | "install"
  | "launch"
  | "resolve"
  | "restart"
  | "stop"
  | "uninstall";
export type PackageScope = "all" | "system" | "user";

export interface AppCommandRequest {
  action: AppAction;
  cwd: string;
  applicationId?: string;
  configuredPackage?: { value: string; location?: string };
  artifactPath?: string;
  activity?: string;
  replace?: boolean;
  grantRuntimePermissions?: boolean;
  destructiveApproved?: boolean;
}

export interface AppsData {
  adbPath: string;
  selected: import("../target/selection.js").SelectedTarget;
  scope: PackageScope;
  packages: AndroidPackage[];
  truncated: boolean;
  filter?: string;
}

export interface AppResolutionData {
  action: "resolve";
  selected?: import("../target/selection.js").SelectedTarget;
  resolution: ApplicationIdResolution;
}

export interface AppInfoData {
  action: "info";
  selected: import("../target/selection.js").SelectedTarget;
  resolution: Extract<ApplicationIdResolution, { kind: "resolved" }>;
  package: AndroidPackageInfo;
  foreground?: ForegroundActivity;
}

export interface AppMutationData {
  action: Exclude<AppAction, "info" | "resolve">;
  selected: import("../target/selection.js").SelectedTarget;
  applicationId: string;
  activity?: string;
  artifactPath?: string;
  verified: boolean;
  status:
    | "cleared"
    | "installed"
    | "launched"
    | "planned"
    | "restarted"
    | "stopped"
    | "uninstalled"
    | "unverified";
  plan?: OperationPlan;
}

export type AppData = AppInfoData | AppMutationData | AppResolutionData;

export interface Context {
  bus: EventBus;
  clock: () => Date;
  command: string;
  commandId: string;
  started: Date;
}

export interface ReadyTarget {
  executable: string;
  adbPath: string;
  client: AdbClient;
  selected: import("../target/selection.js").SelectedTarget;
  target: AdbTargetSelector;
}

function plannedArgs(ready: ReadyTarget, config: CommandConfig, args: readonly string[]): string[] {
  return [
    ...(config.adbHost === undefined ? [] : ["-H", config.adbHost]),
    ...(config.adbPort === undefined ? [] : ["-P", String(config.adbPort)]),
    ...(ready.target.transportId === undefined
      ? ["-s", ready.target.serial]
      : ["-t", ready.target.transportId]),
    ...args,
  ].map((argument) => redactText(argument).value);
}

function planStep(
  ready: ReadyTarget,
  config: CommandConfig,
  step: Omit<OperationPlan["steps"][number], "args" | "executable"> & { args: string[] },
): OperationPlan["steps"][number] {
  return {
    ...step,
    executable: ready.adbPath,
    args: plannedArgs(ready, config, step.args),
  };
}

function mutationPlanData(
  action: AppMutationData["action"],
  ready: ReadyTarget,
  applicationId: string,
  steps: OperationPlan["steps"],
  extras: Pick<AppMutationData, "activity" | "artifactPath"> = {},
): AppMutationData {
  return {
    action,
    selected: ready.selected,
    applicationId,
    ...extras,
    verified: false,
    status: "planned",
    plan: { schemaVersion: SCHEMA_VERSION, dryRun: true, steps },
  };
}

export function context(command: string, dependencies: CommandDependencies): Context {
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

function exitCode(problems: readonly Problem[]): ExitCode {
  const errors = problems.filter(({ severity }) => severity === "error");
  if (errors.length === 0) return ExitCode.Success;
  if (errors.some(({ category }) => category.startsWith("input."))) return ExitCode.InvalidInput;
  if (errors.some(({ category }) => category.startsWith("environment.")))
    return ExitCode.Environment;
  if (errors.some(({ category }) => category.startsWith("target."))) return ExitCode.Target;
  return ExitCode.AdbOperation;
}

export function finish<T>(
  current: Context,
  data: T | null,
  problems: Problem[],
): CommandExecution<T> {
  const finished = current.clock();
  const code = exitCode(problems);
  const result: ResultEnvelope<T> = {
    schemaVersion: SCHEMA_VERSION,
    command: current.command,
    commandId: current.commandId,
    ok: code === ExitCode.Success,
    startedAt: current.started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: Math.max(0, finished.getTime() - current.started.getTime()),
    data,
    problems,
  };
  current.bus.emit({
    type: result.ok ? "command.completed" : "command.failed",
    source: `command.${current.command}`,
    severity: result.ok ? "info" : "error",
    message: result.ok ? `${current.command} completed` : `${current.command} failed`,
    correlation: { commandId: current.commandId },
    data: { exitCode: code, problemCount: problems.length },
  });
  return { result, exitCode: code };
}

export function problem(
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

export function succeeded(result: ProcessResult, accepted: readonly number[] = []): boolean {
  return (
    result.spawnError === undefined &&
    result.streamError === undefined &&
    !result.aborted &&
    !result.timedOut &&
    (result.exitCode === 0 || (result.exitCode !== null && accepted.includes(result.exitCode)))
  );
}

export function operationProblem(
  name: string,
  observation: { operationId: string; process: ProcessResult },
  commandId: string,
): Problem {
  return adbProcessProblem(name, observation.process, {
    commandId,
    operationId: observation.operationId,
  });
}

export async function readyTarget(
  current: Context,
  config: CommandConfig,
  dependencies: CommandDependencies,
  problems: Problem[],
  signal?: AbortSignal,
): Promise<ReadyTarget | undefined> {
  const inventory = await runDevices(config, { ...dependencies, bus: current.bus }, signal);
  if (inventory.result.data === null) {
    problems.push(...inventory.result.problems);
    return undefined;
  }
  problems.push(...inventory.result.problems.filter(({ severity }) => severity !== "error"));
  const selection =
    inventory.result.data.selected === undefined
      ? selectTarget(inventory.result.data.targets, {
          ...(config.targetSelector === undefined ? {} : { selector: config.targetSelector }),
          ...(config.targetTransportId === undefined
            ? {}
            : { transportId: config.targetTransportId }),
          ...(config.targetAliases === undefined ? {} : { aliases: config.targetAliases }),
          ...(config.rememberedSerial === undefined
            ? {}
            : { rememberedSerial: config.rememberedSerial }),
          ...(config.rememberedHardwareSerial === undefined
            ? {}
            : { rememberedHardwareSerial: config.rememberedHardwareSerial }),
          ...(config.rememberedOnly === undefined ? {} : { rememberedOnly: config.rememberedOnly }),
        })
      : { kind: "selected" as const, selection: inventory.result.data.selected };
  if (selection.kind !== "selected") {
    problems.push(targetSelectionProblem(selection, { commandId: current.commandId }));
    return undefined;
  }
  const executable = await (dependencies.locateAdb ?? locateAdb)({
    ...(config.adbPath === undefined ? {} : { explicitPath: config.adbPath }),
  });
  if (executable === undefined) {
    problems.push(adbNotFoundProblem({ commandId: current.commandId }, config.adbPath));
    return undefined;
  }
  const selected = selection.selection;
  const target: AdbTargetSelector = {
    serial: selected.transport.serial,
    ...(selected.transport.transportId === undefined
      ? {}
      : { transportId: selected.transport.transportId }),
  };
  return {
    executable,
    adbPath: redactText(executable).value,
    selected,
    target,
    client: new AdbClient({
      executable,
      bus: current.bus,
      correlation: { commandId: current.commandId, targetId: selected.target.id },
      ...(config.adbHost === undefined ? {} : { host: config.adbHost }),
      ...(config.adbPort === undefined ? {} : { port: config.adbPort }),
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      ...(dependencies.runner === undefined ? {} : { runner: dependencies.runner }),
      ...(dependencies.idFactory === undefined ? {} : { idFactory: dependencies.idFactory }),
    }),
  };
}

async function packages(
  ready: ReadyTarget,
  scope: PackageScope,
  signal?: AbortSignal,
): Promise<AdbObservation<AndroidPackage[]>> {
  const scopeArgs = scope === "user" ? ["-3"] : scope === "system" ? ["-s"] : [];
  return await ready.client.targetCommand(
    ready.target,
    "packages-list",
    `Listing ${scope} Android packages`,
    ["shell", "cmd", "package", "list", "packages", "-f", ...scopeArgs],
    parsePackageList,
    signal,
  );
}

async function applicationResolution(
  request: AppCommandRequest,
  ready: ReadyTarget,
  dependencies: CommandDependencies,
  signal?: AbortSignal,
): Promise<{
  resolution: ApplicationIdResolution;
  packageObservation: Awaited<ReturnType<typeof packages>>;
}> {
  const packageObservation = await packages(ready, "user", signal);
  const installed = succeeded(packageObservation.process)
    ? (packageObservation.value as AndroidPackage[]).map(({ name }) => name)
    : [];
  const project = await (dependencies.detectProject ?? detectProject)({
    cwd: request.cwd,
  });
  return {
    packageObservation,
    resolution: await resolveApplicationId({
      root: project.root,
      ...(request.applicationId === undefined ? {} : { explicit: request.applicationId }),
      ...(request.configuredPackage === undefined ? {} : { configured: request.configuredPackage }),
      installed,
    }),
  };
}

function resolutionProblem(resolution: ApplicationIdResolution, commandId: string): Problem {
  if (resolution.kind === "ambiguous") {
    return problem(
      "APP_ID_AMBIGUOUS",
      "input.app.identity",
      "More than one Android application ID is equally valid.",
      "Use APP_ID, --package, or app.android.package in adb-ready.config.json.",
      commandId,
      [
        {
          source: "app-resolver",
          field: "candidates",
          value: resolution.candidates.map(({ value }) => value),
        },
      ],
    );
  }
  return problem(
    "APP_ID_NOT_FOUND",
    "input.app.identity",
    "The Android application ID could not be resolved.",
    "Pass APP_ID or set app.android.package in adb-ready.config.json.",
    commandId,
  );
}

async function requireApplicationId(
  request: AppCommandRequest,
  ready: ReadyTarget,
  dependencies: CommandDependencies,
  problems: Problem[],
  commandId: string,
  signal?: AbortSignal,
): Promise<Extract<ApplicationIdResolution, { kind: "resolved" }> | undefined> {
  const { resolution, packageObservation } = await applicationResolution(
    request,
    ready,
    dependencies,
    signal,
  );
  if (!succeeded(packageObservation.process)) {
    problems.push(operationProblem("packages-list", packageObservation, commandId));
    return undefined;
  }
  if (resolution.kind !== "resolved") {
    problems.push(resolutionProblem(resolution, commandId));
    return undefined;
  }
  return resolution;
}

export async function runApps(
  scope: PackageScope,
  filter: string | undefined,
  config: CommandConfig = {},
  dependencies: CommandDependencies = {},
  signal?: AbortSignal,
): Promise<CommandExecution<AppsData>> {
  const current = context("apps list", dependencies);
  const problems: Problem[] = [];
  const ready = await readyTarget(current, config, dependencies, problems, signal);
  if (ready === undefined) return finish<AppsData>(current, null, problems);
  const listed = await packages(ready, scope, signal);
  if (!succeeded(listed.process)) {
    problems.push(operationProblem("packages-list", listed, current.commandId));
    return finish<AppsData>(current, null, problems);
  }
  const maximum = 2_000;
  const query = filter?.trim().toLowerCase();
  const values = (listed.value as AndroidPackage[]).filter(
    ({ name }) => query === undefined || query === "" || name.toLowerCase().includes(query),
  );
  return finish(
    current,
    {
      adbPath: ready.adbPath,
      selected: ready.selected,
      scope,
      packages: values.slice(0, maximum),
      truncated: values.length > maximum,
      ...(query === undefined || query === "" ? {} : { filter: query }),
    },
    problems,
  );
}

async function inspectPackage(ready: ReadyTarget, applicationId: string, signal?: AbortSignal) {
  return await ready.client.targetCommand(
    ready.target,
    "package-info",
    `Inspecting ${applicationId}`,
    ["shell", "dumpsys", "package", applicationId],
    (output) => parsePackageInfo(applicationId, output),
    signal,
  );
}

async function foreground(ready: ReadyTarget, signal?: AbortSignal) {
  return await ready.client.targetCommand(
    ready.target,
    "foreground-app",
    "Reading the foreground Android app",
    ["shell", "dumpsys", "activity", "activities"],
    parseForegroundActivity,
    signal,
  );
}

async function stopApp(
  ready: ReadyTarget,
  applicationId: string,
  commandId: string,
  problems: Problem[],
  signal?: AbortSignal,
): Promise<boolean> {
  const stopped = await ready.client.targetCommand(
    ready.target,
    "app-stop",
    `Stopping ${applicationId}`,
    ["shell", "am", "force-stop", applicationId],
    () => undefined,
    signal,
  );
  if (!succeeded(stopped.process)) {
    problems.push(operationProblem("app-stop", stopped, commandId));
    return false;
  }
  const pid = await ready.client.targetCommand(
    ready.target,
    "app-stop-verify",
    `Verifying ${applicationId} stopped`,
    ["shell", "pidof", "-s", applicationId],
    (output) => output.trim(),
    signal,
    { acceptExitCodes: [1] },
  );
  if (!succeeded(pid.process, [1]) || pid.value !== "") {
    problems.push(
      problem(
        "APP_STOP_UNVERIFIED",
        "app.lifecycle",
        `${applicationId} is still running after force-stop.`,
        "ADB Ready did not report the stop as successful because its postcondition failed.",
        commandId,
      ),
    );
    return false;
  }
  return true;
}

async function launchApp(
  ready: ReadyTarget,
  applicationId: string,
  explicitActivity: string | undefined,
  commandId: string,
  problems: Problem[],
  dependencies: CommandDependencies,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let activity = explicitActivity;
  if (activity === undefined) {
    const resolved = await ready.client.targetCommand(
      ready.target,
      "app-activity-resolve",
      `Resolving launch activity for ${applicationId}`,
      ["shell", "cmd", "package", "resolve-activity", "--brief", applicationId],
      parseResolvedActivity,
      signal,
    );
    if (!succeeded(resolved.process) || resolved.value === undefined) {
      problems.push(
        problem(
          "APP_ACTIVITY_NOT_FOUND",
          "app.lifecycle",
          `No launchable activity was found for ${applicationId}.`,
          "Pass --activity with an explicit Android component activity.",
          commandId,
        ),
      );
      return undefined;
    }
    activity = resolved.value.activity;
  }
  const component = activity.includes("/") ? activity : `${applicationId}/${activity}`;
  const launched = await ready.client.targetCommand(
    ready.target,
    "app-launch",
    `Launching ${applicationId}`,
    ["shell", "am", "start", "-W", "-n", component],
    (output) => output,
    signal,
  );
  if (!succeeded(launched.process) || /\b(?:Error|Exception):/iu.test(launched.value)) {
    problems.push(operationProblem("app-launch", launched, commandId));
    return undefined;
  }
  let active: Awaited<ReturnType<typeof foreground>> | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    active = await foreground(ready, signal);
    if (succeeded(active.process) && active.value?.applicationId === applicationId) break;
    if (attempt < 4) {
      const wait =
        dependencies.sleep ??
        (async (milliseconds: number) => {
          await new Promise((resolve) => setTimeout(resolve, milliseconds));
          return true;
        });
      if (!(await wait(150, signal ?? new AbortController().signal))) break;
    }
  }
  const activeValue = active?.value;
  if (
    active === undefined ||
    !succeeded(active.process) ||
    activeValue?.applicationId !== applicationId
  ) {
    problems.push(
      problem(
        "APP_LAUNCH_UNVERIFIED",
        "app.lifecycle",
        `${applicationId} did not become the foreground app.`,
        "ADB accepted the launch request, but the foreground postcondition was not met.",
        commandId,
        [
          {
            source: "adb.activity",
            field: "foreground",
            value:
              activeValue === undefined
                ? null
                : {
                    applicationId: activeValue.applicationId,
                    activity: activeValue.activity,
                  },
          },
        ],
      ),
    );
    return undefined;
  }
  return activity;
}

function installationChanged(
  before: AndroidPackageInfo | undefined,
  after: AndroidPackageInfo,
): boolean {
  if (!after.installed) return false;
  if (before === undefined || !before.installed) return true;
  return (
    before.lastUpdateTime !== after.lastUpdateTime ||
    before.versionCode !== after.versionCode ||
    before.versionName !== after.versionName ||
    before.sourcePath !== after.sourcePath
  );
}

export async function runApp(
  request: AppCommandRequest,
  config: CommandConfig = {},
  dependencies: CommandDependencies = {},
  signal?: AbortSignal,
): Promise<CommandExecution<AppData>> {
  const current = context(`app ${request.action}`, dependencies);
  const problems: Problem[] = [];

  if (request.action === "resolve") {
    const project = await (dependencies.detectProject ?? detectProject)({ cwd: request.cwd });
    const localResolution = await resolveApplicationId({
      root: project.root,
      ...(request.applicationId === undefined ? {} : { explicit: request.applicationId }),
      ...(request.configuredPackage === undefined ? {} : { configured: request.configuredPackage }),
    });
    if (localResolution.kind !== "not-found") {
      if (localResolution.kind !== "resolved")
        problems.push(resolutionProblem(localResolution, current.commandId));
      return finish(current, { action: "resolve", resolution: localResolution }, problems);
    }
    const ready = await readyTarget(current, config, dependencies, problems, signal);
    if (ready === undefined) {
      problems.push(resolutionProblem(localResolution, current.commandId));
      return finish<AppData>(current, null, problems);
    }
    const { resolution, packageObservation } = await applicationResolution(
      request,
      ready,
      dependencies,
      signal,
    );
    if (!succeeded(packageObservation.process)) {
      problems.push(operationProblem("packages-list", packageObservation, current.commandId));
      return finish<AppData>(current, null, problems);
    }
    if (resolution.kind !== "resolved")
      problems.push(resolutionProblem(resolution, current.commandId));
    return finish(current, { action: "resolve", selected: ready.selected, resolution }, problems);
  }

  const ready = await readyTarget(current, config, dependencies, problems, signal);
  if (ready === undefined) return finish<AppData>(current, null, problems);

  if (request.action === "install") {
    const artifact =
      request.artifactPath === undefined
        ? undefined
        : path.resolve(request.cwd, request.artifactPath);
    if (artifact === undefined || path.extname(artifact).toLowerCase() !== ".apk") {
      problems.push(
        problem(
          "APP_ARTIFACT_INVALID",
          "input.app.artifact",
          "Install requires one local .apk file.",
          "Pass the path to an ordinary APK. Split APK sets and app bundles are not accepted by this command.",
          current.commandId,
        ),
      );
      return finish<AppData>(current, null, problems);
    }
    try {
      if (!(await stat(artifact)).isFile()) throw new Error("not a file");
    } catch {
      problems.push(
        problem(
          "APP_ARTIFACT_NOT_FOUND",
          "input.app.artifact",
          "The APK file could not be read.",
          "Check the path and permissions, then retry.",
          current.commandId,
          [{ source: "input", field: "path", value: redactText(artifact).value }],
        ),
      );
      return finish<AppData>(current, null, problems);
    }
    const before = await packages(ready, "user", signal);
    if (!succeeded(before.process)) {
      problems.push(operationProblem("packages-list", before, current.commandId));
      return finish<AppData>(current, null, problems);
    }
    const project = await (dependencies.detectProject ?? detectProject)({ cwd: request.cwd });
    const expectedBefore = await resolveApplicationId({
      root: project.root,
      ...(request.applicationId === undefined ? {} : { explicit: request.applicationId }),
      ...(request.configuredPackage === undefined ? {} : { configured: request.configuredPackage }),
      installed: [],
    });
    if (config.dryRun) {
      if (expectedBefore.kind !== "resolved") {
        problems.push(resolutionProblem(expectedBefore, current.commandId));
        return finish<AppData>(current, null, problems);
      }
      const installArgs = [
        "install",
        ...(request.replace === true ? ["-r"] : []),
        ...(request.grantRuntimePermissions === true ? ["-g"] : []),
        artifact,
      ];
      return finish(
        current,
        mutationPlanData(
          "install",
          ready,
          expectedBefore.applicationId,
          [
            planStep(ready, config, {
              id: "install-apk",
              title: `Install ${path.basename(artifact)}`,
              risk: "device-reversible",
              args: installArgs,
            }),
            planStep(ready, config, {
              id: "verify-installed-package",
              title: `Verify installed package ${expectedBefore.applicationId}`,
              risk: "read-only",
              args: ["shell", "dumpsys", "package", expectedBefore.applicationId],
            }),
          ],
          { artifactPath: redactText(artifact).value },
        ),
        problems,
      );
    }
    const priorInfo =
      expectedBefore.kind === "resolved"
        ? await inspectPackage(ready, expectedBefore.applicationId, signal)
        : undefined;
    const installed = await ready.client.targetCommand(
      ready.target,
      "app-install",
      `Installing ${path.basename(artifact)}`,
      [
        "install",
        ...(request.replace === true ? ["-r"] : []),
        ...(request.grantRuntimePermissions === true ? ["-g"] : []),
        artifact,
      ],
      (output) => output.trim(),
      signal,
    );
    if (!succeeded(installed.process) || !/\bSuccess\b/u.test(installed.value)) {
      problems.push(operationProblem("app-install", installed, current.commandId));
      return finish<AppData>(current, null, problems);
    }
    const after = await packages(ready, "user", signal);
    const afterValues = succeeded(after.process) ? (after.value as AndroidPackage[]) : [];
    const beforeNames = new Set((before.value as AndroidPackage[]).map(({ name }) => name));
    const newPackages = afterValues
      .map(({ name }) => name)
      .filter((name) => !beforeNames.has(name));
    const resolved = await resolveApplicationId({
      root: project.root,
      ...(request.applicationId === undefined ? {} : { explicit: request.applicationId }),
      ...(request.configuredPackage === undefined ? {} : { configured: request.configuredPackage }),
      installed: newPackages,
    });
    if (resolved.kind !== "resolved") {
      problems.push(
        problem(
          "APP_INSTALL_UNVERIFIED",
          "app.install",
          "The APK was accepted, but its installed package could not be verified.",
          "Pass the application ID with --package so ADB Ready can verify the postcondition.",
          current.commandId,
        ),
      );
      return finish<AppData>(current, null, problems);
    }
    const info = await inspectPackage(ready, resolved.applicationId, signal);
    const beforeInfo =
      priorInfo !== undefined &&
      expectedBefore.kind === "resolved" &&
      expectedBefore.applicationId === resolved.applicationId
        ? priorInfo.value
        : undefined;
    const verified = succeeded(info.process) && installationChanged(beforeInfo, info.value);
    if (!verified) {
      problems.push(
        problem(
          "APP_INSTALL_UNVERIFIED",
          "app.install",
          `Installation of ${resolved.applicationId} could not be verified.`,
          "The install output said Success, but the package is not visible on the selected target.",
          current.commandId,
        ),
      );
    }
    return finish(
      current,
      {
        action: "install",
        selected: ready.selected,
        applicationId: resolved.applicationId,
        artifactPath: redactText(artifact).value,
        verified,
        status: verified ? "installed" : "unverified",
      },
      problems,
    );
  }

  const resolution = await requireApplicationId(
    request,
    ready,
    dependencies,
    problems,
    current.commandId,
    signal,
  );
  if (resolution === undefined) {
    if (problems.length === 0)
      problems.push(resolutionProblem({ kind: "not-found", considered: [] }, current.commandId));
    return finish<AppData>(current, null, problems);
  }
  const applicationId = resolution.applicationId;

  if (request.action === "info") {
    const [info, active] = await Promise.all([
      inspectPackage(ready, applicationId, signal),
      foreground(ready, signal),
    ]);
    if (!succeeded(info.process) || !info.value.installed) {
      problems.push(
        problem(
          "APP_NOT_INSTALLED",
          "app.identity",
          `${applicationId} is not installed on the selected target.`,
          "Install the app or select a different application ID.",
          current.commandId,
        ),
      );
    }
    return finish(
      current,
      {
        action: "info",
        selected: ready.selected,
        resolution,
        package: info.value,
        ...(active.value === undefined ? {} : { foreground: active.value }),
      },
      problems,
    );
  }

  if (
    (request.action === "clear-data" || request.action === "uninstall") &&
    !config.dryRun &&
    request.destructiveApproved !== true
  ) {
    problems.push(
      problem(
        "DESTRUCTIVE_APPROVAL_REQUIRED",
        "input.safety",
        `${request.action} requires explicit approval.`,
        "Confirm the action in an interactive terminal or pass --allow-destructive in automation.",
        current.commandId,
      ),
    );
    return finish<AppData>(current, null, problems);
  }

  if (request.action === "stop") {
    if (config.dryRun) {
      return finish(
        current,
        mutationPlanData("stop", ready, applicationId, [
          planStep(ready, config, {
            id: "stop-app",
            title: `Force-stop ${applicationId}`,
            risk: "device-reversible",
            args: ["shell", "am", "force-stop", applicationId],
          }),
          planStep(ready, config, {
            id: "verify-app-stopped",
            title: `Verify ${applicationId} has no running process`,
            risk: "read-only",
            args: ["shell", "pidof", "-s", applicationId],
          }),
        ]),
        problems,
      );
    }
    const verified = await stopApp(ready, applicationId, current.commandId, problems, signal);
    return finish(
      current,
      {
        action: "stop",
        selected: ready.selected,
        applicationId,
        verified,
        status: verified ? "stopped" : "unverified",
      },
      problems,
    );
  }
  if (request.action === "launch" || request.action === "restart") {
    if (config.dryRun) {
      let activity = request.activity;
      if (activity === undefined) {
        const resolved = await ready.client.targetCommand(
          ready.target,
          "app-activity-resolve",
          `Resolving launch activity for ${applicationId}`,
          ["shell", "cmd", "package", "resolve-activity", "--brief", applicationId],
          parseResolvedActivity,
          signal,
        );
        if (!succeeded(resolved.process) || resolved.value === undefined) {
          problems.push(
            problem(
              "APP_ACTIVITY_NOT_FOUND",
              "app.lifecycle",
              `No launchable activity was found for ${applicationId}.`,
              "Pass --activity with an explicit Android component activity.",
              current.commandId,
            ),
          );
          return finish<AppData>(current, null, problems);
        }
        activity = resolved.value.activity;
      }
      const component = activity.includes("/") ? activity : `${applicationId}/${activity}`;
      const steps: OperationPlan["steps"] = [];
      if (request.action === "restart") {
        steps.push(
          planStep(ready, config, {
            id: "stop-app",
            title: `Force-stop ${applicationId}`,
            risk: "device-reversible",
            args: ["shell", "am", "force-stop", applicationId],
          }),
          planStep(ready, config, {
            id: "verify-app-stopped",
            title: `Verify ${applicationId} has no running process`,
            risk: "read-only",
            args: ["shell", "pidof", "-s", applicationId],
          }),
        );
      }
      steps.push(
        planStep(ready, config, {
          id: "launch-app",
          title: `Launch ${component}`,
          risk: "device-reversible",
          args: ["shell", "am", "start", "-W", "-n", component],
        }),
        planStep(ready, config, {
          id: "verify-app-foreground",
          title: `Verify ${applicationId} is foreground`,
          risk: "read-only",
          args: ["shell", "dumpsys", "activity", "activities"],
        }),
      );
      return finish(
        current,
        mutationPlanData(request.action, ready, applicationId, steps, { activity }),
        problems,
      );
    }
    if (request.action === "restart") {
      const stopped = await stopApp(ready, applicationId, current.commandId, problems, signal);
      if (!stopped) return finish<AppData>(current, null, problems);
    }
    const activity = await launchApp(
      ready,
      applicationId,
      request.activity,
      current.commandId,
      problems,
      dependencies,
      signal,
    );
    return finish(
      current,
      {
        action: request.action,
        selected: ready.selected,
        applicationId,
        ...(activity === undefined ? {} : { activity }),
        verified: activity !== undefined,
        status:
          activity === undefined
            ? "unverified"
            : request.action === "restart"
              ? "restarted"
              : "launched",
      },
      problems,
    );
  }
  if (request.action === "clear-data") {
    if (config.dryRun) {
      return finish(
        current,
        mutationPlanData("clear-data", ready, applicationId, [
          planStep(ready, config, {
            id: "clear-app-data",
            title: `Permanently clear data for ${applicationId}`,
            risk: "destructive",
            args: ["shell", "pm", "clear", applicationId],
          }),
          planStep(ready, config, {
            id: "verify-package-retained",
            title: `Verify ${applicationId} remains installed`,
            risk: "read-only",
            args: ["shell", "dumpsys", "package", applicationId],
          }),
          planStep(ready, config, {
            id: "verify-app-stopped",
            title: `Verify ${applicationId} has no running process`,
            risk: "read-only",
            args: ["shell", "pidof", "-s", applicationId],
          }),
        ]),
        problems,
      );
    }
    const cleared = await ready.client.targetCommand(
      ready.target,
      "app-clear-data",
      `Clearing data for ${applicationId}`,
      ["shell", "pm", "clear", applicationId],
      (output) => output.trim(),
      signal,
    );
    const [info, pid] = await Promise.all([
      inspectPackage(ready, applicationId, signal),
      ready.client.targetCommand(
        ready.target,
        "app-clear-data-verify",
        `Verifying data clear for ${applicationId}`,
        ["shell", "pidof", "-s", applicationId],
        (output) => output.trim(),
        signal,
        { acceptExitCodes: [1] },
      ),
    ]);
    const verified =
      succeeded(cleared.process) &&
      cleared.value === "Success" &&
      succeeded(info.process) &&
      info.value.installed &&
      succeeded(pid.process, [1]) &&
      pid.value === "";
    if (!verified) problems.push(operationProblem("app-clear-data", cleared, current.commandId));
    return finish(
      current,
      {
        action: "clear-data",
        selected: ready.selected,
        applicationId,
        verified,
        status: verified ? "cleared" : "unverified",
      },
      problems,
    );
  }
  if (config.dryRun) {
    return finish(
      current,
      mutationPlanData("uninstall", ready, applicationId, [
        planStep(ready, config, {
          id: "uninstall-app",
          title: `Uninstall ${applicationId}`,
          risk: "destructive",
          args: ["uninstall", applicationId],
        }),
        planStep(ready, config, {
          id: "verify-package-removed",
          title: `Verify ${applicationId} is no longer installed`,
          risk: "read-only",
          args: ["shell", "dumpsys", "package", applicationId],
        }),
      ]),
      problems,
    );
  }
  const removed = await ready.client.targetCommand(
    ready.target,
    "app-uninstall",
    `Uninstalling ${applicationId}`,
    ["uninstall", applicationId],
    (output) => output.trim(),
    signal,
  );
  const check = await inspectPackage(ready, applicationId, signal);
  const verified =
    succeeded(removed.process) && /\bSuccess\b/u.test(removed.value) && !check.value.installed;
  if (!verified) problems.push(operationProblem("app-uninstall", removed, current.commandId));
  return finish(
    current,
    {
      action: "uninstall",
      selected: ready.selected,
      applicationId,
      verified,
      status: verified ? "uninstalled" : "unverified",
    },
    problems,
  );
}

export interface OpenData {
  selected: import("../target/selection.js").SelectedTarget;
  url: string;
  applicationId?: string;
  verified: boolean;
  status: "opened" | "planned" | "unverified";
  plan?: OperationPlan;
}

export async function runOpen(
  url: string,
  applicationId: string | undefined,
  config: CommandConfig = {},
  dependencies: CommandDependencies = {},
  signal?: AbortSignal,
): Promise<CommandExecution<OpenData>> {
  const current = context("open", dependencies);
  const problems: Problem[] = [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    problems.push(
      problem(
        "APP_URL_INVALID",
        "input.app.url",
        "The URL is invalid.",
        "Pass an absolute URL with a scheme.",
        current.commandId,
      ),
    );
    return finish<OpenData>(current, null, problems);
  }
  const ready = await readyTarget(current, config, dependencies, problems, signal);
  if (ready === undefined) return finish<OpenData>(current, null, problems);
  const openArgs = [
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    parsed.toString(),
    ...(applicationId === undefined ? [] : [applicationId]),
  ];
  if (config.dryRun) {
    const steps: OperationPlan["steps"] = [
      planStep(ready, config, {
        id: "open-url",
        title: `Open ${parsed.protocol} URL and wait for Activity Manager`,
        risk: "device-reversible",
        args: openArgs,
      }),
    ];
    if (applicationId !== undefined) {
      steps.push(
        planStep(ready, config, {
          id: "verify-app-foreground",
          title: `Verify ${applicationId} handles the URL in foreground`,
          risk: "read-only",
          args: ["shell", "dumpsys", "activity", "activities"],
        }),
      );
    }
    return finish(
      current,
      {
        selected: ready.selected,
        url: parsed.toString(),
        ...(applicationId === undefined ? {} : { applicationId }),
        verified: false,
        status: "planned",
        plan: { schemaVersion: SCHEMA_VERSION, dryRun: true, steps },
      },
      problems,
    );
  }
  const opened = await ready.client.targetCommand(
    ready.target,
    "app-open-url",
    `Opening ${parsed.protocol} URL`,
    openArgs,
    (output) => output,
    signal,
  );
  const openedSuccessfully =
    succeeded(opened.process) && !/\b(?:Error|Exception):/iu.test(opened.value);
  let verified = openedSuccessfully;
  if (!openedSuccessfully) {
    problems.push(operationProblem("app-open-url", opened, current.commandId));
  }
  if (verified && applicationId !== undefined) {
    const active = await foreground(ready, signal);
    verified = succeeded(active.process) && active.value?.applicationId === applicationId;
    if (!verified) {
      problems.push(
        problem(
          "APP_OPEN_UNVERIFIED",
          "app.lifecycle",
          `${applicationId} did not become the foreground URL handler.`,
          "Activity Manager accepted the URL, but the requested application was not observed in foreground.",
          current.commandId,
        ),
      );
    }
  }
  return finish(
    current,
    {
      selected: ready.selected,
      url: parsed.toString(),
      ...(applicationId === undefined ? {} : { applicationId }),
      verified,
      status: verified ? "opened" : "unverified",
    },
    problems,
  );
}
