import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), "adb-ready-command-matrix-"));
const fakeAdb = path.join(temp, process.platform === "win32" ? "fake-adb.exe" : "fake-adb");
const consumer = path.join(temp, "consumer");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

/**
 * @param {string} executable
 * @param {readonly string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} options
 */
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return result;
}

/**
 * @param {string} executable
 * @param {readonly string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} options
 */
function checked(executable, args, options = {}) {
  const result = run(executable, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} exited ${String(result.status)}\n${result.stderr}`,
    );
  }
  return result;
}

/**
 * @param {string} alias
 * @param {readonly string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
function command(alias, args, env) {
  const binary = path.join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${alias}.cmd` : alias,
  );
  if (process.platform !== "win32") {
    return run(binary, args, { cwd: consumer, env });
  }

  /** @param {string} value */
  const quote = (value) => `"${value.replaceAll('"', '""')}"`;
  const line = `"${quote(binary)} ${args.map(quote).join(" ")}"`;
  return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", line], {
    cwd: consumer,
    env,
  });
}

/**
 * @param {ReturnType<typeof run>} result
 * @param {number} expected
 * @param {string} label
 */
function expectStatus(result, expected, label) {
  if (result.status !== expected) {
    throw new Error(
      `${label}: expected exit ${String(expected)}, received ${String(result.status)}\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
}

/**
 * @param {string} value
 * @param {string} expected
 * @param {string} label
 */
function expectIncludes(value, expected, label) {
  if (!value.includes(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)} in ${JSON.stringify(value)}`);
  }
}

/**
 * @param {string} value
 * @param {string} label
 * @returns {any}
 */
function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label}: invalid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * @param {ReturnType<typeof run>} result
 * @param {string} label
 */
function assertMachineClean(result, label) {
  if (result.stdout.includes("\u001B") || result.stderr.includes("\u001B")) {
    throw new Error(`${label}: terminal control sequence leaked into machine output`);
  }
}

await mkdir(consumer, { recursive: true });
try {
  checked("bun", [
    "build",
    path.join(root, "tests", "fixtures", "fake-adb.ts"),
    "--compile",
    "--outfile",
    fakeAdb,
  ]);

  const packed = checked(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temp],
    { cwd: root },
  );
  const packReport = parseJson(packed.stdout, "npm pack");
  const filename = packReport[0]?.filename;
  if (typeof filename !== "string") {
    throw new Error("npm pack did not return a package filename");
  }
  const tarball = path.join(temp, filename);
  checked("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: consumer,
  });

  if (manifest.bin?.["adb-ready"] !== "./dist/cli.js" || manifest.bin?.adbr !== "./dist/cli.js") {
    throw new Error("both public command aliases must resolve to dist/cli.js");
  }

  const env = {
    ...process.env,
    ADB_READY_ADB_PATH: fakeAdb,
    ADB_READY_INTERACTIVE: "false",
    ADB_READY_FAKE_SCENARIO: "ready",
    XDG_CONFIG_HOME: path.join(temp, "config"),
    NO_COLOR: "1",
  };
  let assertions = 0;

  for (const alias of ["adb-ready", "adbr"]) {
    for (const [label, args, expected] of [
      ["help flag", ["--help"], "adb-ready [command]"],
      ["help command", ["help"], "ADB Ready"],
      ["doctor help", ["help", "doctor"], "adb-ready doctor"],
      ["devices help", ["devices", "--help"], "adb-ready devices"],
      ["version flag", ["--version"], manifest.version],
      ["version command", ["version"], manifest.version],
    ]) {
      const execution = command(alias, args, env);
      expectStatus(execution, 0, `${alias} ${label}`);
      expectIncludes(execution.stdout, expected, `${alias} ${label}`);
      assertions += 1;
    }

    for (const publicCommand of ["doctor", "devices"]) {
      const execution = command(alias, [publicCommand, "--json"], env);
      expectStatus(execution, 0, `${alias} ${publicCommand} JSON`);
      assertMachineClean(execution, `${alias} ${publicCommand} JSON`);
      const payload = parseJson(execution.stdout, `${alias} ${publicCommand} JSON`);
      if (payload.schemaVersion !== 1 || payload.command !== publicCommand || payload.ok !== true) {
        throw new Error(`${alias} ${publicCommand}: unexpected result envelope`);
      }
      if (execution.stderr !== "") {
        throw new Error(`${alias} ${publicCommand}: JSON mode wrote to stderr`);
      }
      assertions += 1;
    }

    const plain = command(alias, ["devices", "--format", "plain"], env);
    expectStatus(plain, 0, `${alias} devices plain`);
    expectIncludes(plain.stdout, "device_count=1", `${alias} devices plain`);
    assertMachineClean(plain, `${alias} devices plain`);
    assertions += 1;

    const ndjson = command(alias, ["doctor", "--format", "ndjson"], env);
    expectStatus(ndjson, 0, `${alias} doctor NDJSON`);
    assertMachineClean(ndjson, `${alias} doctor NDJSON`);
    const records = ndjson.stdout
      .trim()
      .split("\n")
      .map((line) => parseJson(line, `${alias} doctor NDJSON`));
    if (
      records.at(-1)?.kind !== "result" ||
      !records.slice(0, -1).every(({ kind }) => kind === "event")
    ) {
      throw new Error(`${alias} doctor: invalid NDJSON event/result sequence`);
    }
    assertions += 1;

    /** @type {Array<[string, string[]]>} */
    const failureCases = [
      ["unknown option", ["devices", "--unknown", "--json"]],
      ["interactive machine conflict", ["devices", "--select", "--json"]],
      ["invalid timeout", ["doctor", "--timeout=0", "--json"]],
    ];
    for (const [label, args] of failureCases) {
      const execution = command(alias, args, env);
      expectStatus(execution, 2, `${alias} ${label}`);
      assertMachineClean(execution, `${alias} ${label}`);
      const payload = parseJson(execution.stdout, `${alias} ${label}`);
      if (payload.ok !== false || payload.problems?.length < 1) {
        throw new Error(`${alias} ${label}: expected a structured failure`);
      }
      assertions += 1;
    }
  }

  process.stdout.write(`✓ ${String(assertions)} packaged command-matrix checks passed\n`);
} finally {
  await rm(temp, { force: true, recursive: true });
}
