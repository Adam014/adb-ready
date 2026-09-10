import { randomUUID } from "node:crypto";
import process from "node:process";
import manifest from "../../package.json" with { type: "json" };
import type { AdbMdnsService } from "../adb/parsers.js";
import {
  type CommandDependencies,
  type CommandExecution,
  type DevData,
  type DevicesData,
  type LogsData,
  type PortsData,
  runConnect,
  runDev,
  runDevices,
  runDoctor,
  runLogs,
  runPair,
  runPorts,
  runWirelessDiscovery,
} from "../app/commands.js";
import { runConfigReport, runInit } from "../app/config-commands.js";
import {
  runContextCommand,
  runProblemsCommand,
  runSessionCommand,
} from "../app/session-commands.js";
import { loadConfig } from "../config/loader.js";
import type { ConfigError, ConfigValues } from "../config/types.js";
import { EventBus } from "../core/event-bus.js";
import { redactText } from "../core/redaction.js";
import {
  ExitCode,
  type Problem,
  type ResultEnvelope,
  SCHEMA_VERSION,
} from "../domain/contracts.js";
import { ProblemCode } from "../domain/problems.js";
import { planTargetAcquisition } from "../session/target-acquisition.js";
import type { SessionStoreOptions } from "../state/session-store.js";
import {
  type RememberedTarget,
  readTargetState,
  rememberedTarget,
  writeRememberedTarget,
} from "../state/target-state.js";
import type { AndroidTarget } from "../target/model.js";
import { clearInteractiveScreen, showHomeScreen } from "../ui/home.js";
import { readPairingCode } from "../ui/pairing-code.js";
import { ProgressRenderer } from "../ui/progress-renderer.js";
import { NdjsonEventRenderer, renderResult } from "../ui/result-renderer.js";
import { type SelectInput, selectOne } from "../ui/select.js";
import type { TextSink } from "../ui/spinner.js";
import { resolveTerminalCapabilities, type TerminalCapabilities } from "../ui/terminal.js";
import { type CliOptions, type OutputFormat, parseArguments } from "./arguments.js";

export const VERSION = manifest.version;

export const HELP = `ADB Ready

Make an Android target ready, then keep the development session working.

Usage:
  adb-ready [command] [options]
  adbr [command] [options]

Commands:
  config ACTION          Validate or explain resolved configuration
  connect [HOST:PORT]    Connect and verify a wireless Android target
  context [SESSION]      Export bounded AI-ready diagnostic context
  dev [OPTIONS] [-- CMD] Prepare one target and run a development session
  doctor                 Inspect the local ADB environment
  init                   Create a detected project configuration
  devices                List visible Android targets
  logs [OPTIONS]         Stream focused logs from one Android target
  pair [HOST:PORT]       Pair using Android's six-digit pairing code
  ports DIRECTION ACTION Manage verified TCP forward/reverse mappings
  sessions [ACTION]      Inspect saved development sessions
  problems [SESSION]     Show problems from a saved session
  help [COMMAND]         Show help
  version                Show version

Output:
  --format FORMAT        human, plain, json, or ndjson
  --json                 Alias for --format json
  --quiet                Hide successful human output
  --verbose              Include diagnostic evidence
  --[no-]color           Override color detection
  --[no-]unicode         Override Unicode detection
  --[no-]animation       Override motion detection

Execution:
  --non-interactive      Never prompt or control the terminal
  --timeout DURATION     Positive duration such as 500ms, 5s, or 1m
  --adb PATH             Use an explicit ADB executable
  --adb-host HOST        Use an explicit ADB server host
  --adb-port PORT        Use an explicit ADB server port
  --config PATH          Use an explicit project configuration file
  --profile NAME         Use a named configuration profile
  --select               Interactively select a target
  -s, --device SELECTOR  Select an exact serial or configured alias
  --transport-id ID      Select an exact ADB transport ID
  --last                 Select the last successfully verified target
  --pairing-code-stdin   Read the pairing code from stdin without echoing it
  --dry-run              Show mutating operations without changing state

Other:
  -h, --help             Show help
  -V, --version          Show version
`;

