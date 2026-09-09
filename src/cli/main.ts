import { randomUUID } from "node:crypto";
import process from "node:process";
import manifest from "../../package.json" with { type: "json" };
import {
  type CommandDependencies,
  type CommandExecution,
  type DevicesData,
  runDevices,
  runDoctor,
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
import { clearInteractiveScreen, showHomeScreen } from "../ui/home.js";
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
  doctor                 Inspect the local ADB environment
  devices                List visible Android targets
  help [doctor|devices]  Show help
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

Other:
  -h, --help             Show help
  -V, --version          Show version
`;

const COMMAND_HELP = {
  doctor: `Usage: adb-ready doctor [options]

Runs read-only host, ADB capability, server, and target diagnostics.
`,
  devices: `Usage: adb-ready devices [options]

Lists every target visible to ADB. Add --select to open the keyboard picker.
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

async function selectDevice(
  execution: CommandExecution<DevicesData>,
  io: CliIo,
  terminal: TerminalCapabilities,
  signal?: AbortSignal,
): Promise<CommandExecution<DevicesData>> {
  const data = execution.result.data;
  if (data === null) {
    return execution;
  }
  const selectable = data.devices.filter(({ state }) => state === "device");
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
    options: data.devices.map((device) => ({
      value: device,
      label: device.model ?? device.serial,
      description: `${device.serial} · ${device.state}`,
      disabled: device.state !== "device",
      recommended: selectable.length === 1 && device.serial === selectable[0]?.serial,
    })),
    input: io.input,
    sink: io.error,
    capabilities: terminal,
    ...(signal === undefined ? {} : { signal }),
  });

  if (selection.kind === "selected") {
    return {
      ...execution,
      result: {
        ...execution.result,
        data: { ...data, selected: selection.value },
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
  };

  let execution: CommandExecution<DevicesData> | Awaited<ReturnType<typeof runDoctor>>;
  try {
    execution =
      options.command === "doctor"
        ? await runDoctor(config, commandDependencies, signal)
        : await runDevices(config, commandDependencies, signal);
  } finally {
    progress?.dispose();
    events?.dispose();
  }

  if (options.command === "devices" && options.select) {
    execution = await selectDevice(
      execution as CommandExecution<DevicesData>,
      io,
      errorCapabilities,
      signal,
    );
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
