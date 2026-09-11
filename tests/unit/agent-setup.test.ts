import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

  test("creates supported project configurations and preserves existing TOML", async () => {
    for (const client of ["claude-code", "vscode"] as const) {
      const root = await mkdtemp(path.join(tmpdir(), "adb-ready-agent-"));
      try {
        const execution = await runAgentSetup({ client, cwd: root }, dependencies(root));
        expect(execution.result.data).toMatchObject({ status: "created", client });
        const destination = path.join(root, client === "vscode" ? ".vscode/mcp.json" : ".mcp.json");
        expect(JSON.parse(await readFile(destination, "utf8"))).toBeObject();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-agent-"));
    const destination = path.join(root, ".codex", "config.toml");
    try {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, 'model = "gpt-5"');
      const execution = await runAgentSetup({ client: "codex", cwd: root }, dependencies(root));
      expect(execution.result.data).toMatchObject({ status: "updated" });
      expect(await readFile(destination, "utf8")).toBe(
        'model = "gpt-5"\n\n[mcp_servers.adb_ready]\ncommand = "node"\nargs = ["./node_modules/adb-ready/dist/cli.js", "mcp"]\ndefault_tools_approval_mode = "writes"\n',
      );
      const repeated = await runAgentSetup({ client: "codex", cwd: root }, dependencies(root));
      expect(repeated.result.data).toMatchObject({ status: "unchanged" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns generic setup content without changing the project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-agent-"));
    try {
      const execution = await runAgentSetup({ client: "generic", cwd: root }, dependencies(root));
      expect(execution.result.data).toMatchObject({
        status: "manual",
        path: "your MCP client configuration",
        scope: "user-defined",
      });
      expect(JSON.parse(execution.result.data?.content ?? "{}")).toHaveProperty(
        "mcpServers.adb-ready",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed for malformed, unsafe, and incompatible configuration paths", async () => {
    const malformedRoot = await mkdtemp(path.join(tmpdir(), "adb-ready-agent-"));
    try {
      await writeFile(path.join(malformedRoot, ".mcp.json"), "not-json");
      const malformed = await runAgentSetup(
        { client: "claude-code", cwd: malformedRoot },
        dependencies(malformedRoot),
      );
      expect(malformed.result.problems).toMatchObject([{ code: "AGENT_CONFIG_INVALID" }]);
    } finally {
      await rm(malformedRoot, { recursive: true, force: true });
    }

    const invalidRoot = await mkdtemp(path.join(tmpdir(), "adb-ready-agent-"));
    try {
      await mkdir(path.join(invalidRoot, ".vscode", "mcp.json"), { recursive: true });
      const invalid = await runAgentSetup(
        { client: "vscode", cwd: invalidRoot },
        dependencies(invalidRoot),
      );
      expect(invalid.result.problems).toMatchObject([{ code: "AGENT_CONFIG_INVALID_PATH" }]);
    } finally {
      await rm(invalidRoot, { recursive: true, force: true });
    }

    const linkedRoot = await mkdtemp(path.join(tmpdir(), "adb-ready-agent-"));
    try {
      const actual = path.join(linkedRoot, "actual.json");
      await writeFile(actual, "{}\n");
      await symlink(actual, path.join(linkedRoot, ".mcp.json"));
      const linked = await runAgentSetup(
        { client: "claude-code", cwd: linkedRoot },
        dependencies(linkedRoot),
      );
      expect(linked.result.problems).toMatchObject([{ code: "AGENT_CONFIG_SYMLINK" }]);
      expect(await readFile(actual, "utf8")).toBe("{}\n");
    } finally {
      await rm(linkedRoot, { recursive: true, force: true });
    }
  });

  test("rejects JSON documents whose root or server collection is not an object", async () => {
    for (const content of ["[]\n", '{"mcpServers":[]}\n']) {
      const root = await mkdtemp(path.join(tmpdir(), "adb-ready-agent-"));
      try {
        await writeFile(path.join(root, ".mcp.json"), content);
        const execution = await runAgentSetup(
          { client: "claude-code", cwd: root },
          dependencies(root),
        );
        expect(execution.result.problems).toMatchObject([{ code: "AGENT_CONFIG_INVALID" }]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
