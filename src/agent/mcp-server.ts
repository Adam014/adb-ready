import { realpath } from "node:fs/promises";
import path from "node:path";
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import manifest from "../../package.json" with { type: "json" };
import { runApp, runOpen } from "../app/app-commands.js";
import {
  type CommandConfig,
  type CommandDependencies,
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
import { selectTarget } from "../target/selection.js";

interface BoundTarget {
  serial: string;
  transportId?: string;
}

export interface McpServerOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  dependencies?: CommandDependencies;
  version?: string;
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
  const structuredContent = { ok: false, problems: [{ code, message }] };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
}

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

function selectedTarget(data: unknown): BoundTarget | undefined {
  if (typeof data !== "object" || data === null || !("selected" in data)) return undefined;
  const selected = (
    data as { selected?: { transport?: { serial?: unknown; transportId?: unknown } } }
  ).selected;
  if (typeof selected?.transport?.serial !== "string") return undefined;
  return {
    serial: selected.transport.serial,
    ...(typeof selected.transport.transportId === "string"
      ? { transportId: selected.transport.transportId }
      : {}),
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
  const dependencies = options.dependencies ?? {};
  const server = new McpServer(
    { name: "adb-ready", version: options.version ?? manifest.version },
    {
      instructions:
        "Call ensure_ready before target-bound work. Treat inspect_ui and screenshots as sensitive. Never infer success when ok=false or verified=false.",
    },
  );
  const load = async () => await loadConfig({ cwd: options.cwd, env: options.env });
  const register = <Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: z.ZodObject<Shape>,
    annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean },
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
        annotations: { ...annotations, openWorldHint: false },
      },
      async (input, context) => {
        const loaded = await load();
        if (!loaded.ok) {
          return inputFailure(
            "MCP_CONFIG_INVALID",
            loaded.errors.map(({ code, message }) => `${code}: ${message}`).join("; "),
          );
        }
        return await handler(input, context.mcpReq.signal, loaded.config);
      },
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
    "Select exactly one ready Android target and bind it for this MCP connection.",
    z.object({
      device: z.string().min(1).optional(),
      transportId: z.string().min(1).optional(),
    }),
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
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
      const execution = await runDevices(
        commandConfig(loaded, bound, device, transportId),
        dependencies,
        signal,
      );
      if (!execution.result.ok || execution.result.data === null) {
        return toolResult(execution.result);
      }
      const data = execution.result.data;
      const selection =
        data.selected === undefined
          ? selectTarget(data.targets)
          : { kind: "selected" as const, selection: data.selected };
      if (selection.kind !== "selected") {
        return inputFailure(
          "MCP_TARGET_SELECTION_REQUIRED",
          "No unique ready target was selected. Pass device with an exact serial or configured alias, or pass transportId.",
        );
      }
      bound = {
        serial: selection.selection.transport.serial,
        ...(selection.selection.transport.transportId === undefined
          ? {}
          : { transportId: selection.selection.transport.transportId }),
      };
      return toolResult({
        ...execution.result,
        data: { ...data, selected: selection.selection },
      });
    },
  );

  const appSchema = z.object({ applicationId: z.string().min(3).optional() });
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
      bound ??= selectedTarget(execution.result.data);
      return toolResult(execution.result);
    },
  );
  for (const action of ["launch", "restart"] as const) {
    register(
      `${action}_app`,
      `${action === "launch" ? "Launch" : "Restart"} the resolved app and verify it is foreground.`,
      z.object({
        applicationId: z.string().min(3).optional(),
        activity: z.string().min(1).optional(),
      }),
      { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
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
        bound ??= selectedTarget(execution.result.data);
        return toolResult(execution.result);
      },
    );
  }
  register(
    "install_app",
    "Install one project-local APK and verify its package. Downloads and split APKs are rejected.",
    z.object({
      path: z.string().min(1),
      applicationId: z.string().min(3).optional(),
      replace: z.boolean().optional(),
      grantRuntimePermissions: z.boolean().optional(),
    }),
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (
      { path: requested, applicationId, replace, grantRuntimePermissions },
      signal,
      loaded,
    ) => {
      const artifactPath = await projectFile(options.cwd, requested).catch(() => undefined);
      if (artifactPath === undefined) {
        return inputFailure(
          "MCP_PATH_OUTSIDE_PROJECT",
          "APK path must resolve inside the project.",
        );
      }
      const execution = await runApp(
        {
          action: "install",
          cwd: options.cwd,
          artifactPath,
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
      bound ??= selectedTarget(execution.result.data);
      return toolResult(execution.result);
    },
  );
  register(
    "open_url",
    "Open an absolute URL and verify an explicit app handler when provided.",
    z.object({ url: z.url(), applicationId: z.string().min(3).optional() }),
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async ({ url, applicationId }, signal, loaded) => {
      const execution = await runOpen(
        url,
        applicationId ?? loaded.values.appPackage,
        commandConfig(loaded, bound),
        dependencies,
        signal,
      );
      bound ??= selectedTarget(execution.result.data);
      return toolResult(execution.result);
    },
  );
  register(
    "inspect_app",
    "Return bounded sensitive app, foreground, and classified-log evidence without a screenshot.",
    appSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
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
      bound ??= selectedTarget(execution.result.data);
      return toolResult(execution.result);
    },
  );
  register(
    "inspect_ui",
    "Return a bounded sensitive accessibility snapshot with digest-scoped references.",
    z.object({
      interactiveOnly: z.boolean().optional(),
      maxDepth: z.number().int().min(1).max(100).optional(),
    }),
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
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
      bound ??= selectedTarget(execution.result.data);
      return toolResult(execution.result);
    },
  );
  register(
    "capture_screenshot",
    "Capture a verified PNG inside the project without overwriting an existing file.",
    z.object({ out: z.string().min(1).optional() }),
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async ({ out }, signal, loaded) => {
      const execution = await runCapture(
        { kind: "screenshot", cwd: options.cwd, ...(out === undefined ? {} : { out }) },
        commandConfig(loaded, bound),
        dependencies,
        signal,
      );
      bound ??= selectedTarget(execution.result.data);
      return toolResult(execution.result);
    },
  );
  register(
    "get_session_problems",
    "Read structured problems from one saved local development session.",
    z.object({ sessionId: z.string().min(1).optional() }),
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async ({ sessionId }) => toolResult((await runProblemsCommand(sessionId)).result),
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
      toolResult((await runContextCommand(sessionId, budget)).result),
  );
  server.registerResource(
    "saved-sessions",
    "adb-ready://sessions",
    { title: "ADB Ready saved sessions", mimeType: "application/json" },
    async (uri) => {
      const execution = await runSessionCommand("list", undefined);
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(execution.result) },
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
