import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectProject } from "../dev/project.js";
import type { Problem, ResultEnvelope } from "../domain/contracts.js";
import { ExitCode, SCHEMA_VERSION } from "../domain/contracts.js";
import type { McpProfile } from "./profiles.js";

export type AgentClient = "claude-code" | "codex" | "cursor" | "generic" | "vscode" | "windsurf";

export interface AgentSetupOptions {
  client: AgentClient;
  cwd: string;
  dryRun?: boolean;
  mcpProfile?: McpProfile;
}

export interface AgentSkillSetupData {
  path: string;
  status: "created" | "planned" | "unchanged" | "updated";
}

export interface AgentSetupData {
  client: AgentClient;
  status: "created" | "manual" | "planned" | "unchanged" | "updated";
  path: string;
  format: "json" | "toml";
  scope: "project" | "user-defined" | "user";
  content: string;
  next: string;
  profile: McpProfile;
  skill?: AgentSkillSetupData;
}

export interface AgentSetupDependencies {
  clock?: () => Date;
  detectProject?: typeof detectProject;
  idFactory?: () => string;
  loadSkill?: () => Promise<string>;
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

function mcpArgs(entrypoint: string, profile: McpProfile): string[] {
  return [entrypoint, "mcp", ...(profile === "full" ? [] : ["--mcp-profile", profile])];
}

function serverEntry(
  entrypoint: string,
  profile: McpProfile,
  environment?: Record<string, string>,
) {
  return {
    command: "node",
    args: mcpArgs(entrypoint, profile),
    ...(environment === undefined ? {} : { env: environment }),
  };
}

function jsonContent(
  root: "mcpServers" | "servers",
  entrypoint: string,
  profile: McpProfile,
): string {
  const entry =
    root === "servers"
      ? { type: "stdio", ...serverEntry(entrypoint, profile) }
      : serverEntry(entrypoint, profile);
  return `${JSON.stringify({ [root]: { "adb-ready": entry } }, null, 2)}\n`;
}

function planFor(client: AgentClient, root: string, profile: McpProfile): SetupPlan {
  const relativeEntrypoint = "./node_modules/adb-ready/dist/cli.js";
  if (client === "codex") {
    return {
      path: path.join(root, ".codex", "config.toml"),
      displayPath: ".codex/config.toml",
      format: "toml",
      scope: "project",
      manual: false,
      content: `[mcp_servers.adb_ready]\ncommand = "node"\nargs = [${mcpArgs(
        relativeEntrypoint,
        profile,
      )
        .map((value) => JSON.stringify(value))
        .join(", ")}]\ndefault_tools_approval_mode = "writes"\n`,
      next: "Trust this project in Codex, restart the client, then inspect its MCP server list.",
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
      content: jsonContent("mcpServers", relativeEntrypoint, profile),
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
      content: jsonContent("mcpServers", relativeEntrypoint, profile),
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
      content: jsonContent(
        "servers",
        "$" + "{workspaceFolder}/node_modules/adb-ready/dist/cli.js",
        profile,
      ),
      next: "Run MCP: List Servers in VS Code and start adb-ready.",
    };
  }
  if (client === "windsurf") {
    const entrypoint = path.join(root, "node_modules", "adb-ready", "dist", "cli.js");
    const content = `${JSON.stringify(
      {
        mcpServers: {
          "adb-ready": serverEntry(entrypoint, profile, {
            ADB_READY_MCP_PROJECT_ROOT: root,
          }),
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
    content: jsonContent("mcpServers", relativeEntrypoint, profile),
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

interface PlannedWrite {
  destination: string;
  content: string;
  exists: boolean;
}

async function atomicWriteSet(writes: PlannedWrite[]): Promise<void> {
  const staged = writes.map((write) => ({
    ...write,
    temporary: path.join(path.dirname(write.destination), `.adb-ready-agent-${randomUUID()}.tmp`),
    backup: path.join(path.dirname(write.destination), `.adb-ready-agent-${randomUUID()}.backup`),
    movedExisting: false,
    installed: false,
  }));
  try {
    for (const item of staged) {
      await mkdir(path.dirname(item.destination), { recursive: true });
      await writeFile(item.temporary, item.content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644,
      });
    }
    for (const item of staged) {
      if (item.exists) {
        await rename(item.destination, item.backup);
        item.movedExisting = true;
      }
      await rename(item.temporary, item.destination);
      item.installed = true;
    }
    await Promise.all(staged.map(async ({ backup }) => await rm(backup, { force: true })));
  } catch (error) {
    for (const item of [...staged].reverse()) {
      await rm(item.temporary, { force: true }).catch(() => undefined);
      if (item.installed) await rm(item.destination, { force: true }).catch(() => undefined);
      if (item.movedExisting) {
        await rename(item.backup, item.destination).catch(() => undefined);
      }
    }
    throw error;
  }
}

async function loadPackagedSkill(): Promise<string> {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(directory, "../skills/adb-ready/SKILL.md"),
    path.resolve(directory, "../../skills/adb-ready/SKILL.md"),
  ];
  for (const candidate of candidates) {
    const content = await readFile(candidate, "utf8").catch(() => undefined);
    if (content !== undefined) return content;
  }
  throw new Error("packaged-skill-not-found");
}

function skillPath(client: AgentClient, root: string): { path: string; displayPath: string } {
  const relative =
    client === "claude-code"
      ? path.join(".claude", "skills", "adb-ready", "SKILL.md")
      : path.join(".agents", "skills", "adb-ready", "SKILL.md");
  return { path: path.join(root, relative), displayPath: relative.split(path.sep).join("/") };
}

async function unsafeAncestor(root: string, destination: string): Promise<boolean> {
  const relativeParent = path.relative(root, path.dirname(destination));
  if (relativeParent === "" || relativeParent === ".") return false;
  if (relativeParent === ".." || relativeParent.startsWith(`..${path.sep}`)) return true;
  let current = root;
  for (const segment of relativeParent.split(path.sep)) {
    current = path.join(current, segment);
    const entry = await lstat(current).catch(() => undefined);
    if (entry === undefined) return false;
    if (entry.isSymbolicLink() || !entry.isDirectory()) return true;
  }
  return false;
}

export async function runAgentSetup(
  options: AgentSetupOptions,
  dependencies: AgentSetupDependencies = {},
): Promise<{ result: ResultEnvelope<AgentSetupData>; exitCode: number }> {
  const project = await (dependencies.detectProject ?? detectProject)({ cwd: options.cwd });
  const profile = options.mcpProfile ?? "full";
  const plan = planFor(options.client, project.root, profile);
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
        profile,
      },
      [],
      dependencies,
    );
  }

  const destination = plan.path;
  if (await unsafeAncestor(project.root, destination)) {
    return execute(
      null,
      [
        setupProblem(
          "AGENT_CONFIG_UNSAFE_PARENT",
          "The agent configuration parent path is not a safe project directory.",
          `Review ${plan.displayPath}; ADB Ready will not write through linked or non-directory parents.`,
        ),
      ],
      dependencies,
    );
  }
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

  const plannedSkill = skillPath(options.client, project.root);
  if (await unsafeAncestor(project.root, plannedSkill.path)) {
    return execute(
      null,
      [
        setupProblem(
          "AGENT_SKILL_UNSAFE_PARENT",
          "The agent skill parent path is not a safe project directory.",
          `Review ${plannedSkill.displayPath}; ADB Ready will not write through linked or non-directory parents.`,
        ),
      ],
      dependencies,
    );
  }
  const skillEntry = await lstat(plannedSkill.path).catch(() => undefined);
  if (skillEntry?.isSymbolicLink()) {
    return execute(
      null,
      [
        setupProblem(
          "AGENT_SKILL_SYMLINK",
          "The agent skill path is a symbolic link.",
          "Review the linked skill manually; ADB Ready will not replace or follow it.",
        ),
      ],
      dependencies,
    );
  }
  if (skillEntry !== undefined && !skillEntry.isFile()) {
    return execute(
      null,
      [
        setupProblem(
          "AGENT_SKILL_INVALID_PATH",
          "The agent skill path is not a regular file.",
          `Move the existing ${plannedSkill.displayPath} entry and retry.`,
        ),
      ],
      dependencies,
    );
  }
  let skillContent: string;
  try {
    skillContent = await (dependencies.loadSkill ?? loadPackagedSkill)();
  } catch {
    return execute(
      null,
      [
        setupProblem(
          "AGENT_SKILL_UNAVAILABLE",
          "The packaged ADB Ready Agent Skill is unavailable.",
          "Reinstall adb-ready and retry the project setup.",
        ),
      ],
      dependencies,
    );
  }
  const skillExists = skillEntry?.isFile() === true;
  const existingSkill = skillExists ? await readFile(plannedSkill.path, "utf8") : undefined;
  if (
    existingSkill !== undefined &&
    existingSkill !== skillContent &&
    !existingSkill.includes("<!-- Generated by adb-ready ")
  ) {
    return execute(
      null,
      [
        setupProblem(
          "AGENT_SKILL_CONFLICT",
          "A custom adb-ready Agent Skill already exists.",
          `Review ${plannedSkill.displayPath}; ADB Ready will not overwrite a custom skill.`,
        ),
      ],
      dependencies,
    );
  }
  const skillUnchanged = existingSkill === skillContent;

  if ((!unchanged || !skillUnchanged) && !options.dryRun) {
    try {
      await atomicWriteSet([
        ...(!unchanged ? [{ destination, content, exists }] : []),
        ...(!skillUnchanged
          ? [{ destination: plannedSkill.path, content: skillContent, exists: skillExists }]
          : []),
      ]);
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
      status:
        unchanged && skillUnchanged
          ? "unchanged"
          : options.dryRun
            ? "planned"
            : exists
              ? "updated"
              : "created",
      path: plan.displayPath,
      format: plan.format,
      scope: plan.scope,
      content,
      next: plan.next,
      profile,
      skill: {
        path: plannedSkill.displayPath,
        status: skillUnchanged
          ? "unchanged"
          : options.dryRun
            ? "planned"
            : skillExists
              ? "updated"
              : "created",
      },
    },
    [],
    dependencies,
  );
}