const COMMAND_HELP = {
  config: `Usage:
  adb-ready config validate [options]
  adb-ready config explain [options]

Validates all configuration layers or explains every resolved value and its
winning source. Use --config PATH and --profile NAME for explicit inspection.
`,
  connect: `Usage: adb-ready connect [HOST:PORT] [options]

Connects a TLS/legacy wireless endpoint and verifies its stable ADB serial.
When the endpoint is omitted, exactly one mDNS connect service must be visible.
`,
  context: `Usage: adb-ready context [SESSION] [options]

Exports a bounded, redacted Markdown brief for AI-assisted debugging. The
latest session is used when no ID is provided.

Context options:
  --budget CHARACTERS    Maximum Markdown size (default: 12000, minimum: 1000)
  --format FORMAT        markdown (default), json, plain, or ndjson
`,
  dev: `Usage: adb-ready dev [options] [-- EXECUTABLE ARG...]

Selects one Android target, verifies reverse ports, starts an Expo, React
Native, native Gradle, or custom command with ANDROID_SERIAL, and correlates
child output with targeted logcat. Ctrl-C stops owned processes and removes
only mappings created by this session.

Development options:
  --preset NAME          expo, react-native, gradle, or custom
  --package-manager PM   npm, pnpm, yarn, or bun
  --port PORT            Add a reverse TCP port; repeat for more ports
  --[no-]logs            Enable or disable targeted logcat
  --[no-]cleanup-ports   Keep or remove session-created mappings on exit
  -- EXECUTABLE ARG...   Run a direct custom command without a shell
`,
  doctor: `Usage: adb-ready doctor [options]

Runs read-only host, ADB capability, server, and target diagnostics.
`,
  init: `Usage: adb-ready init [options]

Creates adb-ready.config.json from detected project signals. Existing files are
never replaced unless --force is explicit. Use --dry-run to preview the file.
`,
  devices: `Usage: adb-ready devices [options]

Lists every target visible to ADB. Add --select to open the keyboard picker.
`,
  logs: `Usage: adb-ready logs [options]

Streams parsed, redacted logcat records from one deterministic target.

Log options:
  --package NAME         Resolve and filter the currently running app process
  --pid PID              Filter one explicit process ID
  --tag TAG              Include a log tag; repeat for more tags
  --exclude-tag TAG      Suppress a log tag; repeat for more tags
  --level PRIORITY       V, D, I, W, E, F, A, or S (default: I)
  --buffer NAME          Read main, system, or crash; repeat for more
  --tail COUNT           Start with the most recent record count
  --since TIMESTAMP      Start at an Android logcat timestamp
  --dump                 Read the current buffer and exit instead of following
  --max-records COUNT    Bound records retained in the final result
`,
  pair: `Usage: adb-ready pair [HOST:PORT] [options]

Pairs with Android Wireless debugging using a hidden six-digit code prompt.
For automation, pipe the code and add --pairing-code-stdin.
`,
  ports: `Usage:
  adb-ready ports reverse list [options]
  adb-ready ports reverse add DEVICE_PORT [HOST_PORT] [options]
  adb-ready ports reverse remove DEVICE_PORT [options]
  adb-ready ports forward list [options]
  adb-ready ports forward add HOST_PORT [DEVICE_PORT] [options]
  adb-ready ports forward remove HOST_PORT [options]

Manages TCP mappings for one deterministic Android target. A missing second
port means the same port on both sides. Add is idempotent and never overwrites
an existing mapping. Use --dry-run to inspect the exact ADB plan.
`,
  problems: `Usage: adb-ready problems [SESSION] [options]

Shows structured problems from a saved session. The latest session is used
when no ID is provided.
`,
  sessions: `Usage:
  adb-ready sessions list [options]
  adb-ready sessions show [SESSION] [options]
  adb-ready sessions events [SESSION] [options]

Inspects private, redacted development history. Show and events use the latest
session when no ID is provided.
`,
} as const;

export interface CliInput extends SelectInput {
  isTTY?: boolean;
}

export interface CliOutput extends TextSink {
  isTTY?: boolean;
  columns?: number;
}

export interface CliIo {
  input: CliInput;
  output: CliOutput;
  error: CliOutput;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface CliDependencies extends CommandDependencies {
  loadConfig?: typeof loadConfig;
  readTargetState?: typeof readTargetState;
  writeRememberedTarget?: typeof writeRememberedTarget;
  sessionStore?: false | SessionStoreOptions;
}

function inferredFormat(argv: readonly string[]): OutputFormat {
  let format: OutputFormat = "human";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      format = "json";
    } else if (argument?.startsWith("--format=")) {
      const value = argument.slice("--format=".length);
      if (
        value === "human" ||
        value === "plain" ||
        value === "markdown" ||
        value === "json" ||
        value === "ndjson"
      ) {
        format = value;
      }
    } else if (argument === "--format") {
      const value = argv[index + 1];
      if (
        value === "human" ||
        value === "plain" ||
        value === "markdown" ||
        value === "json" ||
        value === "ndjson"
      ) {
        format = value;
      }
      index += 1;
    }
  }
  return format;
}

function capabilities(
  options: CliOptions | undefined,
  values: ConfigValues,
  io: CliIo,
  target: "error" | "output",
  fallbackFormat: OutputFormat,
): TerminalCapabilities {
  const stream = target === "error" ? io.error : io.output;
  return resolveTerminalCapabilities({
    format: options?.format ?? fallbackFormat,
    nonInteractive: options?.nonInteractive === true || values.interactive === false,
    ...(values.color === undefined ? {} : { color: values.color }),
    ...(values.unicode === undefined ? {} : { unicode: values.unicode }),
    ...(values.animation === undefined ? {} : { animation: values.animation }),
    ...(values.interactive === undefined ? {} : { interactive: values.interactive }),
    env: io.env,
    inputIsTTY: io.input.isTTY === true,
    outputIsTTY: stream.isTTY === true,
    ...(stream.columns === undefined ? {} : { columns: stream.columns }),
  });
}

function failureResult(
  command: string,
  problems: Problem[],
  dependencies: CliDependencies,
): ResultEnvelope<null> {
  const clock = dependencies.clock ?? (() => new Date());
  const now = clock();
  const commandId = (dependencies.idFactory ?? randomUUID)();
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    commandId,
    ok: false,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    durationMs: 0,
    data: null,
    problems: problems.map((problem) => ({
      ...problem,
      correlation: { ...problem.correlation, commandId },
    })),
  };
}

