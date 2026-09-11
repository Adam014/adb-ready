import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "dist", "cli.js");
const temporary = mkdtempSync(path.join(tmpdir(), "adb-ready-mcp-"));
const fakeAdb = path.join(temporary, process.platform === "win32" ? "fake-adb.exe" : "fake-adb");
const compiledAdb = spawnSync(
  "bun",
  ["build", path.join(root, "tests", "fixtures", "fake-adb.ts"), "--compile", "--outfile", fakeAdb],
  { cwd: root, encoding: "utf8", shell: false, windowsHide: true },
);
if (compiledAdb.error !== undefined || compiledAdb.status !== 0) {
  throw new Error(
    `fake ADB build failed: ${compiledAdb.error?.message ?? compiledAdb.stderr.trim()}`,
  );
}
const runtimes = [
  { name: "node", executable: "node", args: [cli, "mcp"] },
  { name: "bun", executable: "bun", args: [cli, "mcp"] },
  { name: "deno", executable: "deno", args: ["run", "-A", cli, "mcp"] },
];
const protocols = ["2025-11-25", "2026-07-28"];
/** @param {string} protocolVersion */
const requests = (protocolVersion) => {
  const modern = protocolVersion === "2026-07-28";
  const envelope = modern
    ? {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": protocolVersion,
          "io.modelcontextprotocol/clientInfo": { name: "adb-ready-smoke", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      }
    : {};
  return [
    modern
      ? { jsonrpc: "2.0", id: 1, method: "server/discover", params: envelope }
      : {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: "adb-ready-smoke", version: "1" },
          },
        },
    ...(modern ? [] : [{ jsonrpc: "2.0", method: "notifications/initialized" }]),
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: envelope },
    { jsonrpc: "2.0", id: 3, method: "resources/list", params: envelope },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "ensure_ready", arguments: {}, ...envelope },
    },
    { jsonrpc: "2.0", id: 5, method: "resources/templates/list", params: envelope },
    {
      jsonrpc: "2.0",
      id: 6,
      method: "resources/read",
      params: { uri: "adb-ready://targets", ...envelope },
    },
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "capture_screenshot",
        arguments: { out: ".adb-ready/mcp-smoke.png" },
        ...envelope,
      },
    },
    {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "inspect_ui",
        arguments: { targetHandle: "00000000-0000-4000-8000-000000000000" },
        ...envelope,
      },
    },
  ];
};
const requiredTools = [
  "assert_ui",
  "audit_ui",
  "capture_screenshot",
  "clear_ui",
  "compare_ui",
  "compile_debug_context",
  "doctor",
  "ensure_ready",
  "fill_ui",
  "find_ui",
  "get_dev_session",
  "get_session_problems",
  "get_ui",
  "inspect_app",
  "inspect_ui",
  "install_app",
  "launch_app",
  "list_sessions",
  "list_targets",
  "long_press_ui",
  "open_url",
  "press_key_ui",
  "resolve_app",
  "restart_app",
  "scroll_ui",
  "start_dev_session",
  "stop_dev_session",
  "swipe_ui",
  "tap_ui",
  "type_text_ui",
  "wait_for_ui",
];

