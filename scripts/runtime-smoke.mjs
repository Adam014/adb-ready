import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "dist", "cli.js");
const fakeAdbSource = path.join(root, "tests", "fixtures", "fake-adb.ts");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const temporary = mkdtempSync(path.join(tmpdir(), "adb-ready-runtime-"));
const fakeAdb = path.join(temporary, process.platform === "win32" ? "fake-adb.exe" : "fake-adb");

const compiledAdb = spawnSync("bun", ["build", fakeAdbSource, "--compile", "--outfile", fakeAdb], {
  cwd: root,
  encoding: "utf8",
  shell: false,
  windowsHide: true,
});
if (compiledAdb.error !== undefined || compiledAdb.status !== 0) {
  throw new Error(
    `fake ADB build failed: ${compiledAdb.error?.message ?? compiledAdb.stderr.trim()}`,
  );
}

const runtimes = [
  { name: "node", executable: "node", prefix: [cli] },
  { name: "bun", executable: "bun", prefix: [cli] },
  { name: "deno", executable: "deno", prefix: ["run", "-A", cli] },
];
const environment = {
  ...process.env,
  ADB_READY_ADB_PATH: fakeAdb,
  ADB_READY_FAKE_SCENARIO: "ready",
  ADB_READY_INTERACTIVE: "false",
  NO_COLOR: "1",
  XDG_CONFIG_HOME: path.join(temporary, "config"),
};

/**
 * @typedef {{ name: string, executable: string, prefix: string[] }} Runtime
 */

/**
 * @param {Runtime} runtime
 * @param {string[]} args
 */
function invoke(runtime, args) {
  return spawnSync(runtime.executable, [...runtime.prefix, ...args], {
    cwd: temporary,
    encoding: "utf8",
    env: environment,
    shell: false,
    windowsHide: true,
  });
}

/**
 * @param {Runtime} runtime
 * @param {string} label
 * @param {import("node:child_process").SpawnSyncReturns<string>} execution
 */
function expectSuccess(runtime, label, execution) {
  if (execution.error !== undefined || execution.status !== 0) {
    throw new Error(
      `${runtime.name} ${label} failed: ${execution.error?.message ?? execution.stderr.trim()}`,
    );
  }
}

try {
  for (const runtime of runtimes) {
    const version = invoke(runtime, ["--version"]);
    expectSuccess(runtime, "version", version);
    if (version.stdout.trim() !== manifest.version) {
      throw new Error(
        `${runtime.name} returned unexpected version output: ${version.stdout.trim()}`,
      );
    }

    const dev = invoke(runtime, [
      "dev",
      "--no-logs",
      "--json",
      "--non-interactive",
      "--",
      "node",
      "-e",
      "process.stdout.write('target=' + process.env.ANDROID_SERIAL)",
    ]);
    expectSuccess(runtime, "dev", dev);
    const payload = JSON.parse(dev.stdout);
    if (
      payload.data?.selected?.transport?.serial !== "fixture-usb" ||
      payload.data?.child?.exitCode !== 0 ||
      !payload.data?.journal?.events?.some(
        /** @param {{ type?: string, message?: string }} event */ (event) =>
          event.type === "child.stdout" && event.message === "target=fixture-usb",
      )
    ) {
      throw new Error(`${runtime.name} dev did not preserve the selected target and child output`);
    }

    const plan = invoke(runtime, [
      "dev",
      "--port",
      "8081",
      "--dry-run",
      "--json",
      "--non-interactive",
      "--",
      "node",
      "-e",
      "process.exit(99)",
    ]);
    expectSuccess(runtime, "dev dry-run", plan);
    const planPayload = JSON.parse(plan.stdout);
    if (
      planPayload.data?.status !== "planned" ||
      planPayload.data?.plan?.steps?.[0]?.args?.join(" ") !==
        "-t 1 reverse --no-rebind tcp:8081 tcp:8081" ||
      planPayload.data?.child !== undefined
    ) {
      throw new Error(`${runtime.name} dev returned an invalid dry-run plan`);
    }

    const uiPlan = invoke(runtime, [
      "ui",
      "press",
      "back",
      "--dry-run",
      "--json",
      "--non-interactive",
    ]);
    expectSuccess(runtime, "UI dry-run", uiPlan);
    const uiPayload = JSON.parse(uiPlan.stdout);
    if (
      uiPayload.data?.status !== "planned" ||
      uiPayload.data?.plan?.steps?.[0]?.args?.join(" ") !== "-t 1 shell input keyevent 4"
    ) {
      throw new Error(`${runtime.name} UI returned an invalid dry-run plan`);
    }

    const failedChild = invoke(runtime, [
      "dev",
      "--no-logs",
      "--json",
      "--non-interactive",
      "--",
      "node",
      "-e",
      "process.exit(23)",
    ]);
    if (failedChild.error !== undefined || failedChild.status !== 23) {
      throw new Error(
        `${runtime.name} dev did not preserve child exit 23: ${failedChild.error?.message ?? String(failedChild.status)}`,
      );
    }
    const failedPayload = JSON.parse(failedChild.stdout);
    if (failedPayload.ok !== false || failedPayload.data?.child?.exitCode !== 23) {
      throw new Error(`${runtime.name} dev did not report its failed child structurally`);
    }

    process.stdout.write(
      `✓ ${runtime.name}: version, dev, UI, target propagation, journal, dry-run, child exit\n`,
    );
  }
} finally {
  rmSync(temporary, { force: true, recursive: true });
}
