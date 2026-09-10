import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Generate the public agent-tool contract from the MCP server's actual
 * tools/list response.
 *
 * @param {{ cli: string, root: string, version: string }} options
 */
export async function generateAgentContract(options) {
  const child = spawn(process.execPath, [options.cli, "mcp"], {
    cwd: options.root,
    env: { ...process.env, ADB_READY_INTERACTIVE: "false", NO_COLOR: "1" },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let closedInput = false;
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "adb-ready-contract-generator", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    const completedResponses = stdout.split(/\r?\n/u).filter(Boolean).length;
    if (!closedInput && completedResponses >= 2) {
      closedInput = true;
      child.stdin.end();
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.stdin.write(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
  const exit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("MCP contract generation timed out"));
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
  if (exit.code !== 0 || stderr !== "") {
    throw new Error(
      `MCP contract generation failed (${exit.signal ?? String(exit.code)}): ${stderr.trim()}`,
    );
  }
  const responses = stdout
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  const tools = responses.find(({ id }) => id === 2)?.result?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error("MCP contract generation returned no tools");
  }
  tools.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const artifact = {
    title: "ADB Ready agent tool contract",
    schemaVersion: 1,
    packageVersion: options.version,
    protocolVersion: "2025-11-25",
    transport: "stdio",
    tools,
  };
  const json = JSON.stringify(artifact, null, 2).replace(
    /\[\n((?:\s+(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null),?\n)+)\s*\]/gu,
    (_match, /** @type {string} */ body) =>
      `[${body
        .trim()
        .split(/\n/u)
        .map((line) => line.trim())
        .join(" ")}]`,
  );
  await writeFile(path.join(options.root, "schema", "agent-tools-v1.json"), `${json}\n`, "utf8");
}
