import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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
    maxBuffer: 12 * 1024 * 1024,
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
export async function verifyEmulator(options = {}) {
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
    throw new Error("The selected emulator is not in the device state.");
  }
  if ((await text(["shell", "getprop", "sys.boot_completed"])) !== "1") {
    throw new Error("The selected emulator did not complete Android boot.");
  }

  const apiLevel = await text(["shell", "getprop", "ro.build.version.sdk"]);
  const abi = await text(["shell", "getprop", "ro.product.cpu.abi"]);
  if (!/^\d+$/u.test(apiLevel) || abi === "") {
    throw new Error("The selected emulator did not expose a valid Android identity.");
  }

  await runAdb(["shell", "am", "start", "-W", "-a", "android.settings.SETTINGS"]);
  const windowState = await runAdb(["shell", "dumpsys", "window", "displays"]);
  const screenshot = await runAdb(["exec-out", "screencap", "-p"]);
  if (
    screenshot.length <= PNG_SIGNATURE.length ||
    !screenshot.subarray(0, 8).equals(PNG_SIGNATURE)
  ) {
    throw new Error("The selected emulator did not return a valid PNG screenshot.");
  }

  const destination = path.resolve(outputDirectory);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(path.join(destination, "screen.png"), screenshot, { mode: 0o600 }),
    writeFile(path.join(destination, "window.txt"), windowState, { mode: 0o600 }),
    writeFile(
      path.join(destination, "verification.json"),
      `${JSON.stringify({ schemaVersion: 1, targetBound: true, state: "device", bootCompleted: true, apiLevel, abi, screenshot: "screen.png" }, null, 2)}\n`,
      { mode: 0o600 },
    ),
  ]);

  return { apiLevel, abi, screenshotBytes: screenshot.length };
}

const direct = process.argv[1] === fileURLToPath(import.meta.url);
if (direct) {
  try {
    const result = await verifyEmulator();
    process.stdout.write(
      `Verified the selected Android emulator (API ${result.apiLevel}, ${result.abi}) with a ${String(result.screenshotBytes)} byte screenshot.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
