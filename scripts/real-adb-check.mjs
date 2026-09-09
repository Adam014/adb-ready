import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const cwd = await mkdtemp(path.join(tmpdir(), "adb-ready-real-adb-"));
/** @type {NodeJS.ProcessEnv} */
const env = { ...process.env, XDG_CONFIG_HOME: path.join(cwd, "config") };
for (const key of Object.keys(env)) {
  if (key.startsWith("ADB_READY_")) {
    delete env[key];
  }
}

/** @param {{ code?: unknown }} item */
const problemCode = (item) => String(item.code);

try {
  for (const command of ["doctor", "devices"]) {
    const result = spawnSync("node", [cli, command, "--json", "--non-interactive"], {
      cwd,
      env,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    if (result.error !== undefined) {
      throw result.error;
    }
    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new Error(`${command} did not return valid JSON: ${result.stdout}`);
    }
    if (result.status !== 0 || payload.ok !== true) {
      const codes = payload.problems?.map(problemCode).join(", ") || "unknown failure";
      throw new Error(`${command} failed its read-only real ADB check: ${codes}`);
    }
    const deviceCount = payload.data?.devices?.length ?? 0;
    process.stdout.write(
      `✓ ${command}: ${String(deviceCount)} target(s), no mutations performed\n`,
    );
  }
} finally {
  await rm(cwd, { force: true, recursive: true });
}