function inputProblem(code: string, summary: string, detail: string, commandId = "cli"): Problem {
  return {
    code,
    category: "input.cli",
    severity: "error",
    summary,
    detail,
    retryable: true,
    evidence: [],
    actions: [],
    correlation: { commandId },
  };
}

function configProblems(errors: readonly ConfigError[]): Problem[] {
  return errors.map((error) => ({
    code: error.code,
    category: "input.configuration",
    severity: "error",
    summary: error.message,
    detail: `Invalid ${error.source} configuration at ${error.path}.`,
    retryable: true,
    evidence: [
      { source: "configuration", field: "path", value: error.path },
      ...(error.location === undefined
        ? []
        : [
            {
              source: "configuration",
              field: "location",
              value: redactText(error.location).value,
            } as const,
          ]),
    ],
    actions: [],
    correlation: { commandId: "configuration" },
  }));
}

function renderFailure(result: ResultEnvelope<null>, format: OutputFormat, io: CliIo): void {
  renderResult(result, {
    format,
    capabilities: capabilities(undefined, {}, io, "output", format),
    sink: format === "human" ? io.error : io.output,
    verbose: false,
  });
}

function cliConfig(options: CliOptions): ConfigValues {
  return {
    ...(options.adbPath === undefined ? {} : { adbPath: options.adbPath }),
    ...(options.adbHost === undefined ? {} : { adbHost: options.adbHost }),
    ...(options.adbPort === undefined ? {} : { adbPort: options.adbPort }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.color === undefined ? {} : { color: options.color }),
    ...(options.unicode === undefined ? {} : { unicode: options.unicode }),
    ...(options.animation === undefined ? {} : { animation: options.animation }),
    ...(options.nonInteractive ? { interactive: false } : {}),
    ...(options.preset === undefined ? {} : { devPreset: options.preset }),
    ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
    ...(options.reversePorts === undefined
      ? {}
      : { devReversePorts: options.reversePorts.map((device) => ({ device: Number(device) })) }),
    ...(options.logs === undefined ? {} : { devLogs: options.logs }),
    ...(options.cleanupPorts === undefined ? {} : { devCleanupPorts: options.cleanupPorts }),
    ...(options.customCommand === undefined ? {} : { devCommand: options.customCommand }),
  };
}

function selectionProblem(
  result: SelectResultKind,
  commandId: string,
): { problem: Problem; exitCode: ExitCode } {
  if (result === "interrupt" || result === "signal") {
    return {
      problem: inputProblem(
        ProblemCode.OperationInterrupted,
        "Target selection was interrupted.",
        "Run the command again when you are ready to select a target.",
        commandId,
      ),
      exitCode: ExitCode.Interrupted,
    };
  }
  if (result === "unavailable") {
    return {
      problem: inputProblem(
        ProblemCode.InteractiveSelectionUnavailable,
        "Interactive target selection is unavailable.",
        "Run this command in a capable terminal or omit --select.",
        commandId,
      ),
      exitCode: ExitCode.InvalidInput,
    };
  }
  return {
    problem: inputProblem(
      ProblemCode.TargetSelectionCancelled,
      "Target selection was cancelled.",
      "No target was selected.",
      commandId,
    ),
    exitCode: ExitCode.InvalidInput,
  };
}

type SelectResultKind = "escape" | "interrupt" | "signal" | "unavailable";

async function runInteractiveSession(
  io: CliIo,
  dependencies: CliDependencies,
  terminal: TerminalCapabilities,
  signal?: AbortSignal,
): Promise<number> {
  let presentation: "full" | "menu" = "full";

  while (true) {
    const home = await showHomeScreen({
      version: VERSION,
      input: io.input,
      sink: io.error,
      capabilities: terminal,
      presentation,
      ...(signal === undefined ? {} : { signal }),
    });
    if (home.kind === "cancelled") {
      return ExitCode.Interrupted;
    }
    if (home.kind !== "action") {
      return ExitCode.InvalidInput;
    }
    if (home.action === "exit") {
      return ExitCode.Success;
    }

    clearInteractiveScreen(io.error, terminal);
    await runCliInternal([home.action], io, dependencies, signal);
    if (signal?.aborted === true) {
      return ExitCode.Interrupted;
    }
    presentation = "menu";
  }
}

function targetDescription(target: AndroidTarget): string {
  const transports = target.transports.map(({ kind }) => kind).join(", ");
  return `${target.serial} · ${target.state} · ${transports}`;
}

function discoveredCandidates(service: AdbMdnsService): string[] {
  return [
    ...new Set([
      service.endpoint.serial,
      ...(service.alternateEndpoints ?? []).map(({ serial }) => serial),
    ]),
  ].slice(0, 3);
}

