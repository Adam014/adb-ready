import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RESULT_PATH = path.join(".adb-ready", "ci-result.ndjson");

/**
 * @param {NodeJS.ProcessEnv} env
 */
export function physicalRunArguments(env = process.env) {
  const serial = env.ADB_READY_DEVICE_SERIAL;
  if (typeof serial !== "string" || serial.trim() === "" || /[\r\n\0]/u.test(serial)) {
    throw new Error(
      "ADB_READY_DEVICE_SERIAL must name one pre-authorized Android target on this runner.",
    );
  }
  return [
    "dist/cli.js",
    "run",
    "--config",
    "examples/ci-physical/adb-ready.config.json",
    "--device",
    serial,
    "--run-timeout",
    "10m",
    "--format",
    "ndjson",
    "--non-interactive",
    "--",
    process.execPath,
    "examples/ci-physical/verify-device.mjs",
  ];
}

/** @param {NodeJS.ProcessEnv} env */
export async function runPhysicalJob(env = process.env) {
  const args = physicalRunArguments(env);
  mkdirSync(path.dirname(RESULT_PATH), { recursive: true, mode: 0o700 });
  const output = openSync(RESULT_PATH, "w", 0o600);
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", output, "inherit"],
    windowsHide: true,
  });

  /** @param {NodeJS.Signals} signal */
  const forward = (signal) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const forwardInterrupt = () => forward("SIGINT");
  const forwardTermination = () => forward("SIGTERM");
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    process.removeListener("SIGINT", forwardInterrupt);
    process.removeListener("SIGTERM", forwardTermination);
    closeSync(output);
  }
}

const direct = process.argv[1] === fileURLToPath(import.meta.url);
if (direct) {
  try {
    const result = await runPhysicalJob();
    process.exitCode = result.code ?? (result.signal === "SIGINT" ? 130 : 1);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
