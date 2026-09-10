import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { xSync } from "tinyexec";

import { readNpmPackEntry } from "./lib/npm-pack-report.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const temporary = await mkdtemp(path.join(tmpdir(), "adb-ready-package-managers-"));
const required = new Set(
  (process.env.ADB_READY_REQUIRE_PACKAGE_MANAGERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

/**
 * @param {string} executable
 * @param {readonly string[]} args
 * @param {string} cwd
 */
function run(executable, args, cwd) {
  return xSync(executable, args, {
    nodeOptions: { cwd, env: process.env, shell: false, windowsHide: true },
  });
}

/** @param {string} executable */
function available(executable) {
  try {
    const result = run(executable, ["--version"], root);
    return result.exitCode === 0;
  } catch (caught) {
    if (caught instanceof Error && "code" in caught && caught.code === "ENOENT") {
      return false;
    }
    throw caught;
  }
}

/**
 * @param {string} executable
 * @param {readonly string[]} args
 * @param {string} cwd
 * @param {string} label
 */
function checked(executable, args, cwd, label) {
  const result = run(executable, args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit ${String(result.exitCode)}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return result;
}

/** @type {Array<{name: string, executable: string, install: (tarball: string) => string[], execute: string[]}>} */
const managers = [
  {
    name: "npm",
    executable: "npm",
    install: (tarball) => ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    execute: ["exec", "--", "adb-ready", "--version"],
  },
  {
    name: "pnpm",
    executable: "pnpm",
    install: (tarball) => ["add", "--ignore-scripts", tarball],
    execute: ["exec", "adb-ready", "--version"],
  },
  {
    name: "yarn",
    executable: "yarn",
    install: (tarball) => ["add", "--ignore-scripts", tarball],
    execute: ["run", "--silent", "adb-ready", "--version"],
  },
  {
    name: "bun",
    executable: "bun",
    install: (tarball) => ["add", "--ignore-scripts", tarball],
    execute: ["run", "adb-ready", "--version"],
  },
];

try {
  const packed = checked(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
    root,
    "npm pack",
  );
  const report = JSON.parse(packed.stdout);
  const filename = readNpmPackEntry(report, manifest.name).filename;
  if (typeof filename !== "string") {
    throw new Error("npm pack did not return an artifact filename");
  }
  const tarball = path.join(temporary, filename);
  let tested = 0;

  for (const manager of managers) {
    if (!available(manager.executable)) {
      if (required.has(manager.name)) {
        throw new Error(`required package manager is unavailable: ${manager.name}`);
      }
      process.stdout.write(`- ${manager.name}: unavailable, skipped locally\n`);
      continue;
    }
    const consumer = path.join(temporary, `consumer-${manager.name}`);
    await mkdir(consumer, { recursive: true });
    await writeFile(
      path.join(consumer, "package.json"),
      `${JSON.stringify({ name: `adb-ready-${manager.name}-smoke`, private: true }, null, 2)}\n`,
    );
    checked(manager.executable, manager.install(tarball), consumer, `${manager.name} install`);
    const execution = checked(
      manager.executable,
      manager.execute,
      consumer,
      `${manager.name} execute`,
    );
    if (execution.stdout.trim() !== manifest.version) {
      throw new Error(`${manager.name} returned unexpected version: ${execution.stdout.trim()}`);
    }
    process.stdout.write(`✓ ${manager.name}: installed artifact and launched adb-ready\n`);
    tested += 1;
  }

  if (tested === 0) {
    throw new Error("no package manager compatibility check could run");
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