async function selectDevice(
  execution: CommandExecution<DevicesData>,
  io: CliIo,
  terminal: TerminalCapabilities,
  remembered?: RememberedTarget,
  signal?: AbortSignal,
): Promise<CommandExecution<DevicesData>> {
  const data = execution.result.data;
  if (data === null) {
    return execution;
  }
  const selectable = data.targets.filter((target) =>
    target.transports.some(({ stable, state }) => stable && state === "device"),
  );
  if (selectable.length === 0) {
    const problem = inputProblem(
      ProblemCode.NoSelectableTarget,
      "No ready Android target can be selected.",
      "Connect or recover a target until ADB reports the device state.",
      execution.result.commandId,
    );
    return {
      exitCode: ExitCode.Target,
      result: { ...execution.result, ok: false, problems: [...execution.result.problems, problem] },
    };
  }

  const selection = await selectOne({
    title: "Select an Android target",
    options: data.targets.map((target) => ({
      value: target,
      label: target.name,
      description: targetDescription(target),
      disabled: !target.transports.some(({ stable, state }) => stable && state === "device"),
      recommended:
        target.transports.some(({ serial }) => serial === remembered?.serial) ||
        (remembered?.hardwareSerial !== undefined &&
          target.hardwareSerial === remembered.hardwareSerial) ||
        (selectable.length === 1 && target.id === selectable[0]?.id),
    })),
    input: io.input,
    sink: io.error,
    capabilities: terminal,
    ...(signal === undefined ? {} : { signal }),
  });

  if (selection.kind === "selected") {
    const transport = selection.value.transports.find(
      ({ stable, state }) => stable && state === "device",
    );
    if (transport === undefined) {
      return execution;
    }
    return {
      ...execution,
      result: {
        ...execution.result,
        data: {
          ...data,
          selected: { target: selection.value, transport, reason: "explicit" },
        },
      },
    };
  }

  const failure = selectionProblem(
    selection.kind === "unavailable" ? "unavailable" : selection.reason,
    execution.result.commandId,
  );
  return {
    exitCode: failure.exitCode,
    result: {
      ...execution.result,
      ok: false,
      problems: [...execution.result.problems, failure.problem],
    },
  };
}

