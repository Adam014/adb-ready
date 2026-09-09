import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const runtimes = [
  { name: "node", executable: "node", args: [cli, "--version"] },
  { name: "bun", executable: "bun", args: [cli, "--version"] },
  { name: "deno", executable: "deno", args: ["run", cli, "--version"] },
];

for (const runtime of runtimes) {
  const result = spawnSync(runtime.executable, runtime.args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });

  if (result.error !== undefined) {
    throw new Error(`${runtime.name} smoke test could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${runtime.name} smoke test exited ${String(result.status)}: ${result.stderr.trim()}`,
    );
  }
  if (result.stdout.trim() !== manifest.version) {
    throw new Error(`${runtime.name} returned unexpected version output: ${result.stdout.trim()}`);
  }

  process.stdout.write(`✓ ${runtime.name}\n`);
}
