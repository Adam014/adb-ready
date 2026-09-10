import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const useColor =
  process.stdout.isTTY === true &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb";
/** @param {string} code @param {string} value */
const paint = (code, value) => (useColor ? `\u001B[${code}m${value}\u001B[0m` : value);
/** @param {string} value */
const green = (value) => paint("32", value);
/** @param {string} value */
const red = (value) => paint("31", value);
/** @param {string} value */
const dim = (value) => paint("2", value);

/** @type {Array<[string, string, string[]]>} */
const steps = [
  ["diff hygiene", "git", ["diff", "--check"]],
  ["private-context boundary", "bun", ["run", "scripts/privacy-check.mjs"]],
  ["TypeScript", "bun", ["run", "typecheck"]],
  ["Biome", "bun", ["run", "lint"]],
  ["unit and integration tests", "bun", ["test"]],
  ["production build", "bun", ["run", "build"]],
  ["static UI scenarios", "bun", ["run", "scripts/ui-playground.ts", "--all", "--non-interactive"]],
  ["packaged command matrix", "bun", ["run", "scripts/command-matrix.mjs"]],
  ["Node, Bun, and Deno runtime smoke", "bun", ["run", "scripts/runtime-smoke.mjs"]],
  ["available package-manager consumers", "bun", ["run", "scripts/package-manager-smoke.mjs"]],
  ["npm package allowlist", "bun", ["run", "scripts/package-check.mjs"]],
  ["package manifest lint", "bun", ["x", "--bun", "publint"]],
  ["package type-resolution audit", "bun", ["x", "--bun", "attw", "--pack", "."]],
];
const maxNameLength = Math.max(...steps.map(([name]) => name.length));

/** @param {number} milliseconds */
function duration(milliseconds) {
  return milliseconds < 1_000
    ? `${String(Math.round(milliseconds))}ms`
    : `${(milliseconds / 1_000).toFixed(1)}s`;
}

/** @param {string} executable @param {readonly string[]} args */
function commandLine(executable, args) {
  return [executable, ...args]
    .map((argument) =>
      /^[a-zA-Z0-9_./:@=-]+$/u.test(argument) ? argument : JSON.stringify(argument),
    )
    .join(" ");
}

/**
 * @param {string} name
 * @param {string} executable
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnSyncReturns<string>} result
 * @param {number} elapsed
 */
function printFailure(name, executable, args, result, elapsed) {
  process.stdout.write(
    `${name.padEnd(maxNameLength)}  ${red("FAIL")}  ${dim(duration(elapsed))}\n`,
  );
  process.stderr.write(`\n${red("Verification failed")}\n`);
  process.stderr.write(`${dim("Step:")}    ${name}\n`);
  process.stderr.write(`${dim("Command:")} ${commandLine(executable, args)}\n`);
  if (result.error !== undefined) {
    process.stderr.write(`${dim("Error:")}   ${result.error.message}\n`);
  }
  if (result.signal !== null) {
    process.stderr.write(`${dim("Signal:")}  ${result.signal}\n`);
  }
  const stdout = result.stdout?.trimEnd();
  const stderr = result.stderr?.trimEnd();
  if (stdout) {
    process.stderr.write(`\n${dim("stdout")}\n${stdout}\n`);
  }
  if (stderr) {
    process.stderr.write(`\n${dim("stderr")}\n${stderr}\n`);
  }
  process.stderr.write(`\n${dim("Re-run:")} ${commandLine(executable, args)}\n`);
}

const started = performance.now();
process.stdout.write("ADB Ready verification\n\n");
for (const [name, executable, args] of steps) {
  const stepStarted = performance.now();
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    stdio: "pipe",
    shell: false,
    windowsHide: true,
  });
  const elapsed = performance.now() - stepStarted;
  if (result.error !== undefined || result.status !== 0) {
    printFailure(name, executable, args, result, elapsed);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(
    `${name.padEnd(maxNameLength)}  ${green("OK")}    ${dim(duration(elapsed))}\n`,
  );
}

process.stdout.write(
  `\n${green("PASS")}  ${String(steps.length)} checks in ${duration(performance.now() - started)}\n`,
);
