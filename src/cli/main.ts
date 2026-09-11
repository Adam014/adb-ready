import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import manifest from "../../package.json" with { type: "json" };
import type { AdbMdnsService } from "../adb/parsers.js";
import { runMcpStdio } from "../agent/mcp-server.js";
import { runAgentSetup } from "../agent/setup.js";
import {
  type AppData,
  type AppsData,
  type OpenData,
  runApp,
  runApps,
  runOpen,
} from "../app/app-commands.js";
import {
  type CommandDependencies,
  type CommandExecution,
  type DevData,
  type DevicesData,
  type DevOptions,
  type LogsData,
  type PortsData,
  runConnect,
  runDev,
  runDevices,
  runDevOfflinePlan,
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
import { type AutomationRunData, writeEvidenceBundle } from "../automation/evidence-bundle.js";
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
import { type CaptureData, runCapture } from "../evidence/capture.js";
import {
  type InspectAppData,
  type InspectUiData,
  runInspectApp,
  runInspectUi,
} from "../evidence/inspect.js";
import { runUiAction, type UiActionData } from "../evidence/ui-actions.js";
import { planTargetAcquisition } from "../session/target-acquisition.js";
import type { SessionStoreOptions } from "../state/session-store.js";
import {
  acquireTargetLease,
  type TargetLeaseHandle,
  type TargetLeaseOptions,
} from "../state/target-lease.js";
import {
  type RememberedTarget,
  readTargetState,
  rememberedTarget,
  writeRememberedTarget,
} from "../state/target-state.js";
import type { AndroidTarget } from "../target/model.js";
import type { SelectedTarget } from "../target/selection.js";
import { confirmAction } from "../ui/confirm.js";
import { clearInteractiveScreen, showHomeScreen } from "../ui/home.js";
import { readPairingCode } from "../ui/pairing-code.js";
import { ProgressRenderer } from "../ui/progress-renderer.js";
import { NdjsonEventRenderer, renderResult } from "../ui/result-renderer.js";
import { type SelectInput, selectOne } from "../ui/select.js";
import type { TextSink } from "../ui/spinner.js";
import { renderChildStreamLine, renderLogStreamLine } from "../ui/stream-renderer.js";
import { resolveTerminalCapabilities, type TerminalCapabilities } from "../ui/terminal.js";
import { type CliOptions, type OutputFormat, parseArguments } from "./arguments.js";

export const VERSION = manifest.version;

export const HELP = `ADB Ready

Make an Android target ready, then keep the development session working.

Usage:
  adb-ready [command] [options]
  adbr [command] [options]

Commands:
  agent setup CLIENT     Configure a project-local AI agent bridge
  app ACTION [APP_ID]   Resolve, inspect, install, or control one app
  apps list             List packages on one Android target
  capture ACTION         Save a verified screenshot or bounded screen recording
  config ACTION          Validate or explain resolved configuration
  connect [HOST:PORT]    Connect and verify a wireless Android target
  context [SESSION]      Export bounded AI-ready diagnostic context
  dev [OPTIONS] [-- CMD] Prepare one target and run a development session
  run [OPTIONS] -- CMD   Run one bounded verification job with evidence
  doctor                 Inspect the local ADB environment
  init                   Create a detected project configuration
  inspect ACTION         Build a bounded app or UI evidence snapshot
  devices                List visible Android targets
  logs [OPTIONS]         Stream focused logs from one Android target
  mcp                    Serve typed tools over local stdio
  open URL               Open a deep link or web URL on one target
  pair [HOST:PORT]       Pair using Android's six-digit pairing code
  ports DIRECTION ACTION Manage verified TCP forward/reverse mappings
  sessions [ACTION]      Inspect saved development sessions
  ui ACTION              Perform a bounded, verified Android UI action
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
  agent: `Usage:
  adb-ready agent setup codex [--dry-run]
  adb-ready agent setup claude-code [--dry-run]
  adb-ready agent setup cursor [--dry-run]
  adb-ready agent setup vscode [--dry-run]
  adb-ready agent setup windsurf [--dry-run]
  adb-ready agent setup generic [--dry-run]

Creates or safely merges a project MCP configuration without replacing an
existing adb-ready server entry. Windsurf and generic clients return a manual
snippet because their configuration is user-scoped or client-defined.
`,
  app: `Usage:
  adb-ready app resolve [APP_ID] [options]
  adb-ready app info [APP_ID] [options]
  adb-ready app install APK [--package APP_ID] [options]
  adb-ready app launch [APP_ID] [--activity ACTIVITY] [options]
  adb-ready app stop [APP_ID] [options]
  adb-ready app restart [APP_ID] [--activity ACTIVITY] [options]
  adb-ready app clear-data [APP_ID] [--allow-destructive]
  adb-ready app uninstall [APP_ID] [--allow-destructive]

Resolves one project application with provenance and runs verified lifecycle
operations against the same deterministic Android target.
`,
  apps: `Usage: adb-ready apps list [--user|--system|--all] [options]

Lists packages from one deterministic Android target. User-installed packages
are shown by default.
`,
  capture: `Usage:
  adb-ready capture screenshot [--out PATH] [--force]
  adb-ready capture screen-record [--out PATH] [--duration 10s] [--force]

Writes verified binary evidence inside the current project. Existing files are
never replaced unless --force is explicit. Recordings are bounded to 180s.
`,
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
  --since DURATION       Keep only the final window, such as 30s or 5m
  --only FILTERS         Keep comma-separated problems,recovery,logs,child,state,target,ports
  --all-projects         Allow an explicit cross-project session lookup
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
  run: `Usage: adb-ready run [options] -- EXECUTABLE ARG...

Starts the configured development service on one exclusively leased target,
waits for every readiness assertion, runs one bounded verification command,
then cleans owned resources. The verification exit code is preserved.

Run options:
  --run-timeout DURATION Bound the verification command (default: 15m)
  --dry-run              Build an offline plan unless a target is explicit
  -- EXECUTABLE ARG...   Verification command, passed directly without a shell
`,
  doctor: `Usage: adb-ready doctor [options]

Runs read-only host, ADB capability, server, and target diagnostics.
`,
  init: `Usage: adb-ready init [options]

Creates adb-ready.config.json from detected project signals. Existing files are
never replaced unless --force is explicit. Use --dry-run to preview the file.
`,
  inspect: `Usage:
  adb-ready inspect app [APP_ID] [options]
  adb-ready inspect ui [--interactive-only] [--max-depth N] [options]

Returns a bounded evidence snapshot for one deterministic target. UI text and
hierarchy data are explicitly marked sensitive and are never added to AI
context implicitly.
`,
  ui: `Usage:
  adb-ready ui tap REF|X Y [--dry-run]
  adb-ready ui tap SELECTOR [--dry-run]
  adb-ready ui long-press REF|X Y [--dry-run]
  adb-ready ui find SELECTOR
  adb-ready ui assert SELECTOR [--state visible|gone]
  adb-ready ui compare DIGEST
  adb-ready ui swipe up|down|left|right [--dry-run]
  adb-ready ui swipe X1 Y1 X2 Y2 [--dry-run]
  adb-ready ui type TEXT [--submit] [--dry-run]
  adb-ready ui press back|home|enter|menu|volume-up|volume-down [--dry-run]
  adb-ready ui wait SELECTOR [--state visible|gone] [--timeout 5s]

Uses fresh UI evidence before every mutation. A ui:* reference is accepted only
while its snapshot digest still matches. Compact selectors use exact class=,
id=, text=, desc=, or package= values; MCP additionally supports structured
contains and prefix matching with state qualifiers. Typed text uses a
conservative shell-safe character set.
`,
  devices: `Usage: adb-ready devices [options]

Lists every target visible to ADB. Add --select to open the keyboard picker.
`,
  logs: `Usage: adb-ready logs [options]

Streams parsed, redacted logcat records from one deterministic target. Live
streams follow from now by default instead of replaying the device buffer.

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
  mcp: `Usage: adb-ready mcp

Starts the local MCP stdio server. Standard output is reserved for the MCP
protocol; the command never opens a network listener or exposes raw shell/ADB.
`,
  open: `Usage: adb-ready open URL [--package APP_ID] [options]

Opens one absolute deep link or web URL through Android's VIEW intent on the
selected target.
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
when no ID is provided. History is scoped to the current project unless
--all-projects is explicit.
`,
  sessions: `Usage:
  adb-ready sessions list [options]
  adb-ready sessions show [SESSION] [options]
  adb-ready sessions events [SESSION] [options]

Inspects private, redacted development history. Show and events use the latest
session from the current project when no ID is provided. Use --all-projects for
an explicit cross-project audit.

List filters:
  --status STATUS        running, completed, failed, or interrupted
  --since DURATION       Keep sessions updated in the final window
  --preset NAME          Keep sessions using one development preset
  --limit COUNT          Return at most 1-100 sessions
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
  targetLease?: false | TargetLeaseOptions;
}

function requiresTargetLease(options: CliOptions): boolean {
  if (options.dryRun) return false;
  if (options.command === "dev" || options.command === "run" || options.command === "open") {
    return true;
  }
  if (options.command === "app") {
    return options.appAction !== "info" && options.appAction !== "resolve";
  }
  if (options.command === "ports") return options.portAction !== "list";
  if (options.command === "ui") return options.uiRequest?.action !== "wait";
  return options.command === "capture" && options.captureKind === "screen-record";
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

function rootInvocation(argv: readonly string[]): boolean {
  const valueOptions = new Set(["--format"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument.startsWith("--format=")) continue;
    if (valueOptions.has(argument)) {
      index += 1;
      continue;
    }
    if (
      argument !== "--json" &&
      argument !== "--quiet" &&
      argument !== "--verbose" &&
      argument !== "--color" &&
      argument !== "--no-color" &&
      argument !== "--unicode" &&
      argument !== "--no-unicode" &&
      argument !== "--animation" &&
      argument !== "--no-animation"
    ) {
      return false;
    }
  }
  return true;
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
    ...(options.command !== "dev" || options.customCommand === undefined
      ? {}
      : { devCommand: options.customCommand }),
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

    const actionArguments: Record<Exclude<typeof home.action, "exit">, string[]> = {
      "app-info": ["app", "info"],
      "app-restart": ["app", "restart"],
      "capture-screenshot": ["capture", "screenshot"],
      connect: ["connect"],
      context: ["context"],
      dev: ["dev"],
      "dev-plan": ["dev", "--dry-run"],
      devices: ["devices"],
      doctor: ["doctor"],
      help: ["help"],
      init: ["init"],
      "inspect-app": ["inspect", "app"],
      "inspect-ui": ["inspect", "ui", "--interactive-only"],
      logs: ["logs"],
      pair: ["pair"],
      "run-help": ["help", "run"],
      sessions: ["sessions"],
      version: ["version"],
    };
    clearInteractiveScreen(io.error, terminal);
    await runCliInternal(actionArguments[home.action], io, dependencies, signal);
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
  const parsed = parseArguments(argv);
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
  if (rootInvocation(argv)) {
    const homeCapabilities = capabilities(options, cliConfig(options), io, "error", options.format);
    if (options.format === "human" && homeCapabilities.interactive) {
      return await runInteractiveSession(io, dependencies, homeCapabilities, signal);
    }
    if (options.format !== "human") {
      const overview = failureResult("overview", [], dependencies);
      const result = {
        ...overview,
        ok: true,
        data: {
          name: "ADB Ready",
          version: VERSION,
          purpose: "Prepare and operate one Android development target for humans, agents, and CI.",
          entrypoints: ["dev", "run", "agent setup", "mcp"],
          mcp: { transport: "stdio", toolSchema: "schema/agent-tools-v1.json" },
        },
      };
      renderResult(result, {
        format: options.format,
        capabilities: capabilities(options, cliConfig(options), io, "output", options.format),
        sink: io.output,
        verbose: options.verbose,
      });
      return ExitCode.Success;
    }
  }
  if (options.command === "help") {
    io.output.write(options.helpTarget === undefined ? HELP : COMMAND_HELP[options.helpTarget]);
    return ExitCode.Success;
  }
  if (options.command === "version") {
    io.output.write(`${VERSION}\n`);
    return ExitCode.Success;
  }
  if (options.command === "mcp") {
    const explicitRoot = io.env.ADB_READY_MCP_PROJECT_ROOT?.trim();
    await runMcpStdio(
      {
        cwd:
          explicitRoot === undefined || explicitRoot === "" ? io.cwd : path.resolve(explicitRoot),
        env: io.env,
        dependencies,
        version: VERSION,
      },
      signal,
    );
    return ExitCode.Success;
  }
  if (options.command === "agent") {
    const execution = await runAgentSetup(
      {
        client: options.agentClient ?? "generic",
        cwd: io.cwd,
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
        ? { env: io.env, projectRoot: io.cwd, allProjects: options.allProjects }
        : {
            ...(dependencies.sessionStore ?? { env: io.env }),
            projectRoot: dependencies.sessionStore?.projectRoot ?? io.cwd,
            allProjects: options.allProjects,
          };
    const execution =
      options.command === "context"
        ? await runContextCommand(
            options.sessionId,
            options.contextBudget,
            storeOptions,
            dependencies,
            {
              ...(options.contextSinceMs === undefined ? {} : { sinceMs: options.contextSinceMs }),
              ...(options.contextOnly === undefined ? {} : { only: options.contextOnly }),
            },
          )
        : options.command === "sessions"
          ? await runSessionCommand(
              options.sessionAction ?? "list",
              options.sessionId,
              storeOptions,
              dependencies,
              {
                ...(options.sessionStatus === undefined ? {} : { status: options.sessionStatus }),
                ...(options.sessionSinceMs === undefined
                  ? {}
                  : { sinceMs: options.sessionSinceMs }),
                ...(options.preset === undefined ? {} : { preset: options.preset }),
                ...(options.sessionLimit === undefined ? {} : { limit: options.sessionLimit }),
              },
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
    (options.command === "app" ||
      options.command === "apps" ||
      options.command === "capture" ||
      options.command === "dev" ||
      options.command === "run" ||
      options.command === "devices" ||
      options.command === "inspect" ||
      options.command === "logs" ||
      options.command === "open" ||
      options.command === "ports" ||
      options.command === "ui") &&
    (options.command === "app" ||
      options.command === "apps" ||
      options.command === "capture" ||
      options.command === "dev" ||
      options.command === "run" ||
      options.command === "inspect" ||
      options.command === "logs" ||
      options.command === "open" ||
      options.command === "ui" ||
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
  const offlineDevPlan =
    (options.command === "dev" || options.command === "run") &&
    options.dryRun &&
    !options.select &&
    options.device === undefined &&
    options.transportId === undefined &&
    !options.remembered;
  let preparedSelection: SelectedTarget | undefined;
  if (
    (options.command === "app" && (options.appAction !== "resolve" || options.select)) ||
    options.command === "apps" ||
    options.command === "capture" ||
    ((options.command === "dev" || options.command === "run") && !offlineDevPlan) ||
    options.command === "inspect" ||
    options.command === "logs" ||
    options.command === "open" ||
    options.command === "ui" ||
    options.command === "ports"
  ) {
    let inventory = await runDevices(config, commandDependencies, signal);
    let selectable =
      inventory.result.data?.targets.filter((target) =>
        target.transports.some(({ stable, state }) => stable && state === "device"),
      ) ?? [];
    if (
      (options.command === "dev" || options.command === "run") &&
      selectable.length === 0 &&
      !options.dryRun
    ) {
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
            { ...connected.result, command: options.command },
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
      (((options.command === "app" && options.appAction !== "resolve") ||
        options.command === "apps" ||
        options.command === "capture" ||
        options.command === "dev" ||
        options.command === "run" ||
        options.command === "inspect" ||
        options.command === "logs" ||
        options.command === "open" ||
        options.command === "ui") &&
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
      preparedSelection = selected.result.data.selected;
      const transport = preparedSelection.transport;
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
  let targetLease: TargetLeaseHandle | undefined;
  if (
    requiresTargetLease(options) &&
    preparedSelection !== undefined &&
    dependencies.targetLease !== false
  ) {
    const acquired = await acquireTargetLease(
      {
        targetIdentity:
          preparedSelection.target.hardwareSerial ??
          preparedSelection.target.id ??
          preparedSelection.transport.serial,
        projectRoot: io.cwd,
        purpose:
          options.command === "app" ? `app ${options.appAction ?? "mutation"}` : options.command,
      },
      { env: io.env, ...(dependencies.targetLease ?? {}) },
    );
    if (!acquired.ok) {
      const failure = failureResult(
        options.command,
        [
          {
            code:
              acquired.code === "TARGET_BUSY"
                ? ProblemCode.TargetBusy
                : ProblemCode.TargetLeaseUnavailable,
            category: "target.lease",
            severity: "error",
            summary: acquired.message,
            detail:
              acquired.code === "TARGET_BUSY"
                ? "Wait for the owning workflow to finish, or select another Android target. Expired leases are recovered automatically."
                : "Check the per-user state directory permissions, then retry.",
            retryable: true,
            evidence:
              acquired.owner === undefined
                ? []
                : [
                    { source: "target.lease", field: "purpose", value: acquired.owner.purpose },
                    {
                      source: "target.lease",
                      field: "projectFingerprint",
                      value: acquired.owner.projectFingerprint,
                    },
                    {
                      source: "target.lease",
                      field: "expiresAt",
                      value: acquired.owner.expiresAt,
                    },
                  ],
            actions: [],
            correlation: { commandId: "target-lease", targetId: preparedSelection.target.id },
          },
        ],
        dependencies,
      );
      renderFailure(failure, options.format, io);
      return ExitCode.Target;
    }
    targetLease = acquired.lease;
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
    | CommandExecution<AppData>
    | CommandExecution<AppsData>
    | CommandExecution<CaptureData>
    | CommandExecution<DevicesData>
    | CommandExecution<InspectAppData>
    | CommandExecution<InspectUiData>
    | CommandExecution<UiActionData>
    | CommandExecution<AutomationRunData>
    | Awaited<ReturnType<typeof runConnect>>
    | Awaited<ReturnType<typeof runDev>>
    | Awaited<ReturnType<typeof runDoctor>>
    | CommandExecution<LogsData>
    | CommandExecution<OpenData>
    | Awaited<ReturnType<typeof runPair>>
    | Awaited<ReturnType<typeof runPorts>>;
  try {
    if (options.command === "app") {
      let destructiveApproved = options.allowDestructive === true;
      if (
        !destructiveApproved &&
        !options.dryRun &&
        (options.appAction === "clear-data" || options.appAction === "uninstall") &&
        errorCapabilities.interactive
      ) {
        const confirmation = await confirmAction({
          action: options.appAction === "clear-data" ? "Clear all app data" : "Uninstall app",
          scope: options.appId ?? values.appPackage ?? "resolved project app",
          risk: "destructive",
          nonInteractiveFlag: "--allow-destructive",
          input: io.input,
          sink: io.error,
          capabilities: errorCapabilities,
          ...(signal === undefined ? {} : { signal }),
        });
        if (confirmation.kind === "confirmed") {
          destructiveApproved = true;
        } else {
          const cancelled = failureResult(
            `app ${options.appAction}`,
            [
              inputProblem(
                ProblemCode.OperationInterrupted,
                "The destructive app action was cancelled.",
                "The Android target was not changed.",
              ),
            ],
            dependencies,
          );
          renderFailure(cancelled, options.format, io);
          return ExitCode.Interrupted;
        }
      }
      execution = await runApp(
        {
          action: options.appAction ?? "resolve",
          cwd: io.cwd,
          ...(options.appId === undefined ? {} : { applicationId: options.appId }),
          ...(values.appPackage === undefined
            ? {}
            : {
                configuredPackage: {
                  value: values.appPackage,
                  ...(loaded.config.provenance.appPackage?.location === undefined
                    ? {}
                    : { location: loaded.config.provenance.appPackage.location }),
                },
              }),
          ...(options.artifactPath === undefined ? {} : { artifactPath: options.artifactPath }),
          ...(options.activity === undefined ? {} : { activity: options.activity }),
          ...(options.replace === undefined ? {} : { replace: options.replace }),
          ...(options.grantRuntimePermissions === undefined
            ? {}
            : { grantRuntimePermissions: options.grantRuntimePermissions }),
          ...(destructiveApproved ? { destructiveApproved: true } : {}),
        },
        config,
        commandDependencies,
        signal,
      );
    } else if (options.command === "apps") {
      execution = await runApps(
        options.packageScope ?? "user",
        options.packageFilter,
        config,
        commandDependencies,
        signal,
      );
    } else if (options.command === "capture") {
      execution = await runCapture(
        {
          kind: options.captureKind ?? "screenshot",
          cwd: io.cwd,
          ...(options.outputPath === undefined ? {} : { out: options.outputPath }),
          ...(options.force === undefined ? {} : { force: options.force }),
          ...(options.durationSeconds === undefined
            ? {}
            : { durationSeconds: options.durationSeconds }),
        },
        config,
        commandDependencies,
        signal,
      );
    } else if (options.command === "inspect") {
      execution =
        options.inspectKind === "ui"
          ? await runInspectUi(
              {
                ...(options.interactiveOnly === undefined
                  ? {}
                  : { interactiveOnly: options.interactiveOnly }),
                ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
              },
              config,
              commandDependencies,
              signal,
            )
          : await runInspectApp(
              {
                cwd: io.cwd,
                ...(options.appId === undefined ? {} : { applicationId: options.appId }),
                ...(values.appPackage === undefined
                  ? {}
                  : {
                      configuredPackage: {
                        value: values.appPackage,
                        ...(loaded.config.provenance.appPackage?.location === undefined
                          ? {}
                          : { location: loaded.config.provenance.appPackage.location }),
                      },
                    }),
              },
              config,
              commandDependencies,
              signal,
            );
    } else if (options.command === "ui") {
      if (options.uiRequest === undefined) {
        throw new Error("Validated UI command is missing its action request.");
      }
      execution = await runUiAction(options.uiRequest, config, commandDependencies, signal);
    } else if (options.command === "open") {
      execution = await runOpen(
        options.url ?? "",
        options.appId ?? values.appPackage,
        config,
        commandDependencies,
        signal,
      );
    } else if (options.command === "doctor") {
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
            ? {
                onLine: (line: string) =>
                  io.error.write(`${renderLogStreamLine(line, errorCapabilities)}\n`),
              }
            : {}),
        },
        config,
        commandDependencies,
        signal,
      );
    } else if (options.command === "dev" || options.command === "run") {
      const devOptions = {
        cwd: io.cwd,
        ...(values.devPreset === undefined ? {} : { preset: values.devPreset }),
        ...(values.packageManager === undefined ? {} : { packageManager: values.packageManager }),
        ...(values.devCommand === undefined ? {} : { command: values.devCommand }),
        ...(values.devReversePorts === undefined ? {} : { reversePorts: values.devReversePorts }),
        ...(values.devLogs === undefined ? {} : { logs: values.devLogs }),
        ...(values.devCleanupPorts === undefined ? {} : { cleanupPorts: values.devCleanupPorts }),
        ...(values.devWatch === undefined ? {} : { watch: values.devWatch }),
        ...(values.devReadiness === undefined ? {} : { readiness: values.devReadiness }),
        ...(options.command === "run"
          ? {
              mode: "run" as const,
              verification: {
                command: options.runCommand ?? { executable: "", args: [] },
                timeoutMs: options.runTimeoutMs ?? 15 * 60_000,
              },
            }
          : {}),
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
        childStdin: errorCapabilities.interactive ? ("inherit" as const) : ("ignore" as const),
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
                io.error.write(`${renderChildStreamLine(stream, line, errorCapabilities)}\n`);
              },
            }
          : {}),
      } satisfies DevOptions;
      const devExecution = offlineDevPlan
        ? await runDevOfflinePlan(devOptions, commandDependencies)
        : await runDev(devOptions, config, commandDependencies, signal);
      execution =
        options.command === "run" && !options.dryRun
          ? (
              await writeEvidenceBundle(devExecution, {
                cwd: io.cwd,
                ...(io.env.GITHUB_STEP_SUMMARY === undefined
                  ? {}
                  : { githubStepSummaryPath: io.env.GITHUB_STEP_SUMMARY }),
              })
            ).execution
          : devExecution;
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
    await targetLease?.release();
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
    } else if (options.command === "dev" || options.command === "run") {
      const raw = execution.result.data as DevData | AutomationRunData | null;
      const data = raw !== null && "session" in raw ? raw.session : raw;
      if (data?.selected !== undefined) {
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
    } else if (
      options.command === "app" ||
      options.command === "apps" ||
      options.command === "capture" ||
      options.command === "inspect" ||
      options.command === "open" ||
      options.command === "ui"
    ) {
      const data = execution.result.data as
        | AppData
        | AppsData
        | CaptureData
        | InspectAppData
        | InspectUiData
        | OpenData
        | UiActionData
        | null;
      if (data !== null && "selected" in data) {
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
