import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { xSync } from "tinyexec";

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
  const result = xSync(executable, args, {
    nodeOptions: {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
    },
  });
  return { ...result, status: result.exitCode ?? null };
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
  const binary = path.join(consumer, "node_modules", ".bin", alias);
  return run(binary, args, { cwd: consumer, env });
}

/**
 * @param {{ status: number | null, stdout: string, stderr: string }} result
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

  if (manifest.bin?.["adb-ready"] !== "dist/cli.js" || manifest.bin?.adbr !== "dist/cli.js") {
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
  const profileConfig = path.join(consumer, "profile-config.json");
  const devConfig = path.join(consumer, "dev-config.json");
  await writeFile(
    profileConfig,
    `${JSON.stringify(
      {
        version: 1,
        profiles: {
          desk: { targets: { aliases: { pixel: "fixture-usb" } } },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    devConfig,
    `${JSON.stringify(
      {
        version: 1,
        dev: {
          journal: { redactEnvironment: ["ADB_READY_FIXTURE_SECRET"] },
          hooks: {
            onReady: [
              {
                run: [
                  process.execPath,
                  "-e",
                  "process.stdout.write('hook=' + process.env.ADB_READY_FIXTURE_SECRET)",
                ],
                envAllowlist: ["ADB_READY_FIXTURE_SECRET"],
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  let assertions = 0;

  const installedCli = path.join(consumer, "node_modules", "adb-ready", "dist", "cli.js");
  const pairingCode = "739201";
  const securePair = spawnSync(
    process.execPath,
    [
      installedCli,
      "pair",
      "192.0.2.10:41234",
      "--pairing-code-stdin",
      "--json",
      "--non-interactive",
    ],
    {
      cwd: consumer,
      env,
      input: `${pairingCode}\n`,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    },
  );
  if (securePair.error !== undefined) {
    throw new Error(`secure packaged pair could not start: ${securePair.error.message}`);
  }
  expectStatus(securePair, 0, "secure packaged pair");
  const securePairPayload = parseJson(securePair.stdout, "secure packaged pair");
  if (securePairPayload.data?.paired !== true || securePairPayload.data?.endpoint === undefined) {
    throw new Error("secure packaged pair did not return a successful paired result");
  }
  if (`${securePair.stdout}\n${securePair.stderr}`.includes(pairingCode)) {
    throw new Error("secure packaged pair leaked its pairing code");
  }
  assertions += 1;

  for (const alias of ["adb-ready", "adbr"]) {
    for (const [label, args, expected] of [
      ["bare non-TTY", [], "ADB Ready"],
      ["help flag", ["--help"], "adb-ready [command]"],
      ["help command", ["help"], "ADB Ready"],
      ["doctor help", ["help", "doctor"], "adb-ready doctor"],
      ["devices help", ["devices", "--help"], "adb-ready devices"],
      ["connect help", ["connect", "--help"], "adb-ready connect"],
      ["dev help", ["dev", "--help"], "adb-ready dev"],
      ["pair help", ["help", "pair"], "adb-ready pair"],
      ["ports help", ["ports", "--help"], "adb-ready ports reverse"],
      ["version flag", ["--version"], manifest.version],
      ["version command", ["version"], manifest.version],
    ]) {
      const execution = command(alias, args, env);
      expectStatus(execution, 0, `${alias} ${label}`);
      expectIncludes(execution.stdout, expected, `${alias} ${label}`);
      assertions += 1;
    }

    const connect = command(
      alias,
      ["connect", "192.0.2.10:37123", "--json", "--non-interactive"],
      env,
    );
    expectStatus(connect, 0, `${alias} connect JSON`);
    const connectPayload = parseJson(connect.stdout, `${alias} connect JSON`);
    if (connectPayload.data?.serial !== "192.0.2.10:37123") {
      throw new Error(`${alias} connect: final serial was not verified`);
    }
    assertions += 1;

    const profileSelection = command(
      alias,
      ["devices", "--config", profileConfig, "--profile", "desk", "--device", "pixel", "--json"],
      env,
    );
    expectStatus(profileSelection, 0, `${alias} named profile`);
    const profilePayload = parseJson(profileSelection.stdout, `${alias} named profile`);
    if (profilePayload.data?.selected?.transport?.serial !== "fixture-usb") {
      throw new Error(`${alias} named profile: configured alias was not selected`);
    }
    assertions += 1;

    const pairWithoutInput = command(alias, ["pair", "--json", "--non-interactive"], env);
    expectStatus(pairWithoutInput, 2, `${alias} pair secure-input requirement`);
    const pairPayload = parseJson(pairWithoutInput.stdout, `${alias} pair input failure`);
    if (pairPayload.problems?.[0]?.code !== "INVALID_PAIRING_CODE") {
      throw new Error(`${alias} pair: missing secure-input diagnostic`);
    }
    assertions += 1;

    const pairPlan = command(
      alias,
      ["pair", "192.0.2.10:41234", "--dry-run", "--json", "--non-interactive"],
      env,
    );
    expectStatus(pairPlan, 0, `${alias} pair dry-run`);
    const planPayload = parseJson(pairPlan.stdout, `${alias} pair dry-run`);
    if (
      planPayload.data?.plan?.dryRun !== true ||
      planPayload.data.plan.steps?.[0]?.id !== "pair"
    ) {
      throw new Error(`${alias} pair: invalid dry-run plan`);
    }
    assertions += 1;

    const ports = command(alias, ["ports", "reverse", "list", "--json", "--non-interactive"], env);
    expectStatus(ports, 0, `${alias} ports reverse list`);
    const portsPayload = parseJson(ports.stdout, `${alias} ports reverse list`);
    if (
      portsPayload.data?.direction !== "reverse" ||
      portsPayload.data?.status !== "listed" ||
      portsPayload.data?.selected?.transport?.serial !== "fixture-usb"
    ) {
      throw new Error(`${alias} ports: unexpected mapping result`);
    }
    assertions += 1;

    const portsPlan = command(
      alias,
      ["ports", "reverse", "add", "8081", "--dry-run", "--json", "--non-interactive"],
      env,
    );
    expectStatus(portsPlan, 0, `${alias} ports reverse dry-run`);
    const portsPlanPayload = parseJson(portsPlan.stdout, `${alias} ports reverse dry-run`);
    if (
      portsPlanPayload.data?.plan?.steps?.[0]?.args?.join(" ") !==
      "-t 1 reverse --no-rebind tcp:8081 tcp:8081"
    ) {
      throw new Error(`${alias} ports: invalid dry-run plan`);
    }
    assertions += 1;

    const dev = command(
      alias,
      [
        "dev",
        "--config",
        devConfig,
        "--no-logs",
        "--json",
        "--non-interactive",
        "--",
        process.execPath,
        "-e",
        "process.stdout.write('target=' + process.env.ANDROID_SERIAL)",
      ],
      { ...env, ADB_READY_FIXTURE_SECRET: "packaged-private-value" },
    );
    expectStatus(dev, 0, `${alias} custom dev`);
    const devPayload = parseJson(dev.stdout, `${alias} custom dev`);
    const devEvents = /** @type {Array<{type?: string, message?: string}>} */ (
      devPayload.data?.journal?.events ?? []
    );
    if (
      devPayload.data?.preset !== "custom" ||
      devPayload.data?.child?.exitCode !== 0 ||
      devPayload.data?.hooks?.completed !== 1 ||
      !devEvents.some(
        (event) => event.type === "child.stdout" && event.message === "target=fixture-usb",
      ) ||
      !devEvents.some(
        (event) => event.type === "hook.stdout" && event.message === "hook=[REDACTED]",
      ) ||
      dev.stdout.includes("packaged-private-value")
    ) {
      throw new Error(
        `${alias} dev: target propagation, configured hook, or journal redaction failed`,
      );
    }
    assertions += 1;

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
    expectIncludes(plain.stdout, "target_count=1", `${alias} devices plain`);
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
