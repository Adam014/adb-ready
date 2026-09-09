import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
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
  ["npm package allowlist", "bun", ["run", "scripts/package-check.mjs"]],
  ["package manifest lint", "bun", ["x", "--bun", "publint"]],
  ["package type-resolution audit", "bun", ["x", "--bun", "attw", "--pack", "."]],
];

const started = performance.now();
for (const [name, executable, args] of steps) {
  process.stdout.write(`\n◆ ${name}\n`);
  const stepStarted = performance.now();
  const result = spawnSync(executable, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new Error(`${name} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.stderr.write(`\n✕ ${name} failed with exit ${String(result.status)}\n`);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`✓ ${name} (${Math.round(performance.now() - stepStarted)}ms)\n`);
}

process.stdout.write(
  `\n✓ ADB Ready verification passed in ${String(Math.round(performance.now() - started))}ms\n`,
);
