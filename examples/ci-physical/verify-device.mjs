import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 */
function requiredEnvironment(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "" || /[\r\n\0]/u.test(value)) {
    throw new Error(`${name} must be a non-empty single-line value.`);
  }
  return value;
}

/**
 * @param {string} executable
 * @param {string} serial
 * @param {string[]} args
 */
async function defaultAdb(executable, serial, args) {
  const result = await execFile(executable, ["-s", serial, ...args], {
    encoding: "buffer",
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  return Buffer.from(result.stdout);
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv;
 *   runAdb?: (args: string[]) => Promise<Buffer>;
 * }} [options]
 */
export async function verifyPhysicalDevice(options = {}) {
  const env = options.env ?? process.env;
  const serial = requiredEnvironment(env, "ADB_READY_TARGET_SERIAL");
  const androidSerial = requiredEnvironment(env, "ANDROID_SERIAL");
  const outputDirectory = requiredEnvironment(env, "ADB_READY_VERIFIER_OUTPUT_DIR");
  if (serial !== androidSerial) {
    throw new Error("ADB Ready did not bind the verifier to one target.");
  }

  const executable = env.ADB_READY_ADB_PATH?.trim() || "adb";
  /** @param {string[]} args */
  const runDefaultAdb = (args) => defaultAdb(executable, serial, args);
  const runAdb = options.runAdb ?? runDefaultAdb;
  /** @param {string[]} args */
  const text = async (args) => (await runAdb(args)).toString("utf8").trim();

  if ((await text(["get-state"])) !== "device") {
    throw new Error("The selected physical target is not in the device state.");
  }
  if ((await text(["shell", "getprop", "sys.boot_completed"])) !== "1") {
    throw new Error("The selected physical target did not complete Android boot.");
  }
  const apiLevel = await text(["shell", "getprop", "ro.build.version.sdk"]);
  if (!/^\d+$/u.test(apiLevel)) {
    throw new Error("The selected physical target did not expose a valid Android API level.");
  }

  const destination = path.resolve(outputDirectory);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(destination, "verification.json"),
    `${JSON.stringify({ schemaVersion: 1, targetBound: true, state: "device", bootCompleted: true, apiLevel }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { apiLevel };
}

const direct = process.argv[1] === fileURLToPath(import.meta.url);
if (direct) {
  try {
    const result = await verifyPhysicalDevice();
    process.stdout.write(
      `Verified the selected physical Android target (API ${result.apiLevel}).\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
