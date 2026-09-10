import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { xSync } from "tinyexec";

import { readNpmPackEntry } from "./lib/npm-pack-report.mjs";
import { createPackageConsumerEnvironment } from "./lib/package-manager-environment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const temporary = await mkdtemp(path.join(tmpdir(), "adb-ready-package-managers-"));
const consumerNpmConfig = path.join(temporary, "consumer.npmrc");
const tarballArgumentIndex = process.argv.indexOf("--tarball");
const suppliedTarball =
  tarballArgumentIndex === -1 ? undefined : process.argv[tarballArgumentIndex + 1];
const required = new Set(
  (process.env.ADB_READY_REQUIRE_PACKAGE_MANAGERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
await writeFile(consumerNpmConfig, "registry=https://registry.npmjs.org/\n");
const consumerEnvironment = createPackageConsumerEnvironment(process.env, consumerNpmConfig);
const lockedYarnCli = process.env.ADB_READY_YARN_CLI;

/**
 * @param {string} executable
 * @param {readonly string[]} args
 * @param {string} cwd
 */
function run(executable, args, cwd) {
  return xSync(executable, args, {
    nodeOptions: { cwd, env: consumerEnvironment, shell: false, windowsHide: true },
  });
}

/** @param {string} executable @param {readonly string[]} prefix */
function versionOf(executable, prefix) {
  try {
    const result = run(executable, [...prefix, "--version"], temporary);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  } catch (caught) {
    if (caught instanceof Error && "code" in caught && caught.code === "ENOENT") {
      return undefined;
    }
    throw caught;
  }
}

/** @param {string} version */
function isModernYarn(version) {
  const match = /^(\d+)\./u.exec(version);
  if (match?.[1] === undefined) {
    throw new Error(`Yarn returned an invalid version: ${version}`);
  }
  return Number.parseInt(match[1], 10) >= 2;
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

/** @type {Array<{name: string, executable: string, prefix: string[], install: (tarball: string, version: string) => string[], execute: (version: string) => string[]}>} */
const managers = [
  {
    name: "npm",
    executable: "npm",
    prefix: [],
    install: (tarball) => ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    execute: () => ["exec", "--", "adb-ready", "--version"],
  },
  {
    name: "pnpm",
    executable: "pnpm",
    prefix: [],
    install: (tarball) => ["add", "--ignore-scripts", tarball],
    execute: () => ["exec", "adb-ready", "--version"],
  },
  {
    name: "yarn",
    executable: lockedYarnCli === undefined ? "yarn" : "node",
    prefix: lockedYarnCli === undefined ? [] : [path.resolve(lockedYarnCli)],
    install: (tarball, version) =>
      isModernYarn(version) ? ["add", tarball] : ["add", "--ignore-scripts", tarball],
    execute: (version) =>
      isModernYarn(version)
        ? ["run", "adb-ready", "--version"]
        : ["run", "--silent", "adb-ready", "--version"],
  },
  {
    name: "bun",
    executable: "bun",
    prefix: [],
    install: (tarball) => ["add", "--ignore-scripts", tarball],
    execute: () => ["run", "adb-ready", "--version"],
  },
];

try {
  if (tarballArgumentIndex !== -1 && suppliedTarball === undefined) {
    throw new Error("--tarball requires a path");
  }
  const tarball =
    suppliedTarball === undefined
      ? (() => {
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
          return path.join(temporary, filename);
        })()
      : path.resolve(suppliedTarball);
  await access(tarball);
  let tested = 0;

  for (const manager of managers) {
    const version = versionOf(manager.executable, manager.prefix);
    if (version === undefined) {
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
    if (manager.name === "yarn" && isModernYarn(version)) {
      await writeFile(path.join(consumer, ".yarnrc.yml"), "enableScripts: false\n");
    }
    checked(
      manager.executable,
      [...manager.prefix, ...manager.install(tarball, version)],
      consumer,
      `${manager.name} install`,
    );
    const execution = checked(
      manager.executable,
      [...manager.prefix, ...manager.execute(version)],
      consumer,
      `${manager.name} execute`,
    );
    if (execution.stdout.trim() !== manifest.version) {
      throw new Error(`${manager.name} returned unexpected version: ${execution.stdout.trim()}`);
    }
    process.stdout.write(
      `✓ ${manager.name} ${version}: installed artifact and launched adb-ready\n`,
    );
    tested += 1;
  }

  if (tested === 0) {
    throw new Error("no package manager compatibility check could run");
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
