# AI agent integration

ADB Ready exposes Android workflows to local AI agents through a typed Model
Context Protocol (MCP) server. The agent works with the same deterministic
target, application identity, verification rules, and structured problems as
the CLI—without receiving a generic shell or raw ADB command.

## Install and verify

Pin ADB Ready in the Android project the agent will work on:

```bash
npm install --save-dev --save-exact adb-ready
node ./node_modules/adb-ready/dist/cli.js doctor
```

The MCP server uses standard input/output and must be started from the project
root:

```bash
node ./node_modules/adb-ready/dist/cli.js mcp
```

Do not run that command by hand for normal use; the MCP client starts and stops
it. ADB Ready does not open an MCP network listener.

## Connect an agent

Preview the exact project change first, then apply it:

```bash
adb-ready agent setup codex --dry-run
adb-ready agent setup codex
```

Replace `codex` with `claude-code`, `cursor`, or `vscode`. Existing unrelated
configuration is preserved. An existing `adb-ready` entry with different
settings is reported as a conflict and is never replaced automatically.

### Codex

Create a project-scoped `.codex/config.toml`:

```toml
[mcp_servers.adb_ready]
command = "node"
args = ["./node_modules/adb-ready/dist/cli.js", "mcp"]
default_tools_approval_mode = "writes"
```

Codex CLI, the Codex IDE extension, and the ChatGPT desktop app share Codex MCP
configuration. See the [official Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp).

### Claude Code

Run this from the project root:

```bash
claude mcp add --scope project adb-ready -- node ./node_modules/adb-ready/dist/cli.js mcp
claude mcp get adb-ready
```

Claude Code stores project-scoped servers in `.mcp.json` and asks users to
approve them. See the [official Claude Code MCP guide](https://docs.anthropic.com/en/docs/claude-code/mcp).

### Cursor

Create `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "adb-ready": {
      "command": "node",
      "args": ["./node_modules/adb-ready/dist/cli.js", "mcp"]
    }
  }
}
```

See the [official Cursor MCP guide](https://docs.cursor.com/context/model-context-protocol).

### VS Code and GitHub Copilot

Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "adb-ready": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/node_modules/adb-ready/dist/cli.js", "mcp"]
    }
  }
}
```

See the [official VS Code MCP guide](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

### Windsurf

Windsurf currently keeps MCP configuration in a user-scoped file. Generate a
project-bound snippet and merge it through Windsurf MCP settings:

```bash
adb-ready agent setup windsurf
```

ADB Ready deliberately does not edit this global file. The generated entry
uses an absolute local package path and `ADB_READY_MCP_PROJECT_ROOT` so Cascade
still resolves the intended project. See the [official Windsurf MCP guide](https://docs.windsurf.com/windsurf/cascade/mcp).

### Other MCP clients

Generate a standard `mcpServers` entry:

```bash
adb-ready agent setup generic
```

Merge the result at the location required by the client and ensure the server
starts in the Android project root.

## Recommended agent workflow

Ask the agent to follow this sequence:

1. Call `doctor` when host or ADB health is unknown.
2. Call `ensure_ready`; provide an exact device serial, configured alias, or
   transport ID when more than one ready target exists.
3. Resolve the project app with `resolve_app`.
4. Use `inspect_app` or `inspect_ui` for bounded current evidence.
5. Perform one typed action, then inspect again instead of assuming success.
6. Use `get_session_problems` or `compile_debug_context` for an existing
   development session.

The first successful `ensure_ready` binds one target to that MCP connection.
Later tools cannot silently switch to another target.

## Tool surface

| Capability | MCP tools |
| --- | --- |
| Host and target readiness | `doctor`, `list_targets`, `ensure_ready` |
| App identity and lifecycle | `resolve_app`, `install_app`, `launch_app`, `restart_app`, `open_url` |
| Current evidence | `inspect_app`, `inspect_ui`, `capture_screenshot` |
| Safe UI actions | `tap_ui`, `long_press_ui`, `swipe_ui`, `type_text_ui`, `press_key_ui`, `wait_for_ui` |
| Saved diagnostics | `get_session_problems`, `compile_debug_context` |

MCP resources keep larger read-only context outside tool calls:

| Resource | Content |
| --- | --- |
| `adb-ready://targets` | current target inventory and this connection's bound target |
| `adb-ready://sessions` | bounded saved-session manifests |
| `adb-ready://sessions/{sessionId}` | one session manifest |
| `adb-ready://sessions/{sessionId}/events/{offset}/{limit}` | a page of up to 200 redacted events |
| `adb-ready://sessions/{sessionId}/context` | a bounded redacted Markdown context document |

Tool results contain the same structured success, problem, evidence, and
verification data used by CLI JSON output.

The npm package also ships `schema/agent-tools-v1.json`, generated from the
server's real `tools/list` response during every build. Integrations can inspect
version-matched input schemas and safety annotations without starting ADB.

## Safety boundary

- There is no arbitrary command, shell, or raw ADB tool.
- MCP tool arguments are schema-validated before execution.
- Local APK installation accepts only a real path inside the project.
- Screenshots require an explicit tool call and are stored as project files.
- UI hierarchy and app inspection are marked sensitive and remain bounded.
- UI references are checked against a fresh hierarchy digest before mutation;
  stale references are rejected.
- Data clearing and uninstall are intentionally absent from the agent surface.
- Tool annotations help clients request approval, but ADB Ready enforces its
  own target, path, and destructive-action rules.
- Nothing is uploaded by ADB Ready. The selected AI client controls what tool
  results it sends to its model provider.

Review the client configuration before approving it and keep write-capable
tools behind the client's approval policy. See [Security](../SECURITY.md) for
the complete trust model.

## Runtime alternatives

The published bundle is smoke-tested as an MCP stdio server under Node.js, Bun,
and Deno. Replace the command and arguments when Node.js is not your chosen
runtime:

```text
Bun:  bun  ./node_modules/adb-ready/dist/cli.js mcp
Deno: deno run -A ./node_modules/adb-ready/dist/cli.js mcp
```

Deno's `-A` grants the local server the filesystem, process, environment, and
network access required to find project metadata and invoke ADB. Use the
client's sandbox controls when a narrower host boundary is required.
