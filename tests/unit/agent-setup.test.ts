import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentSetup } from "../../src/agent/setup.js";

function dependencies(root: string) {
  return {
    idFactory: () => "command-1",
    clock: () => new Date("2026-09-10T10:00:00.000Z"),
    detectProject: async () => ({
      root,
      presetEvidence: [],
      packageManager: { conflicts: [] },
    }),
  };
}

describe("agent setup", () => {
  test("previews a project-scoped Codex configuration without writing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-agent-"));
    try {
      const execution = await runAgentSetup(
        { client: "codex", cwd: root, dryRun: true },
        dependencies(root),
      );
      expect(execution.result.data).toMatchObject({
        client: "codex",
        status: "planned",
        path: ".codex/config.toml",
        scope: "project",
      });
      expect(execution.result.data?.content).toContain("[mcp_servers.adb_ready]");
      expect(
        await readFile(path.join(root, ".codex", "config.toml"), "utf8").catch(() => null),
      ).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("merges a Cursor server without discarding existing configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-agent-"));
    const destination = path.join(root, ".cursor", "mcp.json");
    try {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(
        destination,
        `${JSON.stringify({ mcpServers: { existing: { command: "safe-tool" } }, setting: true })}\n`,
      );
      const execution = await runAgentSetup({ client: "cursor", cwd: root }, dependencies(root));
      expect(execution.result.data).toMatchObject({ status: "updated" });
      expect(JSON.parse(await readFile(destination, "utf8"))).toEqual({
        mcpServers: {
          existing: { command: "safe-tool" },
          "adb-ready": {
            command: "node",
            args: ["./node_modules/adb-ready/dist/cli.js", "mcp"],
          },
        },
        setting: true,
      });
      const repeated = await runAgentSetup({ client: "cursor", cwd: root }, dependencies(root));
      expect(repeated.result.data).toMatchObject({ status: "unchanged" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses to replace a differently configured server entry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-agent-"));
    const destination = path.join(root, ".mcp.json");
    const existing = '{"mcpServers":{"adb-ready":{"command":"custom"}}}\n';
    try {
      await writeFile(destination, existing);
      const execution = await runAgentSetup(
        { client: "claude-code", cwd: root },
        dependencies(root),
      );
      expect(execution.result.ok).toBeFalse();
      expect(execution.result.problems).toMatchObject([{ code: "AGENT_SERVER_CONFLICT" }]);
      expect(await readFile(destination, "utf8")).toBe(existing);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns a manual user-scoped Windsurf snippet with an explicit project root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-agent-"));
    try {
      const execution = await runAgentSetup({ client: "windsurf", cwd: root }, dependencies(root));
      expect(execution.result.data).toMatchObject({
        status: "manual",
        path: "~/.codeium/windsurf/mcp_config.json",
        scope: "user",
      });
      expect(JSON.parse(execution.result.data?.content ?? "{}")).toMatchObject({
        mcpServers: {
          "adb-ready": { env: { ADB_READY_MCP_PROJECT_ROOT: root } },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
