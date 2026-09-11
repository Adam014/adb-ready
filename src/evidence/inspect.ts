import {
  type AppInfoData,
  context,
  finish,
  operationProblem,
  problem,
  readyTarget,
  runApp,
  succeeded,
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
  classifyUiHierarchyFailure,
  DEFAULT_UI_SNAPSHOT_TIMEOUT_MS,
  parseUiHierarchy,
  type UiHierarchySnapshot,
} from "./ui-hierarchy.js";

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
  const hierarchy = await ready.client.targetCommand(
    ready.target,
    "inspect-ui",
    "Reading Android accessibility hierarchy",
    ["exec-out", "uiautomator", "dump", "/dev/tty"],
    (output) =>
      parseUiHierarchy(output, {
        ...(request.interactiveOnly === undefined
          ? {}
          : { interactiveOnly: request.interactiveOnly }),
        maxDepth,
        maxNodes: 2_000,
      }),
    signal,
    {
      maxBufferBytes: 8 * 1024 * 1024,
      timeoutMs: config.uiTimeoutMs ?? config.timeoutMs ?? DEFAULT_UI_SNAPSHOT_TIMEOUT_MS,
    },
  );
  if (!succeeded(hierarchy.process)) {
    problems.push(operationProblem("inspect-ui", hierarchy, current.commandId));
    return finish<InspectUiData>(current, null, problems);
  }
  if (hierarchy.value === undefined) {
    const reason = classifyUiHierarchyFailure(
      `${hierarchy.process.stdout}\n${hierarchy.process.stderr}`,
    );
    problems.push(
      reason === "not-idle"
        ? problem(
            "UI_NOT_IDLE",
            "evidence.ui.busy",
            "Android UI did not become idle for hierarchy capture.",
            "Continuous accessibility events or animation prevented the platform UI Automator dumper from returning a hierarchy. Pause the changing UI or navigate to a stable screen, then retry.",
            current.commandId,
          )
        : problem(
            "UI_HIERARCHY_UNAVAILABLE",
            "evidence.ui",
            "Android returned no readable UI hierarchy.",
            "The current window may be secure, inaccessible, or unsupported by UI Automator.",
            current.commandId,
          ),
    );
    return finish<InspectUiData>(current, null, problems);
  }
  return finish(
    current,
    { kind: "ui", selected: ready.selected, snapshot: hierarchy.value },
    problems,
  );
}
