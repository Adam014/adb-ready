import {
  type AppInfoData,
  context,
  finish,
  problem,
  readyTarget,
  runApp,
} from "../app/app-commands.js";
import {
  type CommandConfig,
  type CommandDependencies,
  type CommandExecution,
  type LogsData,
  runLogs,
} from "../app/commands.js";
import type { Problem } from "../domain/contracts.js";
import {
  DEFAULT_UI_SNAPSHOT_TIMEOUT_MS,
  type UiAcquisitionProfile,
  type UiHierarchySnapshot,
} from "./ui-hierarchy.js";
import { acquireUiSnapshot } from "./ui-hierarchy-capture.js";

export interface InspectAppRequest {
  cwd: string;
  applicationId?: string;
  configuredPackage?: { value: string; location?: string };
  logTail?: number;
}

export interface InspectAppData {
  kind: "app";
  selected: import("../target/selection.js").SelectedTarget;
  app: AppInfoData;
  logs:
    | {
        available: true;
        records: LogsData["records"];
        findings: LogsData["findings"];
        dropped: number;
      }
    | { available: false; reason: string };
  screenshot: {
    available: false;
    reason: "sensitive-explicit-capture-required";
    command: "adb-ready capture screenshot";
  };
  sensitive: true;
}

export interface InspectUiRequest {
  acquisition?: UiAcquisitionProfile;
  interactiveOnly?: boolean;
  maxDepth?: number;
}

export interface InspectUiData {
  kind: "ui";
  selected: import("../target/selection.js").SelectedTarget;
  snapshot: UiHierarchySnapshot;
}

export type InspectData = InspectAppData | InspectUiData;

export async function runInspectApp(
  request: InspectAppRequest,
  config: CommandConfig = {},
  dependencies: CommandDependencies = {},
  signal?: AbortSignal,
): Promise<CommandExecution<InspectAppData>> {
  const current = context("inspect app", dependencies);
  const problems: Problem[] = [];
  const infoExecution = await runApp(
    {
      action: "info",
      cwd: request.cwd,
      ...(request.applicationId === undefined ? {} : { applicationId: request.applicationId }),
      ...(request.configuredPackage === undefined
        ? {}
        : { configuredPackage: request.configuredPackage }),
    },
    config,
    dependencies,
    signal,
  );
  const app = infoExecution.result.data;
  if (!infoExecution.result.ok || app === null || app.action !== "info") {
    problems.push(...infoExecution.result.problems);
    return finish<InspectAppData>(current, null, problems);
  }
  const boundConfig: CommandConfig = {
    ...config,
    rememberedOnly: false,
    ...(app.selected.transport.transportId === undefined
      ? { targetSelector: app.selected.transport.serial }
      : { targetTransportId: app.selected.transport.transportId }),
  };
  if (app.selected.transport.transportId === undefined) delete boundConfig.targetTransportId;
  else delete boundConfig.targetSelector;
  const logsExecution = await runLogs(
    {
      packageName: app.package.applicationId,
      dump: true,
      tail: request.logTail ?? 50,
      maxRecords: 100,
    },
    boundConfig,
    dependencies,
    signal,
  );
  const logs = logsExecution.result.data;
  return finish(
    current,
    {
      kind: "app",
      selected: app.selected,
      app,
      logs:
        logs === null
          ? {
              available: false,
              reason:
                logsExecution.result.problems[0]?.summary ??
                "Focused logs are unavailable for the selected app.",
            }
          : {
              available: true,
              records: logs.records,
              findings: logs.findings,
              dropped: logs.dropped,
            },
      screenshot: {
        available: false,
        reason: "sensitive-explicit-capture-required",
        command: "adb-ready capture screenshot",
      },
      sensitive: true,
    },
    problems,
  );
}

export async function runInspectUi(
  request: InspectUiRequest,
  config: CommandConfig = {},
  dependencies: CommandDependencies = {},
  signal?: AbortSignal,
): Promise<CommandExecution<InspectUiData>> {
  const current = context("inspect ui", dependencies);
  const problems: Problem[] = [];
  const maxDepth = request.maxDepth ?? 25;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 100) {
    problems.push(
      problem(
        "UI_MAX_DEPTH_INVALID",
        "input.ui.depth",
        "UI hierarchy depth must be from 1 to 100.",
        "Choose a bounded maximum depth.",
        current.commandId,
      ),
    );
    return finish<InspectUiData>(current, null, problems);
  }
  const ready = await readyTarget(current, config, dependencies, problems, signal);
  if (ready === undefined) return finish<InspectUiData>(current, null, problems);
  const captured = await acquireUiSnapshot({
    client: ready.client,
    target: ready.target,
    targetIdentity: ready.selected.target.id,
    commandId: current.commandId,
    operation: "inspect-ui",
    message: "Reading Android accessibility hierarchy",
    timeoutMs: config.uiTimeoutMs ?? config.timeoutMs ?? DEFAULT_UI_SNAPSHOT_TIMEOUT_MS,
    maxBufferBytes: 8 * 1024 * 1024,
    ...(request.acquisition === undefined ? {} : { profile: request.acquisition }),
    ...(request.interactiveOnly === undefined ? {} : { interactiveOnly: request.interactiveOnly }),
    maxDepth,
    maxNodes: 2_000,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    ...(signal === undefined ? {} : { signal }),
    lock: {
      ...dependencies.uiHierarchyLock,
      lease: {
        ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
        ...dependencies.uiHierarchyLock?.lease,
      },
    },
  });
  if (!captured.ok) {
    problems.push(captured.problem);
    return finish<InspectUiData>(current, null, problems);
  }
  return finish(
    current,
    { kind: "ui", selected: ready.selected, snapshot: captured.snapshot },
    problems,
  );
}
