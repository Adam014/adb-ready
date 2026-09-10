import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectProject } from "../dev/project.js";
import type { Problem, ResultEnvelope } from "../domain/contracts.js";
import { ExitCode, SCHEMA_VERSION } from "../domain/contracts.js";

export type AgentClient = "claude-code" | "codex" | "cursor" | "generic" | "vscode" | "windsurf";

export interface AgentSetupOptions {
  client: AgentClient;
  cwd: string;
  dryRun?: boolean;
}

export interface AgentSetupData {
  client: AgentClient;
  status: "created" | "manual" | "planned" | "unchanged" | "updated";
  path: string;
  format: "json" | "toml";
  scope: "project" | "user-defined" | "user";
  content: string;
  next: string;
}

export interface AgentSetupDependencies {
  clock?: () => Date;
  detectProject?: typeof detectProject;
  idFactory?: () => string;
}

interface SetupPlan {
  path?: string;
  displayPath: string;
  format: AgentSetupData["format"];
  scope: AgentSetupData["scope"];
  content: string;
  jsonRoot?: "mcpServers" | "servers";
  manual: boolean;
  next: string;
}

function execute(
  data: AgentSetupData | null,
  problems: Problem[],
  dependencies: AgentSetupDependencies,
): { result: ResultEnvelope<AgentSetupData>; exitCode: number } {
  const now = (dependencies.clock ?? (() => new Date()))();
  const ok = problems.every(({ severity }) => severity !== "error");
  return {
    exitCode: ok ? ExitCode.Success : ExitCode.InvalidInput,
    result: {
      schemaVersion: SCHEMA_VERSION,
      command: "agent setup",
      commandId: (dependencies.idFactory ?? randomUUID)(),
      ok,
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      durationMs: 0,
      data,
      problems,
    },
  };
}

function setupProblem(code: string, summary: string, detail: string): Problem {
  return {
    code,
    category: "input.agent-configuration",
    severity: "error",
    summary,
    detail,
    retryable: true,
    evidence: [],
    actions: [],
    correlation: { commandId: "agent-setup" },
  };
}

function serverEntry(entrypoint: string, environment?: Record<string, string>) {
  return {
    command: "node",
    args: [entrypoint, "mcp"],
    ...(environment === undefined ? {} : { env: environment }),
  };
}

function jsonContent(root: "mcpServers" | "servers", entrypoint: string): string {
  const entry =
    root === "servers" ? { type: "stdio", ...serverEntry(entrypoint) } : serverEntry(entrypoint);
  return `${JSON.stringify({ [root]: { "adb-ready": entry } }, null, 2)}\n`;
}

function planFor(client: AgentClient, root: string): SetupPlan {
  const relativeEntrypoint = "./node_modules/adb-ready/dist/cli.js";
  if (client === "codex") {
    return {
      path: path.join(root, ".codex", "config.toml"),
      displayPath: ".codex/config.toml",
      format: "toml",
      scope: "project",
      manual: false,
      content:
        '[mcp_servers.adb_ready]\ncommand = "node"\nargs = ["./node_modules/adb-ready/dist/cli.js", "mcp"]\ndefault_tools_approval_mode = "writes"\n',
      next: "Restart the Codex client, then inspect its MCP server list.",
    };
  }
  if (client === "claude-code") {
    return {
      path: path.join(root, ".mcp.json"),
      displayPath: ".mcp.json",
      format: "json",
      scope: "project",
      manual: false,
      jsonRoot: "mcpServers",
      content: jsonContent("mcpServers", relativeEntrypoint),
      next: "Start Claude Code in this project and approve the project MCP server.",
    };
  }
  if (client === "cursor") {
    return {
      path: path.join(root, ".cursor", "mcp.json"),
      displayPath: ".cursor/mcp.json",
      format: "json",
      scope: "project",
      manual: false,
      jsonRoot: "mcpServers",
      content: jsonContent("mcpServers", relativeEntrypoint),
      next: "Reload Cursor and enable adb-ready in MCP settings.",
    };
  }
  if (client === "vscode") {
    return {
      path: path.join(root, ".vscode", "mcp.json"),
      displayPath: ".vscode/mcp.json",
      format: "json",
      scope: "project",
      manual: false,
      jsonRoot: "servers",
      content: jsonContent("servers", "$" + "{workspaceFolder}/node_modules/adb-ready/dist/cli.js"),
      next: "Run MCP: List Servers in VS Code and start adb-ready.",
    };
  }
  if (client === "windsurf") {
    const entrypoint = path.join(root, "node_modules", "adb-ready", "dist", "cli.js");
    const content = `${JSON.stringify(
      {
        mcpServers: {
          "adb-ready": serverEntry(entrypoint, { ADB_READY_MCP_PROJECT_ROOT: root }),
        },
      },
      null,
      2,
    )}\n`;
    return {
      displayPath: "~/.codeium/windsurf/mcp_config.json",
      format: "json",
      scope: "user",
      manual: true,
      content,
      next: "Merge this entry in Windsurf MCP settings, then restart Cascade.",
    };
  }
  return {
    displayPath: "your MCP client configuration",
    format: "json",
    scope: "user-defined",
    manual: true,
    content: jsonContent("mcpServers", relativeEntrypoint),
    next: "Add the entry as a local stdio server started from this project root.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeJson(existing: string, plan: SetupPlan): { content?: string; unchanged: boolean } {
  const rootName = plan.jsonRoot;
  if (rootName === undefined) return { unchanged: false };
  const document = JSON.parse(existing) as unknown;
  const addition = JSON.parse(plan.content) as Record<string, Record<string, unknown>>;
  if (!isRecord(document)) throw new Error("root-not-object");
  const currentRoot = document[rootName];
  if (currentRoot !== undefined && !isRecord(currentRoot)) throw new Error("root-not-object");
  const servers = currentRoot ?? {};
  const wanted = addition[rootName]?.["adb-ready"];
  const current = servers["adb-ready"];
  if (current !== undefined) {
    return sameJson(current, wanted)
      ? { content: existing, unchanged: true }
      : { unchanged: false };
  }
  return {
    content: `${JSON.stringify({ ...document, [rootName]: { ...servers, "adb-ready": wanted } }, null, 2)}\n`,
    unchanged: false,
  };
}

function mergeToml(existing: string, plan: SetupPlan): { content?: string; unchanged: boolean } {
  const table = /^\s*\[mcp_servers\.(?:adb_ready|"adb_ready")\]\s*$/mu;
  if (table.test(existing)) {
    return existing.includes(plan.content.trim())
      ? { content: existing, unchanged: true }
      : { unchanged: false };
  }
  const separator =
    existing === "" || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return { content: `${existing}${separator}${plan.content}`, unchanged: false };
}

async function atomicWrite(destination: string, content: string, exists: boolean): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(path.dirname(destination), `.adb-ready-agent-${randomUUID()}.tmp`);
  const backup = path.join(path.dirname(destination), `.adb-ready-agent-${randomUUID()}.backup`);
  let movedExisting = false;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
    if (exists) {
      await rename(destination, backup);
      movedExisting = true;
    }
    await rename(temporary, destination);
    if (movedExisting) await rm(backup, { force: true });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (movedExisting) {
      await rm(destination, { force: true }).catch(() => undefined);
      await rename(backup, destination).catch(() => undefined);
    }
    throw error;
  }
}

