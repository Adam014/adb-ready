import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { changedLineCoverage } from "./lib/changed-coverage.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
/** @param {string} name */
const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const base = valueAfter("--base") ?? process.env.COVERAGE_BASE_SHA;
const head = valueAfter("--head") ?? process.env.COVERAGE_HEAD_SHA;

if (base === undefined || head === undefined || base === "" || head === "") {
  process.stdout.write("Changed-line coverage: skipped (no comparison range)\n");
  process.exit(0);
}

const diff = spawnSync(
  "git",
  ["diff", "--unified=0", "--no-color", `${base}...${head}`, "--", "src", "scripts/lib"],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, shell: false },
);
if (diff.error !== undefined || diff.status !== 0) {
  process.stderr.write(
    `Changed-line coverage could not resolve ${base}...${head}: ${diff.error?.message ?? diff.stderr.trim()}\n`,
  );
  process.exit(1);
}

const result = changedLineCoverage(
  await readFile(new URL("../coverage/lcov.info", import.meta.url), "utf8"),
  diff.stdout,
);
if (result.missingFiles.length > 0) {
  process.stderr.write(
    `Changed-line coverage failed: executable source is absent from LCOV: ${result.missingFiles.join(", ")}\n`,
  );
  process.exit(1);
}

const percent = (result.ratio * 100).toFixed(2);
process.stdout.write(
  `Changed-line coverage: ${percent}% (${String(result.hit)}/${String(result.found)}) across ${String(result.files)} source file(s)\n`,
);
if (result.ratio < 0.95) {
  process.stderr.write("Changed-line coverage is below the required 95.00%.\n");
  process.exit(1);
}
