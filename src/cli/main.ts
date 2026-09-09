import { randomUUID } from "node:crypto";
import process from "node:process";
import manifest from "../../package.json" with { type: "json" };
import {
  type CommandDependencies,
  type CommandExecution,
  type DevicesData,
  runConnect,
  runDevices,
  runDoctor,
  runPair,
} from "../app/commands.js";
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
import { readTargetState, rememberedTarget, writeRememberedTarget } from "../state/target-state.js";
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
  connect [HOST:PORT]    Connect and verify a wireless Android target
  doctor                 Inspect the local ADB environment
  devices                List visible Android targets
  pair [HOST:PORT]       Pair using Android's six-digit pairing code
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
  --select               Interactively select from listed devices
  -s, --device SELECTOR  Select an exact serial or configured alias
  --transport-id ID      Select an exact ADB transport ID
  --last                 Select the last successfully verified target
  --pairing-code-stdin   Read the pairing code from stdin without echoing it
  --dry-run              Show connect/pair operations without changing state

Other:
  -h, --help             Show help
  -V, --version          Show version
`;

const COMMAND_HELP = {
  connect: `Usage: adb-ready connect [HOST:PORT] [options]

Connects a TLS/legacy wireless endpoint and verifies its stable ADB serial.
When the endpoint is omitted, exactly one mDNS connect service must be visible.
`,
  doctor: `Usage: adb-ready doctor [options]

Runs read-only host, ADB capability, server, and target diagnostics.
`,
  devices: `Usage: adb-ready devices [options]

Lists every target visible to ADB. Add --select to open the keyboard picker.
`,
  pair: `Usage: adb-ready pair [HOST:PORT] [options]

Pairs with Android Wireless debugging using a hidden six-digit code prompt.
For automation, pipe the code and add --pairing-code-stdin.
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
}

function inferredFormat(argv: readonly string[]): OutputFormat {
  let format: OutputFormat = "human";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      format = "json";
    } else if (argument?.startsWith("--format=")) {
      const value = argument.slice("--format=".length);
      if (value === "human" || value === "plain" || value === "json" || value === "ndjson") {
        format = value;
      }
    } else if (argument === "--format") {
      const value = argv[index + 1];
      if (value === "human" || value === "plain" || value === "json" || value === "ndjson") {
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

async function selectDevice(
  execution: CommandExecution<DevicesData>,
  io: CliIo,
  terminal: TerminalCapabilities,
  rememberedSerial?: string,
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
        target.transports.some(({ serial }) => serial === rememberedSerial) ||
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

  const loaded = await (dependencies.loadConfig ?? loadConfig)({
    cwd: io.cwd,
    env: io.env,
    ...(options.configPath === undefined ? {} : { projectConfigPath: options.configPath }),
    explicitProjectConfig: options.configPath !== undefined,
    cli: cliConfig(options),
  });
  if (!loaded.ok) {
    const failure = failureResult(options.command, configProblems(loaded.errors), dependencies);
    renderFailure(failure, options.format, io);
    return ExitCode.InvalidInput;
  }

  const values = loaded.config.values;
  const errorCapabilities = capabilities(options, values, io, "error", options.format);
  const outputCapabilities = capabilities(options, values, io, "output", options.format);
  let lastSerial: string | undefined;
  let stateWarning: Problem | undefined;
  if (options.command === "devices" && (options.select || options.remembered)) {
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
        const failure = failureResult("devices", [problem], dependencies);
        renderFailure(failure, options.format, io);
        return ExitCode.Environment;
      }
      stateWarning = problem;
    }
    if (state.ok) {
      lastSerial = rememberedTarget(state.document, {
        ...(values.adbHost === undefined ? {} : { adbHost: values.adbHost }),
        ...(values.adbPort === undefined ? {} : { adbPort: values.adbPort }),
      })?.serial;
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
  const bus = dependencies.bus ?? new EventBus(dependencies.clock);
  const progress =
    options.format === "human" && !options.quiet
      ? new ProgressRenderer({
          bus,
          sink: io.error,
          capabilities: errorCapabilities,
          verbose: options.verbose,
        })
      : undefined;
  const events = options.format === "ndjson" ? new NdjsonEventRenderer(bus, io.output) : undefined;
  const commandDependencies = { ...dependencies, bus };
  const config = {
    ...(values.adbPath === undefined ? {} : { adbPath: values.adbPath }),
    ...(values.adbHost === undefined ? {} : { adbHost: values.adbHost }),
    ...(values.adbPort === undefined ? {} : { adbPort: values.adbPort }),
    timeoutMs: values.timeoutMs,
    ...(options.device === undefined ? {} : { targetSelector: options.device }),
    ...(options.transportId === undefined ? {} : { targetTransportId: options.transportId }),
    ...(values.targetAliases === undefined ? {} : { targetAliases: values.targetAliases }),
    ...(lastSerial === undefined ? {} : { rememberedSerial: lastSerial }),
    ...(options.remembered ? { rememberedOnly: true } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
  };

  let execution:
    | CommandExecution<DevicesData>
    | Awaited<ReturnType<typeof runConnect>>
    | Awaited<ReturnType<typeof runDoctor>>
    | Awaited<ReturnType<typeof runPair>>;
  try {
    if (options.command === "doctor") {
      execution = await runDoctor(config, commandDependencies, signal);
    } else if (options.command === "devices") {
      execution = await runDevices(config, commandDependencies, signal);
    } else if (options.command === "connect") {
      execution = await runConnect(options.endpoint, config, commandDependencies, signal);
    } else {
      execution = await runPair(
        options.endpoint,
        pairingCode ?? "",
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
      lastSerial,
      signal,
    );
  }
  if (stateWarning !== undefined) {
    execution.result.problems.push({
      ...stateWarning,
      correlation: { commandId: execution.result.commandId },
    });
  }

  if (options.command === "connect" && execution.result.ok && execution.result.data !== null) {
    const data = execution.result.data as Awaited<ReturnType<typeof runConnect>>["result"]["data"];
    if (data !== null && "serial" in data) {
      const stored = await (dependencies.writeRememberedTarget ?? writeRememberedTarget)(
        {
          serial: data.serial,
          ...(data.hardwareSerial === undefined ? {} : { hardwareSerial: data.hardwareSerial }),
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