export async function runAgentSetup(
  options: AgentSetupOptions,
  dependencies: AgentSetupDependencies = {},
): Promise<{ result: ResultEnvelope<AgentSetupData>; exitCode: number }> {
  const project = await (dependencies.detectProject ?? detectProject)({ cwd: options.cwd });
  const plan = planFor(options.client, project.root);
  if (plan.manual || plan.path === undefined) {
    return execute(
      {
        client: options.client,
        status: "manual",
        path: plan.displayPath,
        format: plan.format,
        scope: plan.scope,
        content: plan.content,
        next: plan.next,
      },
      [],
      dependencies,
    );
  }

  const destination = plan.path;
  const entry = await lstat(destination).catch(() => undefined);
  if (entry?.isSymbolicLink()) {
    return execute(
      null,
      [
        setupProblem(
          "AGENT_CONFIG_SYMLINK",
          "The agent configuration path is a symbolic link.",
          "Review the linked file manually; ADB Ready will not replace or follow it.",
        ),
      ],
      dependencies,
    );
  }
  if (entry !== undefined && !entry.isFile()) {
    return execute(
      null,
      [
        setupProblem(
          "AGENT_CONFIG_INVALID_PATH",
          "The agent configuration path is not a regular file.",
          `Move the existing ${plan.displayPath} entry and retry.`,
        ),
      ],
      dependencies,
    );
  }

  const exists = entry?.isFile() === true;
  let content = plan.content;
  let unchanged = false;
  if (exists) {
    const existing = await readFile(destination, "utf8");
    try {
      const merged = plan.format === "json" ? mergeJson(existing, plan) : mergeToml(existing, plan);
      if (merged.content === undefined) {
        return execute(
          null,
          [
            setupProblem(
              "AGENT_SERVER_CONFLICT",
              "An adb-ready MCP server is already configured differently.",
              `Review ${plan.displayPath}; ADB Ready will not overwrite that server entry.`,
            ),
          ],
          dependencies,
        );
      }
      content = merged.content;
      unchanged = merged.unchanged;
    } catch {
      return execute(
        null,
        [
          setupProblem(
            "AGENT_CONFIG_INVALID",
            "The existing agent configuration could not be merged safely.",
            `Fix ${plan.displayPath} or add the documented adb-ready entry manually.`,
          ),
        ],
        dependencies,
      );
    }
  }

  if (!unchanged && !options.dryRun) {
    try {
      await atomicWrite(destination, content, exists);
      if (plan.format === "json") JSON.parse(await readFile(destination, "utf8"));
    } catch {
      return execute(
        null,
        [
          setupProblem(
            "AGENT_CONFIG_WRITE_FAILED",
            "The agent configuration could not be written safely.",
            `Check permissions for ${plan.displayPath} and retry.`,
          ),
        ],
        dependencies,
      );
    }
  }

  return execute(
    {
      client: options.client,
      status: unchanged ? "unchanged" : options.dryRun ? "planned" : exists ? "updated" : "created",
      path: plan.displayPath,
      format: plan.format,
      scope: plan.scope,
      content,
      next: plan.next,
    },
    [],
    dependencies,
  );
}
