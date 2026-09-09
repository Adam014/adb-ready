import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

if (manifest.bin?.["adb-ready"] !== "./dist/cli.js" || manifest.bin?.adbr !== "./dist/cli.js") {
  throw new Error("adb-ready and adbr must resolve to the same dist/cli.js entrypoint");
}

const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
  shell: false,
  windowsHide: true,
});

if (packed.error !== undefined) {
  throw packed.error;
}
if (packed.status !== 0) {
  throw new Error(`npm pack failed: ${packed.stderr.trim()}`);
}

/** @type {Array<{ files?: Array<{ path: string }> }>} */
const report = JSON.parse(packed.stdout);
const files = report[0]?.files?.map((entry) => entry.path).sort();
if (!Array.isArray(files)) {
  throw new Error("npm pack did not return a file inventory");
}

const forbidden = files.filter((file) =>
  /^(AGENTS\.md|context\/|src\/|scripts\/|tests\/|node_modules\/|bun\.lock$)/u.test(file),
);
if (forbidden.length > 0) {
  throw new Error(`private or development files entered the package: ${forbidden.join(", ")}`);
}

for (const required of ["README.md", "dist/cli.js", "package.json"]) {
  if (!files.includes(required)) {
    throw new Error(`required package file is missing: ${required}`);
  }
}

process.stdout.write(`✓ package contains ${String(files.length)} allowlisted files\n`);
