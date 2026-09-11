import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type CallToolResult, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import manifest from "../../package.json" with { type: "json" };
import { runApp, runOpen } from "../app/app-commands.js";
import {
  type CommandConfig,
  type CommandDependencies,
  runConnect,
  runDevices,
  runDoctor,
} from "../app/commands.js";
import {
  runContextCommand,
  runProblemsCommand,
  runSessionCommand,
} from "../app/session-commands.js";
import { loadConfig } from "../config/loader.js";
import type { LoadedConfig } from "../config/types.js";
import type { ResultEnvelope } from "../domain/contracts.js";
import { runCapture } from "../evidence/capture.js";
import { runInspectApp, runInspectUi } from "../evidence/inspect.js";
import { runUiAction } from "../evidence/ui-actions.js";
import { planTargetAcquisition } from "../session/target-acquisition.js";
import { acquireTargetLease, type TargetLeaseOptions } from "../state/target-lease.js";
import { selectTarget } from "../target/selection.js";
import { getAgentDevTask, startAgentDevTask, stopAgentDevTask } from "./dev-task.js";
import { SerialTaskQueue } from "./serial-task-queue.js";

interface BoundTarget {
  handle: string;
  serial: string;
  identity: string;
  transportId?: string;
}

export interface McpServerOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  dependencies?: CommandDependencies;
  targetLease?: false | TargetLeaseOptions;
  version?: string;
  cliPath?: string;
}

function record(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function toolResult(result: ResultEnvelope<unknown>): CallToolResult {
  const structuredContent = record(result);
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(!result.ok ? { isError: true } : {}),
  };
}

function inputFailure(code: string, message: string): CallToolResult {
  const timestamp = new Date().toISOString();
  const commandId = randomUUID();
  return toolResult({
    schemaVersion: 1,
    command: "mcp",
    commandId,
    ok: false,
    startedAt: timestamp,
    finishedAt: timestamp,
    durationMs: 0,
    data: null,
    problems: [
      {
        code,
        category: "input.mcp",
        severity: "error",
        summary: message,
        detail: message,
        retryable: false,
        evidence: [],
        actions: [],
        correlation: { commandId },
      },
    ],
  });
}

function successResult(command: string, data: Record<string, unknown>): CallToolResult {
  const timestamp = new Date().toISOString();
  return toolResult({
    schemaVersion: 1,
    command,
    commandId: randomUUID(),
    ok: true,
    startedAt: timestamp,
    finishedAt: timestamp,
    durationMs: 0,
    data,
    problems: [],
  });
}

const resultEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    command: z.string(),
    commandId: z.string(),
    ok: z.boolean(),
    startedAt: z.string(),
    finishedAt: z.string(),
    durationMs: z.number().nonnegative(),
    data: z.unknown().nullable(),
    problems: z.array(z.object({ code: z.string() }).passthrough()),
  })
  .passthrough();

const targetHandleShape = { targetHandle: z.uuid().optional() };

function commandConfig(
  loaded: LoadedConfig,
  bound?: BoundTarget,
  selector?: string,
  transportId?: string,
): CommandConfig {
  const values = loaded.values;
  return {
    ...(values.adbPath === undefined ? {} : { adbPath: values.adbPath }),
    ...(values.adbHost === undefined ? {} : { adbHost: values.adbHost }),
    ...(values.adbPort === undefined ? {} : { adbPort: values.adbPort }),
    timeoutMs: values.timeoutMs,
    ...(values.targetAliases === undefined ? {} : { targetAliases: values.targetAliases }),
    ...(bound?.transportId !== undefined
      ? { targetTransportId: bound.transportId }
      : bound !== undefined
        ? { targetSelector: bound.serial }
        : transportId !== undefined
          ? { targetTransportId: transportId }
          : selector === undefined
            ? {}
            : { targetSelector: selector }),
  };
}