/** @param {{ name: string, executable: string, args: string[] }} runtime @param {string} protocolVersion */
async function verifyRuntime(runtime, protocolVersion) {
  rmSync(path.join(temporary, ".adb-ready"), { force: true, recursive: true });
  const child = spawn(runtime.executable, runtime.args, {
    cwd: temporary,
    env: {
      ...process.env,
      ADB_READY_ADB_PATH: fakeAdb,
      ADB_READY_FAKE_SCENARIO: "ready",
      ADB_READY_INTERACTIVE: "false",
      NO_COLOR: "1",
      XDG_CONFIG_HOME: path.join(temporary, "config"),
      XDG_STATE_HOME: path.join(temporary, "state"),
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let stdinEnded = false;
  const input = `${requests(protocolVersion)
    .map((request) => JSON.stringify(request))
    .join("\n")}\n`;
  const maximumOutput = 2 * 1024 * 1024;
  /** @param {string} current @param {Buffer} chunk */
  const collect = (current, chunk) => {
    const next = current + chunk.toString("utf8");
    if (Buffer.byteLength(next, "utf8") > maximumOutput) {
      child.kill();
      throw new Error(`${runtime.name} MCP output exceeded 2 MiB`);
    }
    return next;
  };
  child.stdout.on("data", (chunk) => {
    stdout = collect(stdout, chunk);
    const completedResponses = stdout.split(/\r?\n/u).filter(Boolean).length;
    if (!stdinEnded && completedResponses >= 8) {
      stdinEnded = true;
      child.stdin.end();
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = collect(stderr, chunk);
  });
  child.stdin.write(input);

  const exit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${runtime.name} MCP server did not exit after stdin closed`));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

  if (exit.code !== 0) {
    throw new Error(
      `${runtime.name} MCP failed (${exit.signal ?? String(exit.code)}): ${stderr.trim()}`,
    );
  }
  if (stderr !== "") {
    throw new Error(`${runtime.name} MCP wrote unexpected diagnostics: ${stderr.trim()}`);
  }

  const lines = stdout.trim().split(/\r?\n/u);
  if (lines.length !== 8) {
    throw new Error(`${runtime.name} MCP returned ${String(lines.length)} responses, expected 8`);
  }
  const responses = lines.map((line) => JSON.parse(line));
  const opening = responses.find(({ id }) => id === 1)?.result;
  const tools = responses.find(({ id }) => id === 2)?.result?.tools;
  const resources = responses.find(({ id }) => id === 3)?.result?.resources;
  const readiness = responses.find(({ id }) => id === 4)?.result;
  const templates = responses.find(({ id }) => id === 5)?.result?.resourceTemplates;
  const targetResource = responses.find(({ id }) => id === 6)?.result?.contents?.[0];
  const screenshot = responses.find(({ id }) => id === 7)?.result;
  const staleHandle = responses.find(({ id }) => id === 8)?.result;
  const modern = protocolVersion === "2026-07-28";
  const serverInfo = modern
    ? opening?._meta?.["io.modelcontextprotocol/serverInfo"]
    : opening?.serverInfo;
  if (serverInfo?.name !== "adb-ready") {
    throw new Error(`${runtime.name} MCP did not identify ADB Ready`);
  }
  if (
    modern
      ? !opening?.supportedVersions?.includes(protocolVersion)
      : opening?.protocolVersion !== protocolVersion
  ) {
    throw new Error(`${runtime.name} MCP did not negotiate expected protocol ${protocolVersion}`);
  }
  if (!Array.isArray(tools) || !Array.isArray(resources)) {
    throw new Error(`${runtime.name} MCP is missing tools or resources`);
  }
  if (
    !Array.isArray(templates) ||
    !templates.some(({ uriTemplate }) => uriTemplate === "adb-ready://sessions/{sessionId}") ||
    !templates.some(
      ({ uriTemplate }) =>
        uriTemplate === "adb-ready://sessions/{sessionId}/events/{offset}/{limit}",
    ) ||
    !templates.some(({ uriTemplate }) => uriTemplate === "adb-ready://sessions/{sessionId}/context")
  ) {
    throw new Error(`${runtime.name} MCP session resource templates are missing`);
  }
  const targetPayload = JSON.parse(targetResource?.text ?? "null");
  if (
    targetResource?.uri !== "adb-ready://targets" ||
    targetPayload?.data?.targets?.[0]?.serial !== "fixture-usb"
  ) {
    throw new Error(`${runtime.name} MCP target resource is invalid`);
  }

  const toolNames = tools.map(({ name }) => name).sort();
  if (JSON.stringify(toolNames) !== JSON.stringify(requiredTools)) {
    throw new Error(`${runtime.name} MCP exposed unexpected tools: ${toolNames.join(", ")}`);
  }
  if (toolNames.some((name) => /(?:adb|shell|exec|command)/iu.test(name))) {
    throw new Error(`${runtime.name} MCP unexpectedly exposes a raw command surface`);
  }
  if (
    tools.some(
      ({ inputSchema, outputSchema, annotations }) =>
        inputSchema?.type !== "object" ||
        outputSchema?.type !== "object" ||
        !Array.isArray(outputSchema?.required) ||
        !["schemaVersion", "command", "commandId", "ok", "data", "problems"].every((field) =>
          outputSchema.required.includes(field),
        ) ||
        annotations?.openWorldHint !== false ||
        typeof annotations?.readOnlyHint !== "boolean" ||
        typeof annotations?.destructiveHint !== "boolean" ||
        typeof annotations?.idempotentHint !== "boolean",
    )
  ) {
    throw new Error(`${runtime.name} MCP tools are missing schemas or safety annotations`);
  }
  if (!resources.some(({ uri }) => uri === "adb-ready://sessions")) {
    throw new Error(`${runtime.name} MCP saved-session resource is missing`);
  }
  if (
    readiness?.isError === true ||
    readiness?.structuredContent?.ok !== true ||
    readiness?.structuredContent?.data?.selected?.transport?.serial !== "fixture-usb" ||
    typeof readiness?.structuredContent?.data?.targetHandle !== "string"
  ) {
    throw new Error(`${runtime.name} MCP did not bind the only ready target`);
  }
  if (
    screenshot?.isError === true ||
    screenshot?.structuredContent?.ok !== true ||
    !screenshot?.content?.some(
      /** @param {{ type?: string, mimeType?: string, data?: string }} content */
      (content) =>
        content.type === "image" &&
        content.mimeType === "image/png" &&
        (content.data?.length ?? 0) > 0,
    )
  ) {
    throw new Error(`${runtime.name} MCP screenshot did not return image pixels`);
  }
  if (
    staleHandle?.isError !== true ||
    staleHandle?.structuredContent?.problems?.[0]?.code !== "MCP_TARGET_HANDLE_INVALID"
  ) {
    throw new Error(`${runtime.name} MCP accepted a stale target handle`);
  }
  process.stdout.write(
    `✓ ${runtime.name}/${protocolVersion}: schemas, target handle, screenshot pixels, clean protocol\n`,
  );
}

try {
  for (const runtime of runtimes) {
    for (const protocolVersion of protocols) {
      await verifyRuntime(runtime, protocolVersion);
    }
  }
} finally {
  rmSync(temporary, { force: true, recursive: true });
}
