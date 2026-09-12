import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { xSync } from "tinyexec";

import { readNpmPackEntry } from "./lib/npm-pack-report.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

if (manifest.bin?.["adb-ready"] !== "dist/cli.js" || manifest.bin?.adbr !== "dist/cli.js") {
  throw new Error("adb-ready and adbr must resolve to the same dist/cli.js entrypoint");
}

const packed = xSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  nodeOptions: {
    cwd: root,
    shell: false,
    windowsHide: true,
  },
});

if (packed.exitCode !== 0) {
  throw new Error(`npm pack failed: ${packed.stderr.trim()}`);
}

const report = JSON.parse(packed.stdout);
const packEntry = readNpmPackEntry(report, manifest.name);
const files = Array.isArray(packEntry.files)
  ? packEntry.files
      .map((entry) => (typeof entry === "object" && entry !== null ? entry.path : undefined))
      .filter((entry) => typeof entry === "string")
      .sort()
  : undefined;
if (!Array.isArray(files)) {
  throw new Error("npm pack did not return a file inventory");
}

const forbidden = files.filter((file) =>
  /^(AGENTS\.md|context\/|src\/|scripts\/|tests\/|node_modules\/|bun\.lock$)|\.map$/u.test(file),
);
if (forbidden.length > 0) {
  throw new Error(`private or development files entered the package: ${forbidden.join(", ")}`);
}

for (const required of [
  "CHANGELOG.md",
  "COMPATIBILITY.md",
  "LICENSE",
  "llms.txt",
  "README.md",
  "dist/cli.js",
  "docs/getting-started.md",
  "examples/expo/adb-ready.config.json",
  "package.json",
  "schema/config-v1.schema.json",
  "schema/agent-tools-v1.json",
]) {
  if (!files.includes(required)) {
    throw new Error(`required package file is missing: ${required}`);
  }
}

process.stdout.write(`✓ package contains ${String(files.length)} allowlisted files\n`);