async function projectFile(root: string, requested: string): Promise<string | undefined> {
  if (path.isAbsolute(requested)) return undefined;
  const project = await realpath(root);
  const file = await realpath(path.resolve(project, requested));
  const relative = path.relative(project, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..")
    ? file
    : undefined;
}

export function createAdbReadyMcpServer(options: McpServerOptions): McpServer {
  let bound: BoundTarget | undefined;
  const toolQueue = new SerialTaskQueue();
  const dependencies = options.dependencies ?? {};
  const server = new McpServer(
    { name: "adb-ready", version: options.version ?? manifest.version },
    {
      instructions:
        "Call ensure_ready before target-bound work. Treat inspect_ui and screenshots as sensitive. Use digest-scoped UI refs when possible. Never infer success when ok=false or verified=false.",
    },
  );
  const load = async () => await loadConfig({ cwd: options.cwd, env: options.env });
  const sessionStore = { env: options.env, projectRoot: options.cwd };
  const register = <Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: z.ZodObject<Shape>,
    annotations: {
      readOnlyHint: boolean;
      destructiveHint: boolean;
      idempotentHint: boolean;
      targetBound?: boolean;
      leaseTarget?: boolean;
    },
    handler: (
      input: z.infer<z.ZodObject<Shape>>,
      signal: AbortSignal,
      loaded: LoadedConfig,
    ) => Promise<CallToolResult>,
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        outputSchema: resultEnvelopeSchema,
        annotations: {
          readOnlyHint: annotations.readOnlyHint,
          destructiveHint: annotations.destructiveHint,
          idempotentHint: annotations.idempotentHint,
          openWorldHint: false,
        },
      },
      async (input, context) =>
        await toolQueue.run(async () => {
          const loaded = await load();
          if (!loaded.ok) {
            return inputFailure(
              "MCP_CONFIG_INVALID",
              loaded.errors.map(({ code, message }) => `${code}: ${message}`).join("; "),
            );
          }
          const requestedHandle = (input as Record<string, unknown>).targetHandle;
          if ((annotations.targetBound === true || annotations.leaseTarget === true) && !bound) {
            return inputFailure(
              "MCP_TARGET_NOT_BOUND",
              "Call ensure_ready before a target-bound tool.",
            );
          }
          if (
            requestedHandle !== undefined &&
            (bound === undefined || requestedHandle !== bound.handle)
          ) {
            return inputFailure(
              "MCP_TARGET_HANDLE_INVALID",
              "The target handle is stale or belongs to another MCP connection. Call ensure_ready again.",
            );
          }
          const shouldLease = annotations.leaseTarget ?? !annotations.readOnlyHint;
          if (!shouldLease || options.targetLease === false) {
            return await handler(input, context.mcpReq.signal, loaded.config);
          }
          if (bound === undefined) throw new Error("Target lease requested without a bound target");
          const acquired = await acquireTargetLease(
            {
              targetIdentity: bound.identity,
              projectRoot: options.cwd,
              purpose: `mcp:${name}`,
            },
            { env: options.env, ...(options.targetLease ?? {}) },
          );
          if (!acquired.ok) return inputFailure(acquired.code, acquired.message);
          try {
            return await handler(input, context.mcpReq.signal, loaded.config);
          } finally {
            await acquired.lease.release();
          }
        }),
    );
  };

  register(
    "doctor",
    "Inspect the local runtime, ADB server, capabilities, and visible Android targets.",
    z.object({}),
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (_input, signal, loaded) =>
      toolResult((await runDoctor(commandConfig(loaded), dependencies, signal)).result),
  );
  register(
    "list_targets",
    "List Android targets without changing the connection's bound target.",
    z.object({}),
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (_input, signal, loaded) =>
      toolResult((await runDevices(commandConfig(loaded), dependencies, signal)).result),
  );
  register(
    "ensure_ready",
    "Select exactly one ready Android target, safely reconnect one unambiguous paired wireless target when needed, and bind it for this MCP connection.",
    z.object({
      device: z.string().min(1).optional(),
      transportId: z.string().min(1).optional(),
    }),
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      leaseTarget: false,
    },
    async ({ device, transportId }, signal, loaded) => {
      if (device !== undefined && transportId !== undefined) {
        return inputFailure(
          "MCP_TARGET_SELECTOR_CONFLICT",
          "Pass either device or transportId, not both.",
        );
      }
      if (
        bound !== undefined &&
        ((device !== undefined && device !== bound.serial) ||
          (transportId !== undefined && transportId !== bound.transportId))
      ) {
        return inputFailure(
          "MCP_TARGET_ALREADY_BOUND",
          `This connection is bound to ${bound.serial}.`,
        );
      }
      let execution = await runDevices(
        commandConfig(loaded, bound, device, transportId),
        dependencies,
        signal,
      );
      if (execution.result.data === null) {
        return toolResult(execution.result);
      }
      let data = execution.result.data;
      let selection =
        data.selected === undefined
          ? selectTarget(data.targets)
          : { kind: "selected" as const, selection: data.selected };
      if (selection.kind !== "selected" && transportId === undefined) {
        const acquisition = planTargetAcquisition({
          ...(device === undefined ? {} : { selector: device }),
          ...(loaded.values.targetAliases === undefined
            ? {}
            : { aliases: loaded.values.targetAliases }),
          services: data.discovery.mdns.services,
        });
        if (
          acquisition.kind === "connect" &&
          (device === undefined || acquisition.reason === "explicit-endpoint")
        ) {
          const connected = await runConnect(
            acquisition.endpoint,
            {
              ...commandConfig(loaded),
              ...(acquisition.discovered
                ? {
                    endpointWasDiscovered: true,
                    discoveredEndpointCandidates: acquisition.candidates,
                  }
                : {}),
            },
            dependencies,
            signal,
          );
          if (
            !connected.result.ok ||
            connected.result.data === null ||
            !("serial" in connected.result.data)
          ) {
            return toolResult(connected.result);
          }
          execution = await runDevices(
            commandConfig(loaded, undefined, connected.result.data.serial),
            dependencies,
            signal,
          );
          if (execution.result.data === null) return toolResult(execution.result);
          data = execution.result.data;
          selection =
            data.selected === undefined
              ? selectTarget(data.targets)
              : { kind: "selected" as const, selection: data.selected };
        }
      }
      if (selection.kind !== "selected") {
        return inputFailure(
          "MCP_TARGET_SELECTION_REQUIRED",
          "No unique ready target was selected. Pass device with an exact serial or configured alias, or pass transportId.",
        );
      }
      bound = {
        handle: bound?.handle ?? randomUUID(),
        serial: selection.selection.transport.serial,
        identity:
          selection.selection.target.hardwareSerial ??
          selection.selection.target.id ??
          selection.selection.transport.serial,
        ...(selection.selection.transport.transportId === undefined
          ? {}
          : { transportId: selection.selection.transport.transportId }),
      };
      return toolResult({
        ...execution.result,
        data: { ...data, selected: selection.selection, targetHandle: bound.handle },
      });
    },
  );

  register(
    "start_dev_session",
    "Start the configured development session as a durable local process and return an opaque handle immediately.",
    z.object({ ...targetHandleShape }),
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      targetBound: true,
      leaseTarget: false,
    },
    async () => {
      if (bound === undefined) {
        return inputFailure(
          "MCP_TARGET_NOT_BOUND",
          "Call ensure_ready before starting development.",
        );
      }
      try {
        const task = await startAgentDevTask({
          cwd: options.cwd,
          env: options.env,
          cliPath: options.cliPath ?? fileURLToPath(import.meta.url),
          serial: bound.serial,
          targetIdentity: bound.identity,
        });
        return successResult("mcp start_dev_session", { task });
      } catch {
        return inputFailure(
          "MCP_DEV_START_FAILED",
          "ADB Ready could not start the managed development process.",
        );
      }
    },
  );
  register(
    "get_dev_session",
    "Read the durable status of a project-scoped development-session handle after reconnects.",
    z.object({ taskHandle: z.uuid() }),
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async ({ taskHandle }) => {
      const task = await getAgentDevTask(taskHandle, { cwd: options.cwd, env: options.env });
      return task === undefined
        ? inputFailure(
            "MCP_DEV_TASK_NOT_FOUND",
            "No development task with this handle exists in the current project.",
          )
        : successResult("mcp get_dev_session", { task });
    },
  );
  register(
    "stop_dev_session",
    "Stop only the durable project-scoped development process owned by an opaque handle.",
    z.object({ taskHandle: z.uuid() }),
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      leaseTarget: false,
    },
    async ({ taskHandle }) => {
      const task = await stopAgentDevTask(taskHandle, { cwd: options.cwd, env: options.env });
      return task === undefined
        ? inputFailure(
            "MCP_DEV_TASK_NOT_FOUND",
            "No development task with this handle exists in the current project.",
          )
        : successResult("mcp stop_dev_session", { task });
    },
  );

  const appSchema = z.object({ applicationId: z.string().min(3).optional() });
  const boundAppSchema = z.object({
    ...targetHandleShape,
    applicationId: z.string().min(3).optional(),
  });
  register(
    "resolve_app",
    "Resolve the Android project application ID with provenance.",
    appSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async ({ applicationId }, signal, loaded) => {
      const execution = await runApp(
        {
          action: "resolve",
          cwd: options.cwd,
          ...(applicationId === undefined ? {} : { applicationId }),
          ...(loaded.values.appPackage === undefined
            ? {}
            : { configuredPackage: { value: loaded.values.appPackage } }),
        },
        commandConfig(loaded, bound),
        dependencies,
        signal,
      );
      return toolResult(execution.result);
    },
  );
  for (const action of ["launch", "restart"] as const) {
    register(
      `${action}_app`,
      `${action === "launch" ? "Launch" : "Restart"} the resolved app and verify it is foreground.`,
      z.object({
        ...targetHandleShape,
        applicationId: z.string().min(3).optional(),
        activity: z.string().min(1).optional(),
      }),
      {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        targetBound: true,
      },
      async ({ applicationId, activity }, signal, loaded) => {
        const execution = await runApp(
          {
            action,
            cwd: options.cwd,
            ...(applicationId === undefined ? {} : { applicationId }),
            ...(activity === undefined ? {} : { activity }),
            ...(loaded.values.appPackage === undefined
              ? {}
              : { configuredPackage: { value: loaded.values.appPackage } }),
          },
          commandConfig(loaded, bound),
          dependencies,
          signal,
        );
        return toolResult(execution.result);
      },
    );
  }
  register(
    "install_app",
    "Install one project-local APK or a complete split APK set and verify its package.",
    z.object({
      ...targetHandleShape,
      path: z.string().min(1).optional(),
      paths: z.array(z.string().min(1)).min(1).max(64).optional(),
      applicationId: z.string().min(3).optional(),
      replace: z.boolean().optional(),
      grantRuntimePermissions: z.boolean().optional(),
    }),
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      targetBound: true,
    },
    async (
      { path: requested, paths: requestedSet, applicationId, replace, grantRuntimePermissions },
      signal,
      loaded,
    ) => {
      if ((requested === undefined) === (requestedSet === undefined)) {
        return inputFailure("MCP_INVALID_INPUT", "Provide exactly one of path or paths.");
      }
      const requestedPaths = requestedSet ?? [requested as string];
      const artifactPaths = await Promise.all(
        requestedPaths.map(
          async (item) => await projectFile(options.cwd, item).catch(() => undefined),
        ),
      );
      if (artifactPaths.some((item) => item === undefined)) {
        return inputFailure(
          "MCP_PATH_OUTSIDE_PROJECT",
          "Every APK path must resolve inside the project.",
        );
      }
      const execution = await runApp(
        {
          action: "install",
          cwd: options.cwd,
          artifactPaths: artifactPaths as string[],
          ...(applicationId === undefined ? {} : { applicationId }),
          ...(loaded.values.appPackage === undefined
            ? {}
            : { configuredPackage: { value: loaded.values.appPackage } }),
          ...(replace === undefined ? {} : { replace }),
          ...(grantRuntimePermissions === undefined ? {} : { grantRuntimePermissions }),
        },
        commandConfig(loaded, bound),
        dependencies,
        signal,
      );
      return toolResult(execution.result);
    },
  );
  register(
    "open_url",
    "Open an absolute URL and verify an explicit app handler when provided.",
    z.object({
      ...targetHandleShape,
      url: z.url(),
      applicationId: z.string().min(3).optional(),
    }),
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      targetBound: true,
    },
    async ({ url, applicationId }, signal, loaded) => {
      const execution = await runOpen(
        url,
        applicationId ?? loaded.values.appPackage,
        commandConfig(loaded, bound),
        dependencies,
        signal,
      );
      return toolResult(execution.result);
    },
  );
  register(
    "inspect_app",
    "Return bounded sensitive app, foreground, and classified-log evidence without a screenshot.",
    boundAppSchema,
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      targetBound: true,
    },
    async ({ applicationId }, signal, loaded) => {
      const execution = await runInspectApp(
        {
          cwd: options.cwd,
          ...(applicationId === undefined ? {} : { applicationId }),
          ...(loaded.values.appPackage === undefined
            ? {}
            : { configuredPackage: { value: loaded.values.appPackage } }),
        },
        commandConfig(loaded, bound),
        dependencies,
        signal,
      );
      return toolResult(execution.result);
    },
  );
  register(
    "inspect_ui",
    "Return a bounded sensitive accessibility snapshot with digest-scoped references.",
    z.object({
      ...targetHandleShape,
      interactiveOnly: z.boolean().optional(),
      maxDepth: z.number().int().min(1).max(100).optional(),
    }),
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      targetBound: true,
    },
    async ({ interactiveOnly, maxDepth }, signal, loaded) => {
      const execution = await runInspectUi(
        {
          ...(interactiveOnly === undefined ? {} : { interactiveOnly }),
          ...(maxDepth === undefined ? {} : { maxDepth }),
        },
        commandConfig(loaded, bound),
        dependencies,
        signal,
      );
      return toolResult(execution.result);
    },
  );
  const uiSelectorSchema = z.union([
    z.string().regex(/^(?:class|desc|id|package|text)=.{1,256}$/u),
    z.object({
      field: z.enum(["class", "desc", "id", "package", "text"]),
      value: z.string().min(1).max(256),
      match: z.enum(["contains", "exact", "starts-with"]).optional(),
      enabled: z.boolean().optional(),
      actionable: z.boolean().optional(),
    }),
  ]);
  register(
    "find_ui",
    "Find bounded UI nodes by semantic id, text, description, class, or package selectors without changing device state.",
    z.object({
      ...targetHandleShape,
      selector: uiSelectorSchema,
      limit: z.number().int().min(1).max(100).optional(),
    }),
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      targetBound: true,
    },
    async ({ selector, limit }, signal, loaded) =>
      toolResult(
        (
          await runUiAction(
            { action: "find", selector, ...(limit === undefined ? {} : { limit }) },
            commandConfig(loaded, bound),
            dependencies,
            signal,
          )
        ).result,
      ),
  );
  register(
    "get_ui",
    "Read one unambiguous UI node with its current semantic, state, and bounds properties.",
    z.object({
      ...targetHandleShape,
      selector: uiSelectorSchema,
      occurrence: z.number().int().min(1).max(10_000).optional(),
    }),
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      targetBound: true,
    },
    async ({ selector, occurrence }, signal, loaded) =>
      toolResult(
        (
          await runUiAction(
            { action: "get", selector, ...(occurrence === undefined ? {} : { occurrence }) },
            commandConfig(loaded, bound),
            dependencies,
            signal,
          )
        ).result,
      ),
  );
  register(
    "assert_ui",
    "Assert that a semantic UI selector is visible or gone in the current hierarchy.",
    z.object({
      ...targetHandleShape,
      selector: uiSelectorSchema,
      state: z.enum(["gone", "visible"]).optional(),
    }),
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      targetBound: true,
    },
    async ({ selector, state }, signal, loaded) =>
      toolResult(
        (
          await runUiAction(
            { action: "assert", selector, ...(state === undefined ? {} : { state }) },
            commandConfig(loaded, bound),
            dependencies,
            signal,
          )
        ).result,
      ),
  );
  register(
    "compare_ui",
    "Compare the current UI with a complete digest returned by an earlier inspection or action.",
    z.object({ ...targetHandleShape, digest: z.string().regex(/^[a-f0-9]{64}$/u) }),
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      targetBound: true,
    },
    async ({ digest }, signal, loaded) =>
      toolResult(
        (
          await runUiAction(
            { action: "compare", digest },
            commandConfig(loaded, bound),
            dependencies,
            signal,
          )
        ).result,
      ),
  );
  const pointSchema = z.union([
    z.object({ ref: z.string().regex(/^ui:[a-f0-9]{12}:\d+$/u) }),
    z.object({
      selector: uiSelectorSchema,
      occurrence: z.number().int().min(1).max(10_000).optional(),
    }),
    z.object({ x: z.number().int().min(0).max(100_000), y: z.number().int().min(0).max(100_000) }),
  ]);
  for (const action of ["tap", "long-press"] as const) {
    register(
      `${action === "tap" ? "tap" : "long_press"}_ui`,
      `${action === "tap" ? "Tap" : "Long-press"} a unique semantic selector, current digest-scoped UI ref, or explicit display coordinate, then compare UI state.`,
      z.object({
        ...targetHandleShape,
        target: pointSchema,
        dryRun: z.boolean().optional(),
      }),
      {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        targetBound: true,
      },
      async ({ target, dryRun }, signal, loaded) => {
        const request =
          action === "tap"
            ? "ref" in target
              ? {
                  action: "tap" as const,
                  ref: target.ref,
                  ...(dryRun === undefined ? {} : { dryRun }),
                }
              : "selector" in target
                ? {
                    action: "tap" as const,
                    selector: target.selector,
                    ...(target.occurrence === undefined ? {} : { occurrence: target.occurrence }),
                    ...(dryRun === undefined ? {} : { dryRun }),
                  }
                : {
                    action: "tap" as const,
                    x: target.x,
                    y: target.y,
                    ...(dryRun === undefined ? {} : { dryRun }),
                  }
            : "ref" in target
              ? {
                  action: "long-press" as const,
                  ref: target.ref,
                  ...(dryRun === undefined ? {} : { dryRun }),
                }
              : "selector" in target
                ? {
                    action: "long-press" as const,
                    selector: target.selector,
                    ...(target.occurrence === undefined ? {} : { occurrence: target.occurrence }),
                    ...(dryRun === undefined ? {} : { dryRun }),
                  }
                : {
                    action: "long-press" as const,
                    x: target.x,
                    y: target.y,
                    ...(dryRun === undefined ? {} : { dryRun }),
                  };
        const execution = await runUiAction(
          request,
          commandConfig(loaded, bound),
          dependencies,
          signal,
        );
        return toolResult(execution.result);
      },
    );
  }
  register(
    "swipe_ui",
    "Swipe in a screen-relative direction or between explicit display coordinates, then compare UI state.",
    z.object({
      ...targetHandleShape,
      direction: z.enum(["down", "left", "right", "up"]).optional(),
      x1: z.number().int().min(0).max(100_000).optional(),
      y1: z.number().int().min(0).max(100_000).optional(),
      x2: z.number().int().min(0).max(100_000).optional(),
      y2: z.number().int().min(0).max(100_000).optional(),
      dryRun: z.boolean().optional(),
    }),
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      targetBound: true,
    },
    async ({ direction, x1, y1, x2, y2, dryRun }, signal, loaded) => {
      const coordinateCount = [x1, y1, x2, y2].filter((value) => value !== undefined).length;
      if (
        (direction === undefined && coordinateCount !== 4) ||
        (direction !== undefined && coordinateCount !== 0)
      ) {
        return inputFailure(
          "MCP_UI_SWIPE_INPUT",
          "Pass either direction or all four coordinates, not both.",
        );
      }
      const request =
        direction !== undefined
          ? { action: "swipe" as const, direction, ...(dryRun === undefined ? {} : { dryRun }) }
          : {
              action: "swipe" as const,
              x1: x1 ?? 0,
              y1: y1 ?? 0,
              x2: x2 ?? 0,
              y2: y2 ?? 0,
              ...(dryRun === undefined ? {} : { dryRun }),
            };
      const execution = await runUiAction(
        request,
        commandConfig(loaded, bound),
        dependencies,
        signal,
      );
      return toolResult(execution.result);
    },
  );
  register(
    "scroll_ui",
    "Scroll the screen or one unique semantic scroll container in a display-relative direction, then compare UI state.",
    z.object({
      ...targetHandleShape,
      direction: z.enum(["down", "left", "right", "up"]),
      selector: uiSelectorSchema.optional(),
      occurrence: z.number().int().min(1).max(10_000).optional(),
      dryRun: z.boolean().optional(),
    }),
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      targetBound: true,
    },
    async ({ direction, selector, occurrence, dryRun }, signal, loaded) =>
      toolResult(
        (
          await runUiAction(
            {
              action: "scroll",
              direction,
              ...(selector === undefined ? {} : { selector }),
              ...(occurrence === undefined ? {} : { occurrence }),
              ...(dryRun === undefined ? {} : { dryRun }),
            },
            commandConfig(loaded, bound),
            dependencies,
            signal,
          )
        ).result,
      ),
  );
  register(
    "type_text_ui",
    "Type conservative shell-safe text into the focused Android field and optionally press enter.",
    z.object({
      ...targetHandleShape,
      text: z.string().min(1).max(256),
      submit: z.boolean().optional(),
      dryRun: z.boolean().optional(),
    }),
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      targetBound: true,
    },
    async ({ text, submit, dryRun }, signal, loaded) => {
      const execution = await runUiAction(
        {
          action: "type",
          text,
          ...(submit === undefined ? {} : { submit }),
          ...(dryRun === undefined ? {} : { dryRun }),
        },
        commandConfig(loaded, bound),
        dependencies,
        signal,
      );
      return toolResult(execution.result);
    },
  );
  register(
    "fill_ui",
    "Focus one semantic editable field, replace its value with conservative shell-safe text, and verify the observable value.",
    z.object({
      ...targetHandleShape,
      selector: uiSelectorSchema,
      occurrence: z.number().int().min(1).max(10_000).optional(),
      text: z.string().min(1).max(256),
      submit: z.boolean().optional(),
      dryRun: z.boolean().optional(),
    }),
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      targetBound: true,
    },
    async ({ selector, occurrence, text, submit, dryRun }, signal, loaded) =>
      toolResult(
        (
          await runUiAction(
            {
              action: "fill",
              selector,
              text,
              ...(occurrence === undefined ? {} : { occurrence }),
              ...(submit === undefined ? {} : { submit }),
              ...(dryRun === undefined ? {} : { dryRun }),
            },
            commandConfig(loaded, bound),
            dependencies,
            signal,
          )
        ).result,
      ),
  );
  register(
    "clear_ui",
    "Focus one semantic editable field, clear its value, and verify the observable value.",
    z.object({
      ...targetHandleShape,
      selector: uiSelectorSchema,
      occurrence: z.number().int().min(1).max(10_000).optional(),
      dryRun: z.boolean().optional(),
    }),
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      targetBound: true,
    },
    async ({ selector, occurrence, dryRun }, signal, loaded) =>
      toolResult(
        (
          await runUiAction(
            {
              action: "clear",
              selector,
              ...(occurrence === undefined ? {} : { occurrence }),
              ...(dryRun === undefined ? {} : { dryRun }),
            },
            commandConfig(loaded, bound),
            dependencies,
            signal,
          )
        ).result,
      ),
  );
  register(
    "press_key_ui",
    "Press one allowlisted Android navigation or volume key, then compare UI state.",
    z.object({
      ...targetHandleShape,
      key: z.enum(["back", "enter", "home", "menu", "volume-down", "volume-up"]),
      dryRun: z.boolean().optional(),
    }),
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      targetBound: true,
    },
    async ({ key, dryRun }, signal, loaded) => {
      const execution = await runUiAction(
        { action: "press", key, ...(dryRun === undefined ? {} : { dryRun }) },
        commandConfig(loaded, bound),
        dependencies,
        signal,
      );
      return toolResult(execution.result);
    },
  );
  register(
    "wait_for_ui",
    "Wait a bounded time for an exact id=, text=, desc=, or package= selector to be visible or gone.",
    z.object({
      ...targetHandleShape,
      selector: uiSelectorSchema,
      state: z.enum(["gone", "visible"]).optional(),
      timeoutMs: z.number().int().min(100).max(120_000).optional(),
    }),
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      targetBound: true,
    },
    async ({ selector, state, timeoutMs }, signal, loaded) => {
      const execution = await runUiAction(
        {
          action: "wait",
          selector,
          ...(state === undefined ? {} : { state }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
        commandConfig(loaded, bound),
        dependencies,
        signal,
      );
      return toolResult(execution.result);
    },
  );
  register(
    "capture_screenshot",
    "Capture a verified PNG inside the project and return its image pixels to the client without overwriting an existing file.",
    z.object({ ...targetHandleShape, out: z.string().min(1).optional() }),
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      targetBound: true,
    },
    async ({ out }, signal, loaded) => {
      const execution = await runCapture(
        { kind: "screenshot", cwd: options.cwd, ...(out === undefined ? {} : { out }) },
        commandConfig(loaded, bound),
        dependencies,
        signal,
      );
      const result = toolResult(execution.result);
      const evidence = execution.result.data?.evidence;
      if (execution.result.ok && evidence?.mediaType === "image/png") {
        const pixels = await readFile(path.resolve(options.cwd, evidence.path));
        result.content.push({
          type: "image",
          data: pixels.toString("base64"),
          mimeType: "image/png",
        });
      }
      return result;
    },
  );
  register(
    "get_session_problems",
    "Read structured problems from one saved local development session.",
    z.object({ sessionId: z.string().min(1).optional() }),
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async ({ sessionId }) => toolResult((await runProblemsCommand(sessionId, sessionStore)).result),
  );
  register(
    "compile_debug_context",
    "Compile bounded redacted context. Screenshots and UI text are excluded.",
    z.object({
      sessionId: z.string().min(1).optional(),
      budget: z.number().int().min(1_000).max(100_000).optional(),
    }),
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async ({ sessionId, budget }) =>
      toolResult((await runContextCommand(sessionId, budget, sessionStore)).result),
  );
  server.registerResource(
    "current-targets",
    "adb-ready://targets",
    { title: "ADB Ready current targets", mimeType: "application/json" },
    async (uri) => {
      const loaded = await load();
      const value = loaded.ok
        ? (await runDevices(commandConfig(loaded.config), dependencies)).result
        : {
            ok: false,
            problems: loaded.errors.map(({ code, message }) => ({ code, message })),
          };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ ...value, boundTarget: bound ?? null }),
          },
        ],
      };
    },
  );
  server.registerResource(
    "saved-sessions",
    "adb-ready://sessions",
    { title: "ADB Ready saved sessions", mimeType: "application/json" },
    async (uri) => {
      const execution = await runSessionCommand("list", undefined, sessionStore);
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(execution.result) },
        ],
      };
    },
  );
  server.registerResource(
    "session-manifest",
    new ResourceTemplate("adb-ready://sessions/{sessionId}", { list: undefined }),
    { title: "ADB Ready session manifest", mimeType: "application/json" },
    async (uri, { sessionId }) => {
      const execution = await runSessionCommand("show", String(sessionId), sessionStore);
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(execution.result) },
        ],
      };
    },
  );
  server.registerResource(
    "session-events",
    new ResourceTemplate("adb-ready://sessions/{sessionId}/events/{offset}/{limit}", {
      list: undefined,
    }),
    { title: "ADB Ready paginated session events", mimeType: "application/json" },
    async (uri, { sessionId, offset, limit }) => {
      const parsedOffset = Number(offset);
      const parsedLimit = Number(limit);
      if (
        !Number.isSafeInteger(parsedOffset) ||
        parsedOffset < 0 ||
        !Number.isSafeInteger(parsedLimit) ||
        parsedLimit < 1 ||
        parsedLimit > 200
      ) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({
                ok: false,
                problems: [
                  {
                    code: "MCP_SESSION_PAGE_INVALID",
                    message: "offset must be a non-negative integer and limit must be 1-200.",
                  },
                ],
              }),
            },
          ],
        };
      }
      const execution = await runSessionCommand("events", String(sessionId), sessionStore);
      const data = execution.result.data;
      const page =
        data !== null && data.action === "events"
          ? {
              ...execution.result,
              data: {
                session: data.session,
                offset: parsedOffset,
                limit: parsedLimit,
                total: data.events.length,
                nextOffset:
                  parsedOffset + parsedLimit < data.events.length
                    ? parsedOffset + parsedLimit
                    : null,
                events: data.events.slice(parsedOffset, parsedOffset + parsedLimit),
              },
            }
          : execution.result;
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(page) }],
      };
    },
  );
  server.registerResource(
    "session-context",
    new ResourceTemplate("adb-ready://sessions/{sessionId}/context", { list: undefined }),
    { title: "ADB Ready redacted session context", mimeType: "text/markdown" },
    async (uri, { sessionId }) => {
      const execution = await runContextCommand(String(sessionId), 12_000, sessionStore);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: execution.result.ok ? "text/markdown" : "application/json",
            text: execution.result.data?.markdown ?? JSON.stringify(execution.result),
          },
        ],
      };
    },
  );
  return server;
}

export async function runMcpStdio(options: McpServerOptions, signal?: AbortSignal): Promise<void> {
  const handle = serveStdio(() => createAdbReadyMcpServer(options), {
    onerror: (error) => process.stderr.write(`[adb-ready mcp] ${error.message}\n`),
  });
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    process.stdin.once("end", done);
    process.stdin.once("close", done);
    signal?.addEventListener("abort", done, { once: true });
  });
  await handle.close();
}