async function runCliInternal(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies = {},
  signal?: AbortSignal,
): Promise<number> {
  const fallbackFormat = inferredFormat(argv);
  let effectiveArgv = argv;
  if (argv.length === 0) {
    const homeCapabilities = capabilities(undefined, {}, io, "error", "human");
    if (homeCapabilities.interactive) {
      return await runInteractiveSession(io, dependencies, homeCapabilities, signal);
    } else {
      effectiveArgv = ["help"];
    }
  }

  const parsed = parseArguments(effectiveArgv);
  if (!parsed.ok) {
    const failure = failureResult(
      "cli",
      [inputProblem(parsed.code, parsed.message, "Run adb-ready --help for usage.")],
      dependencies,
    );
    renderFailure(failure, fallbackFormat, io);
    return ExitCode.InvalidInput;
  }

  const options = parsed.options;
  if (options.command === "help") {
    io.output.write(options.helpTarget === undefined ? HELP : COMMAND_HELP[options.helpTarget]);
    return ExitCode.Success;
  }
  if (options.command === "version") {
    io.output.write(`${VERSION}\n`);
    return ExitCode.Success;
  }
  if (options.command === "init") {
    const execution = await runInit(
      {
        cwd: io.cwd,
        ...(options.preset === undefined ? {} : { preset: options.preset }),
        ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
        ...(options.reversePorts === undefined
          ? {}
          : { reversePorts: options.reversePorts.map(Number) }),
        ...(options.logs === undefined ? {} : { logs: options.logs }),
        ...(options.cleanupPorts === undefined ? {} : { cleanupPorts: options.cleanupPorts }),
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(options.dryRun ? { dryRun: true } : {}),
      },
      dependencies,
    );
    renderResult(execution.result, {
      format: options.format,
      capabilities: capabilities(options, cliConfig(options), io, "output", options.format),
      sink: options.format === "human" ? io.error : io.output,
      verbose: options.verbose,
    });
    return execution.exitCode;
  }
  if (
    options.command === "context" ||
    options.command === "sessions" ||
    options.command === "problems"
  ) {
    const storeOptions =
      dependencies.sessionStore === false
        ? { env: io.env }
        : (dependencies.sessionStore ?? { env: io.env });
    const execution =
      options.command === "context"
        ? await runContextCommand(
            options.sessionId,
            options.contextBudget,
            storeOptions,
            dependencies,
          )
        : options.command === "sessions"
          ? await runSessionCommand(
              options.sessionAction ?? "list",
              options.sessionId,
              storeOptions,
              dependencies,
            )
          : await runProblemsCommand(options.sessionId, storeOptions, dependencies);
    renderResult(execution.result, {
      format: options.format,
      capabilities: capabilities(options, cliConfig(options), io, "output", options.format),
      sink: options.format === "human" ? io.error : io.output,
      verbose: options.verbose,
    });
    return execution.exitCode;
  }

  const loaded = await (dependencies.loadConfig ?? loadConfig)({
    cwd: io.cwd,
    env: io.env,
    ...(options.configPath === undefined ? {} : { projectConfigPath: options.configPath }),
    explicitProjectConfig: options.configPath !== undefined,
    ...(options.profileName === undefined ? {} : { profileName: options.profileName }),
    cli: cliConfig(options),
  });
  if (!loaded.ok) {
    const failure = failureResult(options.command, configProblems(loaded.errors), dependencies);
    renderFailure(failure, options.format, io);
    return ExitCode.InvalidInput;
  }

  if (options.command === "config") {
    const execution = runConfigReport(
      options.configAction ?? "validate",
      loaded.config,
      dependencies,
    );
    renderResult(execution.result, {
      format: options.format,
      capabilities: capabilities(options, loaded.config.values, io, "output", options.format),
      sink: options.format === "human" ? io.error : io.output,
      verbose: options.verbose,
    });
    return execution.exitCode;
  }

  const values = loaded.config.values;
  const errorCapabilities = capabilities(options, values, io, "error", options.format);
  const outputCapabilities = capabilities(options, values, io, "output", options.format);
  let lastTarget: RememberedTarget | undefined;
  let stateWarning: Problem | undefined;
  if (
    (options.command === "dev" ||
      options.command === "devices" ||
      options.command === "logs" ||
      options.command === "ports") &&
    (options.command === "dev" ||
      options.command === "logs" ||
      options.select ||
      options.remembered)
  ) {
    const state = await (dependencies.readTargetState ?? readTargetState)({
      env: io.env,
      ...(values.adbHost === undefined ? {} : { adbHost: values.adbHost }),
      ...(values.adbPort === undefined ? {} : { adbPort: values.adbPort }),
    });
    if (!state.ok) {
      const problem: Problem = {
        code: state.code,
        category: options.remembered ? "environment.state" : "state.persistence",
        severity: options.remembered ? "error" : "warning",
        summary: state.message,
        detail: options.remembered
          ? "Fix or remove the per-user state file, then retry."
          : "Selection can continue, but no remembered recommendation is available.",
        retryable: true,
        evidence: [{ source: "state", field: "path", value: redactText(state.path).value }],
        actions: [],
        correlation: { commandId: "state" },
      };
      if (options.remembered) {
        const failure = failureResult(options.command, [problem], dependencies);
        renderFailure(failure, options.format, io);
        return ExitCode.Environment;
      }
      stateWarning = problem;
    }
    if (state.ok) {
      lastTarget = rememberedTarget(state.document, {
        ...(values.adbHost === undefined ? {} : { adbHost: values.adbHost }),
        ...(values.adbPort === undefined ? {} : { adbPort: values.adbPort }),
      });
    }
  }
  const bus = dependencies.bus ?? new EventBus(dependencies.clock);
  const commandDependencies = { ...dependencies, bus };
  const config: import("../app/commands.js").CommandConfig = {
    ...(values.adbPath === undefined ? {} : { adbPath: values.adbPath }),
    ...(values.adbHost === undefined ? {} : { adbHost: values.adbHost }),
    ...(values.adbPort === undefined ? {} : { adbPort: values.adbPort }),
    timeoutMs: values.timeoutMs,
    ...(options.device === undefined ? {} : { targetSelector: options.device }),
    ...(options.transportId === undefined ? {} : { targetTransportId: options.transportId }),
    ...(values.targetAliases === undefined ? {} : { targetAliases: values.targetAliases }),
    ...(lastTarget === undefined ? {} : { rememberedSerial: lastTarget.serial }),
    ...(lastTarget?.hardwareSerial === undefined
      ? {}
      : { rememberedHardwareSerial: lastTarget.hardwareSerial }),
    ...(options.remembered ? { rememberedOnly: true } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
  };
  if (
    (options.command === "ports" && options.select) ||
    options.command === "dev" ||
    options.command === "logs"
  ) {
    let inventory = await runDevices(config, commandDependencies, signal);
    let selectable =
      inventory.result.data?.targets.filter((target) =>
        target.transports.some(({ stable, state }) => stable && state === "device"),
      ) ?? [];
    if (options.command === "dev" && selectable.length === 0 && !options.dryRun) {
      const acquisition = planTargetAcquisition({
        ...(config.targetSelector === undefined ? {} : { selector: config.targetSelector }),
        ...(values.targetAliases === undefined ? {} : { aliases: values.targetAliases }),
        ...(lastTarget === undefined ? {} : { remembered: lastTarget }),
        services: inventory.result.data?.discovery.mdns.services ?? [],
      });
      if (acquisition.kind === "connect") {
        const connected = await runConnect(
          acquisition.endpoint,
          acquisition.discovered
            ? {
                ...config,
                endpointWasDiscovered: true,
                discoveredEndpointCandidates: acquisition.candidates,
              }
            : config,
          commandDependencies,
          signal,
        );
        const connectedData = connected.result.data;
        if (!connected.result.ok || connectedData === null || !("serial" in connectedData)) {
          renderResult(
            { ...connected.result, command: "dev" },
            {
              format: options.format,
              capabilities: errorCapabilities,
              sink: options.format === "human" ? io.error : io.output,
              verbose: options.verbose,
            },
          );
          return connected.exitCode;
        }
        config.targetSelector = connectedData.serial;
        delete config.targetTransportId;
        inventory = await runDevices(config, commandDependencies, signal);
        selectable =
          inventory.result.data?.targets.filter((target) =>
            target.transports.some(({ stable, state }) => stable && state === "device"),
          ) ?? [];
      }
    }
    const shouldPrompt =
      options.select ||
      ((options.command === "dev" || options.command === "logs") &&
        errorCapabilities.interactive &&
        inventory.result.data?.selected === undefined &&
        selectable.length !== 1);
    const selected = shouldPrompt
      ? await selectDevice(inventory, io, errorCapabilities, lastTarget, signal)
      : inventory;
    if (!selected.result.ok || selected.result.data?.selected === undefined) {
      if (shouldPrompt) {
        renderResult(
          { ...selected.result, command: options.command },
          {
            format: "human",
            capabilities: errorCapabilities,
            sink: io.error,
            verbose: options.verbose,
          },
        );
        return selected.exitCode;
      }
    } else {
      const transport = selected.result.data.selected.transport;
      if (transport.transportId === undefined) {
        config.targetSelector = transport.serial;
      } else {
        config.targetTransportId = transport.transportId;
      }
    }
  }
  let endpoint = options.endpoint;
  let endpointWasDiscovered = false;
  let discoveredEndpointCandidates: string[] | undefined;
  if (
    endpoint === undefined &&
    errorCapabilities.interactive &&
    (options.command === "connect" || options.command === "pair")
  ) {
    const discoveryProgress = options.quiet
      ? undefined
      : new ProgressRenderer({
          bus,
          sink: io.error,
          capabilities: errorCapabilities,
          verbose: options.verbose,
        });
    let discovery: Awaited<ReturnType<typeof runWirelessDiscovery>>;
    try {
      discovery = await runWirelessDiscovery(
        options.command === "pair" ? "pairing" : "connect",
        config,
        commandDependencies,
        signal,
      );
    } finally {
      discoveryProgress?.dispose();
    }
    if (!discovery.result.ok || discovery.result.data === null) {
      renderResult(
        { ...discovery.result, command: options.command },
        {
          format: "human",
          capabilities: errorCapabilities,
          sink: io.error,
          verbose: options.verbose,
        },
      );
      return discovery.exitCode;
    }
    const services = discovery.result.data.services;
    if (services.length === 1) {
      const service = services[0];
      endpoint = service?.endpoint.serial;
      endpointWasDiscovered = service !== undefined;
      discoveredEndpointCandidates =
        service === undefined ? undefined : discoveredCandidates(service);
    } else {
      const chosen = await selectOne({
        title:
          options.command === "pair" ? "Choose a pairing endpoint" : "Choose a wireless target",
        options: services.map((service) => {
          const identity = service.givenName ?? service.deviceModel;
          return {
            value: service,
            label: identity ?? service.endpoint.serial,
            description:
              identity === undefined
                ? `${service.instance} · ${service.rawServiceType}`
                : `${service.endpoint.serial} · ${service.rawServiceType}`,
          };
        }),
        input: io.input,
        sink: io.error,
        capabilities: errorCapabilities,
        ...(signal === undefined ? {} : { signal }),
      });
      if (chosen.kind !== "selected") {
        const failed = selectionProblem(
          chosen.kind === "unavailable" ? "unavailable" : chosen.reason,
          discovery.result.commandId,
        );
        renderResult(
          {
            ...discovery.result,
            command: options.command,
            ok: false,
            problems: [...discovery.result.problems, failed.problem],
          },
          {
            format: "human",
            capabilities: errorCapabilities,
            sink: io.error,
            verbose: options.verbose,
          },
        );
        return failed.exitCode;
      }
      endpoint = chosen.value.endpoint.serial;
      endpointWasDiscovered = true;
      discoveredEndpointCandidates = discoveredCandidates(chosen.value);
    }
  }
  let pairingCode: string | undefined;
  if (options.command === "pair" && !options.dryRun) {
    if (!errorCapabilities.interactive && !options.pairingCodeStdin) {
      const failure = failureResult(
        "pair",
        [
          inputProblem(
            ProblemCode.InvalidPairingCode,
            "A pairing code source is required in non-interactive mode.",
            "Pipe the six-digit code to stdin and add --pairing-code-stdin.",
          ),
        ],
        dependencies,
      );
      renderFailure(failure, options.format, io);
      return ExitCode.InvalidInput;
    }
    const input = await readPairingCode({
      input: io.input,
      sink: io.error,
      capabilities: errorCapabilities,
      fromStdin: options.pairingCodeStdin,
      ...(signal === undefined ? {} : { signal }),
    });
    if (input.kind !== "submitted") {
      const interrupted = input.kind === "cancelled" && input.reason !== "eof";
      const failure = failureResult(
        "pair",
        [
          inputProblem(
            interrupted ? ProblemCode.OperationInterrupted : ProblemCode.InvalidPairingCode,
            interrupted ? "Pairing code entry was cancelled." : "No pairing code was received.",
            "Open Android's pairing-code screen and try again.",
          ),
        ],
        dependencies,
      );
      renderFailure(failure, options.format, io);
      return interrupted ? ExitCode.Interrupted : ExitCode.InvalidInput;
    }
    pairingCode = input.value;
  }
  const progress =
    options.format === "human" && !options.quiet && options.command !== "logs"
      ? new ProgressRenderer({
          bus,
          sink: io.error,
          capabilities: errorCapabilities,
          verbose: options.verbose,
        })
      : undefined;
  const events = options.format === "ndjson" ? new NdjsonEventRenderer(bus, io.output) : undefined;

  let execution:
    | CommandExecution<DevicesData>
    | Awaited<ReturnType<typeof runConnect>>
    | Awaited<ReturnType<typeof runDev>>
    | Awaited<ReturnType<typeof runDoctor>>
    | CommandExecution<LogsData>
    | Awaited<ReturnType<typeof runPair>>
    | Awaited<ReturnType<typeof runPorts>>;
  try {
    if (options.command === "doctor") {
      execution = await runDoctor(config, commandDependencies, signal);
    } else if (options.command === "logs") {
      execution = await runLogs(
        {
          ...(options.logPackage === undefined ? {} : { packageName: options.logPackage }),
          ...(options.logPid === undefined ? {} : { pid: options.logPid }),
          ...(options.logTags === undefined ? {} : { tags: options.logTags }),
          ...(options.logExcludeTags === undefined ? {} : { excludeTags: options.logExcludeTags }),
          ...(options.logPriority === undefined ? {} : { minimumPriority: options.logPriority }),
          ...(options.logBuffers === undefined ? {} : { buffers: options.logBuffers }),
          ...(options.logSince === undefined ? {} : { since: options.logSince }),
          ...(options.logTail === undefined ? {} : { tail: options.logTail }),
          ...(options.logDump === undefined ? {} : { dump: options.logDump }),
          ...(options.logMaxRecords === undefined ? {} : { maxRecords: options.logMaxRecords }),
          ...(options.format === "human" && !options.quiet
            ? { onLine: (line: string) => io.error.write(`${line}\n`) }
            : {}),
        },
        config,
        commandDependencies,
        signal,
      );
    } else if (options.command === "dev") {
      execution = await runDev(
        {
          cwd: io.cwd,
          ...(values.devPreset === undefined ? {} : { preset: values.devPreset }),
          ...(values.packageManager === undefined ? {} : { packageManager: values.packageManager }),
          ...(values.devCommand === undefined ? {} : { command: values.devCommand }),
          ...(values.devReversePorts === undefined ? {} : { reversePorts: values.devReversePorts }),
          ...(values.devLogs === undefined ? {} : { logs: values.devLogs }),
          ...(values.devCleanupPorts === undefined ? {} : { cleanupPorts: values.devCleanupPorts }),
          ...(values.devWatch === undefined ? {} : { watch: values.devWatch }),
          recovery: {
            ...(values.recoveryMaxAttempts === undefined
              ? {}
              : { maxAttempts: values.recoveryMaxAttempts }),
            ...(values.recoveryInitialDelayMs === undefined
              ? {}
              : { initialDelayMs: values.recoveryInitialDelayMs }),
            ...(values.recoveryMaxDelayMs === undefined
              ? {}
              : { maxDelayMs: values.recoveryMaxDelayMs }),
            ...(values.recoveryTotalTimeoutMs === undefined
              ? {}
              : { totalTimeoutMs: values.recoveryTotalTimeoutMs }),
          },
          ...(values.devHooks === undefined ? {} : { hooks: values.devHooks }),
          journal: {
            ...(values.journalMaxEntries === undefined
              ? {}
              : { maxEntries: values.journalMaxEntries }),
            ...(values.journalMaxBytes === undefined ? {} : { maxBytes: values.journalMaxBytes }),
            ...(values.journalSources === undefined ? {} : { sources: values.journalSources }),
            ...(values.journalMinimumSeverity === undefined
              ? {}
              : { minimumSeverity: values.journalMinimumSeverity }),
            ...(values.journalRedactEnvironment === undefined
              ? {}
              : {
                  redaction: {
                    additionalLiterals: values.journalRedactEnvironment.flatMap((name) => {
                      const value = io.env[name];
                      return value === undefined || value === "" ? [] : [value];
                    }),
                  },
                }),
          },
          childStdin: errorCapabilities.interactive ? "inherit" : "ignore",
          sessionStore:
            values.sessionPersist === false || dependencies.sessionStore === false
              ? false
              : (dependencies.sessionStore ?? {
                  env: io.env,
                  ...(values.sessionMaxSessions === undefined
                    ? {}
                    : { maxSessions: values.sessionMaxSessions }),
                  ...(values.sessionMaxAgeDays === undefined
                    ? {}
                    : { maxAgeDays: values.sessionMaxAgeDays }),
                  ...(values.sessionMaxBytes === undefined
                    ? {}
                    : { maxBytes: values.sessionMaxBytes }),
                }),
          ...(options.format === "human" && !options.quiet
            ? {
                onChildLine: (stream: "stderr" | "stdout", line: string) => {
                  io.error.write(`${stream === "stderr" ? "│" : " "} ${line}\n`);
                },
              }
            : {}),
        },
        config,
        commandDependencies,
        signal,
      );
    } else if (options.command === "devices") {
      execution = await runDevices(config, commandDependencies, signal);
    } else if (options.command === "connect") {
      execution = await runConnect(
        endpoint,
        endpointWasDiscovered
          ? {
              ...config,
              endpointWasDiscovered: true,
              ...(discoveredEndpointCandidates === undefined
                ? {}
                : { discoveredEndpointCandidates }),
            }
          : config,
        commandDependencies,
        signal,
      );
    } else if (options.command === "pair") {
      execution = await runPair(
        endpoint,
        pairingCode ?? "",
        endpointWasDiscovered
          ? {
              ...config,
              endpointWasDiscovered: true,
              ...(discoveredEndpointCandidates === undefined
                ? {}
                : { discoveredEndpointCandidates }),
            }
          : config,
        commandDependencies,
        signal,
      );
    } else {
      const direction = options.portDirection;
      const action = options.portAction;
      if (direction === undefined || action === undefined) {
        throw new Error("Validated ports command is missing its direction or action.");
      }
      execution = await runPorts(
        {
          direction,
          action,
          ...(direction === "reverse"
            ? {
                ...(options.primaryPort === undefined ? {} : { devicePort: options.primaryPort }),
                ...(options.secondaryPort === undefined ? {} : { hostPort: options.secondaryPort }),
              }
            : {
                ...(options.primaryPort === undefined ? {} : { hostPort: options.primaryPort }),
                ...(options.secondaryPort === undefined
                  ? {}
                  : { devicePort: options.secondaryPort }),
              }),
        },
        config,
        commandDependencies,
        signal,
      );
    }
  } finally {
    progress?.dispose();
    events?.dispose();
  }

  if (options.command === "devices" && options.select) {
    execution = await selectDevice(
      execution as CommandExecution<DevicesData>,
      io,
      errorCapabilities,
      lastTarget,
      signal,
    );
  }
  if (stateWarning !== undefined) {
    execution.result.problems.push({
      ...stateWarning,
      correlation: { commandId: execution.result.commandId },
    });
  }

  let selectedTarget:
    | {
        serial: string;
        hardwareSerial?: string;
      }
    | undefined;
  if (execution.result.ok && execution.result.data !== null) {
    if (options.command === "connect") {
      const data = execution.result.data as Awaited<
        ReturnType<typeof runConnect>
      >["result"]["data"];
      if (data !== null && "serial" in data) {
        selectedTarget = {
          serial: data.serial,
          ...(data.hardwareSerial === undefined ? {} : { hardwareSerial: data.hardwareSerial }),
        };
      }
    } else if (options.command === "dev") {
      const data = execution.result.data as DevData | null;
      if (data !== null) {
        selectedTarget = {
          serial: data.selected.transport.serial,
          ...(data.selected.target.hardwareSerial === undefined
            ? {}
            : { hardwareSerial: data.selected.target.hardwareSerial }),
        };
      }
    } else if (options.command === "logs") {
      const data = execution.result.data as LogsData | null;
      if (data !== null) {
        selectedTarget = {
          serial: data.selected.transport.serial,
          ...(data.selected.target.hardwareSerial === undefined
            ? {}
            : { hardwareSerial: data.selected.target.hardwareSerial }),
        };
      }
    } else if (options.command === "devices") {
      const data = execution.result.data as DevicesData;
      if (data.selected !== undefined) {
        selectedTarget = {
          serial: data.selected.transport.serial,
          ...(data.selected.target.hardwareSerial === undefined
            ? {}
            : { hardwareSerial: data.selected.target.hardwareSerial }),
        };
      }
    } else if (options.command === "ports") {
      const data = execution.result.data as PortsData | null;
      if (data !== null) {
        selectedTarget = {
          serial: data.selected.transport.serial,
          ...(data.selected.target.hardwareSerial === undefined
            ? {}
            : { hardwareSerial: data.selected.target.hardwareSerial }),
        };
      }
    }
  }
  if (selectedTarget !== undefined) {
    const stored = await (dependencies.writeRememberedTarget ?? writeRememberedTarget)(
      {
        ...selectedTarget,
        updatedAt: (dependencies.clock ?? (() => new Date()))().toISOString(),
      },
      {
        env: io.env,
        ...(values.adbHost === undefined ? {} : { adbHost: values.adbHost }),
        ...(values.adbPort === undefined ? {} : { adbPort: values.adbPort }),
      },
    );
    if (!stored.ok) {
      execution.result.problems.push({
        code: stored.code,
        category: "state.persistence",
        severity: "warning",
        summary: stored.message,
        detail: "The connection is ready, but ADB Ready could not remember it for --last.",
        retryable: true,
        evidence: [{ source: "state", field: "path", value: redactText(stored.path).value }],
        actions: [],
        correlation: { commandId: execution.result.commandId },
      });
    }
  }

  if (options.format !== "human" || !options.quiet || !execution.result.ok) {
    const human = options.format === "human";
    renderResult(execution.result, {
      format: options.format,
      capabilities: human ? errorCapabilities : outputCapabilities,
      sink: human ? io.error : io.output,
      verbose: options.verbose,
    });
  }
  return execution.exitCode;
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies = {},
  signal?: AbortSignal,
): Promise<number> {
  try {
    return await runCliInternal(argv, io, dependencies, signal);
  } catch (caught) {
    const message = redactText(caught instanceof Error ? caught.message : String(caught)).value;
    const problem: Problem = {
      code: "INTERNAL_ERROR",
      category: "internal.unexpected",
      severity: "error",
      summary: "ADB Ready encountered an unexpected internal error.",
      detail: "The operation stopped safely. Re-run with --verbose when reporting this issue.",
      retryable: false,
      evidence: message === "" ? [] : [{ source: "internal", field: "message", value: message }],
      actions: [],
      correlation: { commandId: "cli" },
    };
    renderFailure(failureResult("cli", [problem], dependencies), inferredFormat(argv), io);
    return ExitCode.Internal;
  }
}

export function processIo(): CliIo {
  return {
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
    cwd: process.cwd(),
    env: process.env,
  };
}
