import type { AgentClient } from "../agent/setup.js";
import type { AppAction, PackageScope } from "../app/app-commands.js";
import type { PortAction } from "../app/commands.js";
import type { DevPreset, PackageManagerName } from "../dev/project.js";
import type {
  UiAction,
  UiActionRequest,
  UiDirection,
  UiKey,
  UiWaitState,
} from "../evidence/ui-actions.js";
import type { PortDirection } from "../ports/model.js";

export type CommandName =
  | "agent"
  | "app"
  | "apps"
  | "capture"
  | "config"
  | "connect"
  | "context"
  | "dev"
  | "devices"
  | "doctor"
  | "help"
  | "init"
  | "inspect"
  | "logs"
  | "mcp"
  | "open"
  | "pair"
  | "ports"
  | "problems"
  | "run"
  | "sessions"
  | "ui"
  | "version";
export type OutputFormat = "human" | "json" | "markdown" | "ndjson" | "plain";
export type ContextFilter =
  | "child"
  | "logs"
  | "ports"
  | "problems"
  | "recovery"
  | "state"
  | "target";

export interface CliOptions {
  command: CommandName;
  helpTarget?: Exclude<CommandName, "help" | "version">;
  format: OutputFormat;
  quiet: boolean;
  verbose: boolean;
  nonInteractive: boolean;
  color?: boolean;
  unicode?: boolean;
  animation?: boolean;
  timeoutMs?: number;
  adbPath?: string;
  adbHost?: string;
  adbPort?: number;
  configPath?: string;
  profileName?: string;
  select: boolean;
  device?: string;
  transportId?: string;
  endpoint?: string;
  pairingCodeStdin: boolean;
  remembered: boolean;
  dryRun: boolean;
  allProjects: boolean;
  portDirection?: PortDirection;
  portAction?: PortAction;
  primaryPort?: string;
  secondaryPort?: string;
  preset?: DevPreset;
  packageManager?: PackageManagerName;
  reversePorts?: string[];
  logs?: boolean;
  cleanupPorts?: boolean;
  customCommand?: { executable: string; args: string[] };
  runCommand?: { executable: string; args: string[] };
  runTimeoutMs?: number;
  sessionAction?: "events" | "list" | "show";
  sessionId?: string;
  sessionStatus?: "completed" | "failed" | "interrupted" | "running";
  sessionSinceMs?: number;
  sessionLimit?: number;
  logPackage?: string;
  logPid?: number;
  logTags?: string[];
  logExcludeTags?: string[];
  logPriority?: "A" | "D" | "E" | "F" | "I" | "S" | "V" | "W";
  logBuffers?: Array<"crash" | "main" | "system">;
  logSince?: string;
  logTail?: number;
  logDump?: boolean;
  logMaxRecords?: number;
  contextBudget?: number;
  contextSinceMs?: number;
  contextOnly?: ContextFilter[];
  configAction?: "explain" | "validate";
  force?: boolean;
  appAction?: AppAction;
  appId?: string;
  artifactPath?: string;
  artifactPaths?: string[];
  activity?: string;
  packageScope?: PackageScope;
  replace?: boolean;
  grantRuntimePermissions?: boolean;
  allowDestructive?: boolean;
  url?: string;
  packageFilter?: string;
  captureKind?: "screen-record" | "screenshot";
  outputPath?: string;
  durationSeconds?: number;
  inspectKind?: "app" | "ui";
  interactiveOnly?: boolean;
  maxDepth?: number;
  agentClient?: AgentClient;
  uiRequest?: UiActionRequest;
}

export interface CliParseFailure {
  ok: false;
  code: "CLI_INVALID_OPTION" | "CLI_INVALID_VALUE" | "CLI_USAGE";
  message: string;
  option?: string;
}

export interface CliParseSuccess {
  ok: true;
  options: CliOptions;
}

export type CliParseResult = CliParseFailure | CliParseSuccess;

const COMMANDS = new Set<CommandName>([
  "agent",
  "app",
  "apps",
  "capture",
  "config",
  "connect",
  "context",
  "dev",
  "devices",
  "doctor",
  "help",
  "init",
  "inspect",
  "logs",
  "mcp",
  "open",
  "pair",
  "ports",
  "problems",
  "run",
  "sessions",
  "ui",
  "version",
]);
const UI_ACTIONS = new Set<UiAction>([
  "assert",
  "compare",
  "find",
  "long-press",
  "press",
  "swipe",
  "tap",
  "type",
  "wait",
]);
const APP_ACTIONS = new Set<AppAction>([
  "clear-data",
  "info",
  "install",
  "launch",
  "resolve",
  "restart",
  "stop",
  "uninstall",
]);
const AGENT_CLIENTS = new Set<AgentClient>([
  "claude-code",
  "codex",
  "cursor",
  "generic",
  "vscode",
  "windsurf",
]);
const BOOLEAN_OPTIONS = new Set([
  "-h",
  "--help",
  "-V",
  "--version",
  "--json",
  "--quiet",
  "--verbose",
  "--non-interactive",
  "--color",
  "--no-color",
  "--unicode",
  "--no-unicode",
  "--animation",
  "--no-animation",
  "--select",
  "--pairing-code-stdin",
  "--last",
  "--dry-run",
  "--logs",
  "--no-logs",
  "--cleanup-ports",
  "--no-cleanup-ports",
  "--dump",
  "--force",
  "--replace",
  "--grant-runtime-permissions",
  "--allow-destructive",
  "--user",
  "--system",
  "--all",
  "--all-projects",
  "--interactive-only",
  "--submit",
]);

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function suggestion(value: string, candidates: Iterable<string>): string {
  const ranked = [...candidates]
    .map((candidate) => ({ candidate, distance: editDistance(value, candidate) }))
    .sort(
      (left, right) =>
        left.distance - right.distance || left.candidate.localeCompare(right.candidate),
    );
  const best = ranked[0];
  const threshold = value.length <= 4 ? 1 : 2;
  return best !== undefined && best.distance <= threshold ? `Did you mean ${best.candidate}?` : "";
}

function failure(code: CliParseFailure["code"], message: string, option?: string): CliParseFailure {
  return { ok: false, code, message, ...(option === undefined ? {} : { option }) };
}

function parseDuration(value: string): number | undefined {
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/u);
  if (match === null) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  const milliseconds = amount * multiplier;
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

function splitLongOption(argument: string): { option: string; inlineValue?: string } {
  const separator = argument.indexOf("=");
  if (separator === -1) {
    return { option: argument };
  }
  return { option: argument.slice(0, separator), inlineValue: argument.slice(separator + 1) };
}

export function parseArguments(argv: readonly string[]): CliParseResult {
  let command: CommandName | undefined;
  let helpTarget: CliOptions["helpTarget"];
  let format: OutputFormat = "human";
  let quiet = false;
  let verbose = false;
  let nonInteractive = false;
  let color: boolean | undefined;
  let unicode: boolean | undefined;
  let animation: boolean | undefined;
  let timeoutMs: number | undefined;
  let adbPath: string | undefined;
  let adbHost: string | undefined;
  let adbPort: number | undefined;
  let configPath: string | undefined;
  let profileName: string | undefined;
  let select = false;
  let device: string | undefined;
  let transportId: string | undefined;
  let endpoint: string | undefined;
  let pairingCodeStdin = false;
  let remembered = false;
  let dryRun = false;
  let allProjects = false;
  let portDirection: PortDirection | undefined;
  let portAction: PortAction | undefined;
  let primaryPort: string | undefined;
  let secondaryPort: string | undefined;
  let preset: DevPreset | undefined;
  let packageManager: PackageManagerName | undefined;
  const reversePorts: string[] = [];
  let logs: boolean | undefined;
  let cleanupPorts: boolean | undefined;
  let customCommand: CliOptions["customCommand"];
  let runCommand: CliOptions["runCommand"];
  let runTimeoutMs: number | undefined;
  let sessionAction: CliOptions["sessionAction"];
  let sessionId: string | undefined;
  let sessionStatus: CliOptions["sessionStatus"];
  let sessionSinceMs: number | undefined;
  let sessionLimit: number | undefined;
  let logPackage: string | undefined;
  let logPid: number | undefined;
  const logTags: string[] = [];
  const logExcludeTags: string[] = [];
  let logPriority: CliOptions["logPriority"];
  const logBuffers: NonNullable<CliOptions["logBuffers"]> = [];
  let logSince: string | undefined;
  let logTail: number | undefined;
  let logDump = false;
  let logMaxRecords: number | undefined;
  let contextBudget: number | undefined;
  let contextSinceMs: number | undefined;
  const contextOnly: ContextFilter[] = [];
  let configAction: CliOptions["configAction"];
  let force = false;
  let appAction: AppAction | undefined;
  let appId: string | undefined;
  const artifactPaths: string[] = [];
  let activity: string | undefined;
  let packageScope: PackageScope | undefined;
  let replace = false;
  let grantRuntimePermissions = false;
  let allowDestructive = false;
  let url: string | undefined;
  let packageOption: string | undefined;
  let appsListSeen = false;
  let packageFilter: string | undefined;
  let captureKind: CliOptions["captureKind"];
  let outputPath: string | undefined;
  let durationSeconds: number | undefined;
  let inspectKind: CliOptions["inspectKind"];
  let interactiveOnly = false;
  let maxDepth: number | undefined;
  let agentSetupSeen = false;
  let agentClient: AgentClient | undefined;
  let uiAction: UiAction | undefined;
  const uiOperands: string[] = [];
  let uiWaitState: UiWaitState | undefined;
  let uiSubmit = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }

    if (argument === "--") {
      if (command !== "dev" && command !== "run") {
        return failure("CLI_USAGE", "-- command passthrough can only be used with dev or run.");
      }
      const executable = argv[index + 1];
      if (executable === undefined || executable.trim() === "") {
        return failure("CLI_USAGE", `${command} -- requires an executable.`);
      }
      const passthrough = { executable, args: argv.slice(index + 2) };
      if (command === "run") runCommand = passthrough;
      else customCommand = passthrough;
      break;
    }

    if (!argument.startsWith("-")) {
      if (command === undefined) {
        if (!COMMANDS.has(argument as CommandName)) {
          const hint = suggestion(argument, COMMANDS);
          return failure(
            "CLI_USAGE",
            `Unknown command: ${argument}${hint === "" ? "" : `. ${hint}`}`,
          );
        }
        const candidate = argument as CommandName;
        command = candidate;
        continue;
      }
      if (command === "help" && COMMANDS.has(argument as CommandName)) {
        const candidate = argument as CommandName;
        if (
          candidate === "agent" ||
          candidate === "app" ||
          candidate === "apps" ||
          candidate === "capture" ||
          candidate === "connect" ||
          candidate === "config" ||
          candidate === "context" ||
          candidate === "dev" ||
          candidate === "devices" ||
          candidate === "doctor" ||
          candidate === "logs" ||
          candidate === "mcp" ||
          candidate === "open" ||
          candidate === "init" ||
          candidate === "inspect" ||
          candidate === "pair" ||
          candidate === "ports" ||
          candidate === "problems" ||
          candidate === "run" ||
          candidate === "sessions" ||
          candidate === "ui"
        ) {
          helpTarget = candidate;
          continue;
        }
      }
      if ((command === "connect" || command === "pair") && endpoint === undefined) {
        endpoint = argument;
        continue;
      }
      if (command === "agent" && argument === "setup" && !agentSetupSeen) {
        agentSetupSeen = true;
        continue;
      }
      if (command === "agent" && agentSetupSeen && agentClient === undefined) {
        if (!AGENT_CLIENTS.has(argument as AgentClient)) {
          return failure(
            "CLI_INVALID_VALUE",
            `Invalid agent client: ${argument}. Expected codex, claude-code, cursor, vscode, windsurf, or generic.`,
          );
        }
        agentClient = argument as AgentClient;
        continue;
      }
      if (command === "apps" && argument === "list" && !appsListSeen) {
        appsListSeen = true;
        continue;
      }
      if (command === "app") {
        if (appAction === undefined && APP_ACTIONS.has(argument as AppAction)) {
          appAction = argument as AppAction;
          continue;
        }
        if (appAction === "install") {
          artifactPaths.push(argument);
          continue;
        }
        if (appAction !== undefined && appId === undefined) {
          if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u.test(argument)) {
            return failure("CLI_INVALID_VALUE", `Invalid Android application ID: ${argument}.`);
          }
          appId = argument;
          continue;
        }
      }
      if (command === "open" && url === undefined) {
        url = argument;
        continue;
      }
      if (
        command === "capture" &&
        captureKind === undefined &&
        (argument === "screenshot" || argument === "screen-record")
      ) {
        captureKind = argument;
        continue;
      }
      if (
        command === "inspect" &&
        inspectKind === undefined &&
        (argument === "app" || argument === "ui")
      ) {
        inspectKind = argument;
        continue;
      }
      if (command === "inspect" && inspectKind === "app" && appId === undefined) {
        if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u.test(argument)) {
          return failure("CLI_INVALID_VALUE", `Invalid Android application ID: ${argument}.`);
        }
        appId = argument;
        continue;
      }
      if (command === "ui") {
        if (uiAction === undefined) {
          if (!UI_ACTIONS.has(argument as UiAction)) {
            return failure(
              "CLI_INVALID_VALUE",
              `Invalid UI action: ${argument}. Expected find, assert, compare, tap, long-press, swipe, type, press, or wait.`,
            );
          }
          uiAction = argument as UiAction;
        } else {
          uiOperands.push(argument);
        }
        continue;
      }
      if (command === "sessions") {
        if (
          sessionAction === undefined &&
          (argument === "events" || argument === "list" || argument === "show")
        ) {
          sessionAction = argument;
          continue;
        }
        if (
          (sessionAction === "events" || sessionAction === "show") &&
          sessionId === undefined &&
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(argument)
        ) {
          sessionId = argument;
          continue;
        }
      }
      if (
        command === "config" &&
        configAction === undefined &&
        (argument === "explain" || argument === "validate")
      ) {
        configAction = argument;
        continue;
      }
      if (
        command === "problems" &&
        sessionId === undefined &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(argument)
      ) {
        sessionId = argument;
        continue;
      }
      if (
        command === "context" &&
        sessionId === undefined &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(argument)
      ) {
        sessionId = argument;
        continue;
      }
      if (command === "ports") {
        if (portDirection === undefined && (argument === "forward" || argument === "reverse")) {
          portDirection = argument;
          continue;
        }
        if (
          portDirection !== undefined &&
          portAction === undefined &&
          (argument === "add" || argument === "list" || argument === "remove")
        ) {
          portAction = argument;
          continue;
        }
        if (portAction !== undefined && portAction !== "list" && primaryPort === undefined) {
          primaryPort = argument;
          continue;
        }
        if (portAction === "add" && secondaryPort === undefined) {
          secondaryPort = argument;
          continue;
        }
      }
      return failure("CLI_USAGE", `Unexpected argument: ${argument}`);
    }

    const { option, inlineValue } = splitLongOption(argument);
    if (inlineValue !== undefined && BOOLEAN_OPTIONS.has(option)) {
      return failure("CLI_INVALID_OPTION", `${option} does not accept a value.`, option);
    }
    const readValue = (): CliParseFailure | string => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return failure("CLI_INVALID_VALUE", `${option} requires a value.`, option);
      }
      index += 1;
      return value;
    };

    if (option === "-h" || option === "--help") {
      if (command !== undefined && command !== "help" && command !== "version") {
        helpTarget = command;
      }
      command = "help";
    } else if (option === "-V" || option === "--version") {
      command = "version";
    } else if (option === "--json") {
      format = "json";
    } else if (option === "--format") {
      const value = readValue();
      if (typeof value !== "string") {
        return value;
      }
      if (
        !new Set<OutputFormat>(["human", "json", "markdown", "ndjson", "plain"]).has(
          value as OutputFormat,
        )
      ) {
        return failure(
          "CLI_INVALID_VALUE",
          `Invalid format: ${value}. Expected human, plain, markdown, json, or ndjson.`,
          option,
        );
      }
      format = value as OutputFormat;
    } else if (option === "--quiet") {
      quiet = true;
    } else if (option === "--verbose") {
      verbose = true;
    } else if (option === "--non-interactive") {
      nonInteractive = true;
    } else if (option === "--color") {
      color = true;
    } else if (option === "--no-color") {
      color = false;
    } else if (option === "--unicode") {
      unicode = true;
    } else if (option === "--no-unicode") {
      unicode = false;
    } else if (option === "--animation") {
      animation = true;
    } else if (option === "--no-animation") {
      animation = false;
    } else if (option === "--select") {
      select = true;
    } else if (option === "--device" || option === "--serial" || option === "-s") {
      const value = readValue();
      if (typeof value !== "string") {
        return value;
      }
      if (value.trim() === "") {
        return failure("CLI_INVALID_VALUE", `${option} cannot be empty.`, option);
      }
      device = value;
    } else if (option === "--transport-id") {
      const value = readValue();
      if (typeof value !== "string") {
        return value;
      }
      if (!/^\d+$/u.test(value)) {
        return failure("CLI_INVALID_VALUE", `Invalid transport ID: ${value}.`, option);
      }
      transportId = value;
    } else if (option === "--pairing-code-stdin") {
      pairingCodeStdin = true;
    } else if (option === "--last") {
      remembered = true;
    } else if (option === "--dry-run") {
      dryRun = true;
    } else if (option === "--all-projects") {
      allProjects = true;
    } else if (option === "--preset") {
      const value = readValue();
      if (typeof value !== "string") return value;
      if (
        !new Set<DevPreset>(["custom", "expo", "gradle", "react-native"]).has(value as DevPreset)
      ) {
        return failure(
          "CLI_INVALID_VALUE",
          `Invalid preset: ${value}. Expected custom, expo, gradle, or react-native.`,
          option,
        );
      }
      preset = value as DevPreset;
    } else if (option === "--package-manager") {
      const value = readValue();
      if (typeof value !== "string") return value;
      if (
        !new Set<PackageManagerName>(["bun", "npm", "pnpm", "yarn"]).has(
          value as PackageManagerName,
        )
      ) {
        return failure(
          "CLI_INVALID_VALUE",
          `Invalid package manager: ${value}. Expected bun, npm, pnpm, or yarn.`,
          option,
        );
      }
      packageManager = value as PackageManagerName;
    } else if (option === "--port") {
      const value = readValue();
      if (typeof value !== "string") return value;
      const parsed = Number(value);
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
        return failure("CLI_INVALID_VALUE", `Invalid reverse port: ${value}.`, option);
      }
      reversePorts.push(value);
    } else if (option === "--logs") {
      logs = true;
    } else if (option === "--no-logs") {
      logs = false;
    } else if (option === "--cleanup-ports") {
      cleanupPorts = true;
    } else if (option === "--no-cleanup-ports") {
      cleanupPorts = false;
    } else if (option === "--package") {
      const value = readValue();
      if (typeof value !== "string") return value;
      if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u.test(value)) {
        return failure("CLI_INVALID_VALUE", `Invalid Android package name: ${value}.`, option);
      }
      packageOption = value;
    } else if (option === "--pid") {
      const value = readValue();
      if (typeof value !== "string") return value;
      const parsed = Number(value);
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
        return failure("CLI_INVALID_VALUE", `Invalid process ID: ${value}.`, option);
      }
      logPid = parsed;
    } else if (option === "--tag") {
      const value = readValue();
      if (typeof value !== "string") return value;
      if (!/^[^\s:]{1,128}$/u.test(value)) {
        return failure("CLI_INVALID_VALUE", `Invalid log tag: ${value}.`, option);
      }
      logTags.push(value);
    } else if (option === "--exclude-tag") {
      const value = readValue();
      if (typeof value !== "string") return value;
      if (!/^[^\s:]{1,128}$/u.test(value)) {
        return failure("CLI_INVALID_VALUE", `Invalid excluded log tag: ${value}.`, option);
      }
      logExcludeTags.push(value);
    } else if (option === "--buffer") {
      const value = readValue();
      if (typeof value !== "string") return value;
      if (value !== "main" && value !== "system" && value !== "crash") {
        return failure(
          "CLI_INVALID_VALUE",
          `Invalid log buffer: ${value}. Expected main, system, or crash.`,
          option,
        );
      }
      logBuffers.push(value);
    } else if (option === "--since") {
      const value = readValue();
      if (typeof value !== "string") return value;
      if (command === "context" || command === "sessions") {
        const parsed = parseDuration(value);
        if (parsed === undefined) {
          return failure(
            "CLI_INVALID_VALUE",
            `Invalid duration: ${value}. Use a value such as 30s, 5m, or 1h.`,
            option,
          );
        }
        if (command === "context") contextSinceMs = parsed;
        else sessionSinceMs = parsed;
      } else if (!/^[0-9][0-9 .:-]{0,63}$/u.test(value)) {
        return failure(
          "CLI_INVALID_VALUE",
          `Invalid log start time: ${value}. Use an Android logcat timestamp.`,
          option,
        );
      } else {
        logSince = value;
      }
    } else if (option === "--status") {
      const value = readValue();
      if (typeof value !== "string") return value;
      if (
        command !== "sessions" ||
        !new Set(["completed", "failed", "interrupted", "running"]).has(value)
      ) {
        return failure(
          "CLI_INVALID_VALUE",
          `Invalid session status: ${value}. Expected running, completed, failed, or interrupted.`,
          option,
        );
      }
      sessionStatus = value as NonNullable<CliOptions["sessionStatus"]>;
    } else if (option === "--limit") {
      const value = readValue();
      if (typeof value !== "string") return value;
      const parsed = Number(value);
      if (
        command !== "sessions" ||
        !/^\d+$/u.test(value) ||
        !Number.isSafeInteger(parsed) ||
        parsed < 1 ||
        parsed > 100
      ) {
        return failure(
          "CLI_INVALID_VALUE",
          `Invalid session limit: ${value}. Expected an integer from 1 to 100.`,
          option,
        );
      }
      sessionLimit = parsed;
    } else if (option === "--only") {
      const value = readValue();
      if (typeof value !== "string") return value;
      const filters = value.split(",").filter((item) => item !== "");
      const allowed = new Set<ContextFilter>([
        "child",
        "logs",
        "ports",
        "problems",
        "recovery",
        "state",
        "target",
      ]);
      if (
        command !== "context" ||
        filters.length === 0 ||
        filters.some((item) => !allowed.has(item as ContextFilter))
      ) {
        return failure("CLI_INVALID_VALUE", `Invalid context filters: ${value}.`, option);
      }
      contextOnly.push(...(filters as ContextFilter[]));
    } else if (option === "--tail") {
      const value = readValue();
      if (typeof value !== "string") return value;
      const parsed = Number(value);
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
        return failure("CLI_INVALID_VALUE", `Invalid log tail count: ${value}.`, option);
      }
      logTail = parsed;
    } else if (option === "--level") {
      const value = readValue();
      if (typeof value !== "string") return value;
      const normalized = value.toUpperCase();
      if (!new Set(["A", "D", "E", "F", "I", "S", "V", "W"]).has(normalized)) {
        return failure("CLI_INVALID_VALUE", `Invalid log priority: ${value}.`, option);
      }
      logPriority = normalized as NonNullable<CliOptions["logPriority"]>;
    } else if (option === "--dump") {
      logDump = true;
    } else if (option === "--force") {
      force = true;
    } else if (option === "--out") {
      const value = readValue();
      if (typeof value !== "string") return value;
      if (value.trim() === "" || value.length > 1_024) {
        return failure("CLI_INVALID_VALUE", "--out must be a non-empty relative path.", option);
      }
      outputPath = value;
    } else if (option === "--duration") {
      const value = readValue();
      if (typeof value !== "string") return value;
      const milliseconds = parseDuration(value);
      if (
        milliseconds === undefined ||
        milliseconds % 1_000 !== 0 ||
        milliseconds < 1_000 ||
        milliseconds > 180_000
      ) {
        return failure(
          "CLI_INVALID_VALUE",
          `Invalid recording duration: ${value}. Use whole seconds from 1s to 180s.`,
          option,
        );
      }
      durationSeconds = milliseconds / 1_000;
    } else if (option === "--interactive-only") {
      interactiveOnly = true;
    } else if (option === "--submit") {
      uiSubmit = true;
    } else if (option === "--state") {
      const value = readValue();
      if (typeof value !== "string") return value;
      if (value !== "visible" && value !== "gone") {
        return failure("CLI_INVALID_VALUE", `Invalid UI wait state: ${value}.`, option);
      }
      uiWaitState = value;
    } else if (option === "--max-depth") {
      const value = readValue();
      if (typeof value !== "string") return value;
      const parsed = Number(value);
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
        return failure("CLI_INVALID_VALUE", `Invalid UI depth: ${value}. Expected 1-100.`, option);
      }
      maxDepth = parsed;
    } else if (option === "--activity") {
      const value = readValue();
      if (typeof value !== "string") return value;
      if (!/^[A-Za-z0-9_.$]+(?:\/[A-Za-z0-9_.$]+)?$/u.test(value)) {
        return failure("CLI_INVALID_VALUE", `Invalid Android activity: ${value}.`, option);
      }
      activity = value;
    } else if (option === "--filter") {
      const value = readValue();
      if (typeof value !== "string") return value;
      if (value.trim() === "" || value.length > 256) {
        return failure("CLI_INVALID_VALUE", "--filter must be 1-256 characters.", option);
      }
      packageFilter = value;
    } else if (option === "--replace") {
      replace = true;
    } else if (option === "--grant-runtime-permissions") {
      grantRuntimePermissions = true;
    } else if (option === "--allow-destructive") {
      allowDestructive = true;
    } else if (option === "--user" || option === "--system" || option === "--all") {
      const nextScope: PackageScope =
        option === "--user" ? "user" : option === "--system" ? "system" : "all";
      if (packageScope !== undefined && packageScope !== nextScope) {
        return failure("CLI_USAGE", "Choose only one of --user, --system, or --all.");
      }
      packageScope = nextScope;
    } else if (option === "--max-records") {
      const value = readValue();
      if (typeof value !== "string") return value;
      const parsed = Number(value);
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
        return failure("CLI_INVALID_VALUE", `Invalid record limit: ${value}.`, option);
      }
      logMaxRecords = parsed;
    } else if (option === "--budget") {
      const value = readValue();
      if (typeof value !== "string") return value;
      const parsed = Number(value);
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed < 1_000) {
        return failure(
          "CLI_INVALID_VALUE",
          `Invalid context budget: ${value}. Expected at least 1000 characters.`,
          option,
        );
      }
      contextBudget = parsed;
    } else if (option === "--timeout") {
      const value = readValue();
      if (typeof value !== "string") {
        return value;
      }
      timeoutMs = parseDuration(value);
      if (timeoutMs === undefined) {
        return failure(
          "CLI_INVALID_VALUE",
          `Invalid timeout: ${value}. Use a positive duration such as 500ms, 5s, or 1m.`,
          option,
        );
      }
    } else if (option === "--run-timeout") {
      const value = readValue();
      if (typeof value !== "string") return value;
      runTimeoutMs = parseDuration(value);
      if (runTimeoutMs === undefined) {
        return failure(
          "CLI_INVALID_VALUE",
          `Invalid run timeout: ${value}. Use a positive duration such as 30s or 10m.`,
          option,
        );
      }
    } else if (option === "--adb") {
      const value = readValue();
      if (typeof value !== "string") {
        return value;
      }
      if (value.trim() === "") {
        return failure("CLI_INVALID_VALUE", "--adb cannot be empty.", option);
      }
      adbPath = value;
    } else if (option === "--adb-host") {
      const value = readValue();
      if (typeof value !== "string") {
        return value;
      }
      if (value.trim() === "") {
        return failure("CLI_INVALID_VALUE", "--adb-host cannot be empty.", option);
      }
      adbHost = value;
    } else if (option === "--adb-port") {
      const value = readValue();
      if (typeof value !== "string") {
        return value;
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
        return failure("CLI_INVALID_VALUE", `Invalid ADB server port: ${value}.`, option);
      }
      adbPort = parsed;
    } else if (option === "--config") {
      const value = readValue();
      if (typeof value !== "string") {
        return value;
      }
      if (value.trim() === "") {
        return failure("CLI_INVALID_VALUE", "--config cannot be empty.", option);
      }
      configPath = value;
    } else if (option === "--profile") {
      const value = readValue();
      if (typeof value !== "string") {
        return value;
      }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(value)) {
        return failure("CLI_INVALID_VALUE", `Invalid profile name: ${value}.`, option);
      }
      profileName = value;
    } else {
      const knownOptions = new Set([
        ...BOOLEAN_OPTIONS,
        "--format",
        "--timeout",
        "--adb",
        "--adb-host",
        "--adb-port",
        "--config",
        "--profile",
        "--device",
        "--serial",
        "--transport-id",
        "--preset",
        "--package-manager",
        "--port",
        "--package",
        "--pid",
        "--tag",
        "--exclude-tag",
        "--buffer",
        "--since",
        "--only",
        "--status",
        "--limit",
        "--tail",
        "--level",
        "--out",
        "--duration",
        "--state",
        "--max-depth",
        "--activity",
        "--filter",
        "--max-records",
        "--budget",
        "--run-timeout",
      ]);
      const hint = suggestion(option, knownOptions);
      return failure(
        "CLI_INVALID_OPTION",
        `Unknown option: ${option}${hint === "" ? "" : `. ${hint}`}`,
        option,
      );
    }
  }

  if (quiet && verbose) {
    return failure("CLI_USAGE", "--quiet and --verbose cannot be used together.");
  }

  command ??= "help";
  if (allProjects && command !== "sessions" && command !== "problems" && command !== "context") {
    return failure(
      "CLI_USAGE",
      "--all-projects can only be used with sessions, problems, or context.",
      "--all-projects",
    );
  }
  if (packageOption !== undefined) {
    if (command === "logs") logPackage = packageOption;
    else if (
      command === "app" ||
      command === "open" ||
      (command === "inspect" && inspectKind === "app")
    )
      appId = packageOption;
    else
      return failure(
        "CLI_USAGE",
        "--package can only be used with app, inspect app, logs, or open.",
      );
  }
  if (command === "apps") packageScope ??= "user";
  if (command === "config") configAction ??= "validate";
  if (command === "context" && format === "human") format = "markdown";
  if (command === "sessions") sessionAction ??= "list";
  if (
    command === "sessions" &&
    sessionAction !== "list" &&
    (sessionStatus !== undefined || sessionSinceMs !== undefined || sessionLimit !== undefined)
  ) {
    return failure("CLI_USAGE", "--status, --since, and --limit apply only to sessions list.");
  }
  const targetCommand =
    command === "app" ||
    command === "apps" ||
    command === "capture" ||
    command === "dev" ||
    command === "devices" ||
    command === "inspect" ||
    command === "logs" ||
    command === "open" ||
    command === "ports" ||
    command === "run" ||
    command === "ui";
  if (select && !targetCommand) {
    return failure(
      "CLI_USAGE",
      "--select can only be used with a target-aware command.",
      "--select",
    );
  }
  if ((device !== undefined || transportId !== undefined) && !targetCommand) {
    return failure(
      "CLI_USAGE",
      "Target selection options can only be used with a target-aware command.",
    );
  }
  if (select && nonInteractive) {
    return failure("CLI_USAGE", "--select cannot be combined with --non-interactive.", "--select");
  }
  if (select && format !== "human") {
    return failure("CLI_USAGE", "--select can only be used with human output.", "--select");
  }
  if (select && (device !== undefined || transportId !== undefined)) {
    return failure("CLI_USAGE", "--select cannot be combined with an explicit target selector.");
  }
  if (device !== undefined && transportId !== undefined) {
    return failure("CLI_USAGE", "--device and --transport-id cannot be combined.");
  }
  if (pairingCodeStdin && command !== "pair") {
    return failure(
      "CLI_USAGE",
      "--pairing-code-stdin can only be used with the pair command.",
      "--pairing-code-stdin",
    );
  }
  if (remembered && !targetCommand) {
    return failure("CLI_USAGE", "--last can only be used with a target-aware command.", "--last");
  }
  if (remembered && (select || device !== undefined || transportId !== undefined)) {
    return failure("CLI_USAGE", "--last cannot be combined with another target selector.");
  }
  if (
    dryRun &&
    command !== "connect" &&
    command !== "dev" &&
    command !== "run" &&
    command !== "app" &&
    command !== "open" &&
    command !== "pair" &&
    command !== "ports" &&
    command !== "init" &&
    command !== "agent" &&
    command !== "ui"
  ) {
    return failure(
      "CLI_USAGE",
      "--dry-run can only be used with app, connect, dev, run, init, open, pair, or ports.",
      "--dry-run",
    );
  }
  if (command === "ports") {
    if (portDirection === undefined) {
      return failure("CLI_USAGE", "ports requires a direction: reverse or forward.");
    }
    if (portAction === undefined) {
      return failure("CLI_USAGE", `ports ${portDirection} requires list, add, or remove.`);
    }
    if (portAction === "list" && (primaryPort !== undefined || secondaryPort !== undefined)) {
      return failure("CLI_USAGE", `ports ${portDirection} list does not accept a port.`);
    }
    if (portAction !== "list" && primaryPort === undefined) {
      return failure("CLI_USAGE", `ports ${portDirection} ${portAction} requires a listen port.`);
    }
    if (portAction === "remove" && secondaryPort !== undefined) {
      return failure("CLI_USAGE", `ports ${portDirection} remove accepts one port.`);
    }
  }
  if (command === "app") {
    if (appAction === undefined) return failure("CLI_USAGE", "app requires an action.");
    if (appAction === "install" && artifactPaths.length === 0) {
      return failure("CLI_USAGE", "app install requires one or more APK paths.");
    }
    if (appAction !== "install" && artifactPaths.length > 0) {
      return failure("CLI_USAGE", `app ${appAction} does not accept an artifact path.`);
    }
  }
  if (command === "open" && url === undefined) return failure("CLI_USAGE", "open requires a URL.");
  if (command === "capture" && captureKind === undefined) {
    return failure("CLI_USAGE", "capture requires screenshot or screen-record.");
  }
  if (command === "inspect" && inspectKind === undefined) {
    return failure("CLI_USAGE", "inspect requires app or ui.");
  }
  let uiRequest: UiActionRequest | undefined;
  if (command === "ui") {
    if (uiAction === undefined) return failure("CLI_USAGE", "ui requires an action.");
    const coordinate = (value: string | undefined): number | undefined => {
      if (value === undefined || !/^\d+$/u.test(value)) return undefined;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed <= 100_000 ? parsed : undefined;
    };
    const selector = (value: string | undefined): string | undefined =>
      value !== undefined && /^(?:class|desc|id|package|text)=.{1,256}$/u.test(value)
        ? value
        : undefined;
    if (uiAction === "tap" || uiAction === "long-press") {
      const [first, second] = uiOperands;
      const x = coordinate(first);
      const y = coordinate(second);
      if (uiOperands.length === 1 && /^ui:[a-f0-9]{12}:\d+$/u.test(first ?? ""))
        uiRequest =
          uiAction === "tap"
            ? { action: "tap", ref: first ?? "" }
            : { action: "long-press", ref: first ?? "" };
      else if (uiOperands.length === 2 && x !== undefined && y !== undefined)
        uiRequest = uiAction === "tap" ? { action: "tap", x, y } : { action: "long-press", x, y };
      else if (uiOperands.length === 1 && selector(first) !== undefined)
        uiRequest =
          uiAction === "tap"
            ? { action: "tap", selector: first ?? "" }
            : { action: "long-press", selector: first ?? "" };
      else
        return failure(
          "CLI_USAGE",
          `ui ${uiAction} requires one selector, current UI ref, or two integer coordinates.`,
        );
    } else if (uiAction === "swipe") {
      const direction = uiOperands[0] as UiDirection | undefined;
      if (
        uiOperands.length === 1 &&
        direction !== undefined &&
        new Set<UiDirection>(["down", "left", "right", "up"]).has(direction)
      ) {
        uiRequest = { action: "swipe", direction };
      } else if (uiOperands.length === 4) {
        const values = uiOperands.map(coordinate);
        if (values.some((value) => value === undefined)) {
          return failure("CLI_INVALID_VALUE", "UI swipe coordinates must be bounded integers.");
        }
        uiRequest = {
          action: "swipe",
          x1: values[0] ?? 0,
          y1: values[1] ?? 0,
          x2: values[2] ?? 0,
          y2: values[3] ?? 0,
        };
      } else {
        return failure(
          "CLI_USAGE",
          "ui swipe requires up, down, left, right, or four integer coordinates.",
        );
      }
    } else if (uiAction === "type") {
      if (uiOperands.length !== 1) return failure("CLI_USAGE", "ui type requires one text value.");
      uiRequest = {
        action: "type",
        text: uiOperands[0] ?? "",
        ...(uiSubmit ? { submit: true } : {}),
      };
    } else if (uiAction === "press") {
      const key = uiOperands[0] as UiKey | undefined;
      if (
        uiOperands.length !== 1 ||
        key === undefined ||
        !new Set<UiKey>(["back", "enter", "home", "menu", "volume-down", "volume-up"]).has(key)
      ) {
        return failure(
          "CLI_INVALID_VALUE",
          "ui press requires back, home, enter, menu, volume-up, or volume-down.",
        );
      }
      uiRequest = { action: "press", key };
    } else if (uiAction === "find" || uiAction === "assert") {
      const selected = selector(uiOperands[0]);
      if (uiOperands.length !== 1 || selected === undefined) {
        return failure("CLI_USAGE", `ui ${uiAction} requires one valid selector.`);
      }
      uiRequest =
        uiAction === "find"
          ? { action: "find", selector: selected }
          : {
              action: "assert",
              selector: selected,
              ...(uiWaitState === undefined ? {} : { state: uiWaitState }),
            };
    } else if (uiAction === "compare") {
      const digest = uiOperands[0];
      if (uiOperands.length !== 1 || digest === undefined || !/^[a-f0-9]{64}$/u.test(digest)) {
        return failure("CLI_USAGE", "ui compare requires one complete lowercase UI digest.");
      }
      uiRequest = { action: "compare", digest };
    } else {
      if (uiOperands.length !== 1) {
        return failure("CLI_USAGE", "ui wait requires one exact selector.");
      }
      uiRequest = {
        action: "wait",
        selector: uiOperands[0] ?? "",
        ...(uiWaitState === undefined ? {} : { state: uiWaitState }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };
    }
  }
  if (command === "agent" && (!agentSetupSeen || agentClient === undefined)) {
    return failure("CLI_USAGE", "agent requires setup and a supported client name.");
  }
  if (interactiveOnly && (command !== "inspect" || inspectKind !== "ui")) {
    return failure("CLI_USAGE", "--interactive-only can only be used with inspect ui.");
  }
  if (maxDepth !== undefined && (command !== "inspect" || inspectKind !== "ui")) {
    return failure("CLI_USAGE", "--max-depth can only be used with inspect ui.");
  }
  if (uiSubmit && (command !== "ui" || uiAction !== "type")) {
    return failure("CLI_USAGE", "--submit can only be used with ui type.");
  }
  if (
    uiWaitState !== undefined &&
    (command !== "ui" || (uiAction !== "wait" && uiAction !== "assert"))
  ) {
    return failure("CLI_USAGE", "--state can only be used with ui wait or ui assert.");
  }
  if (
    dryRun &&
    command === "ui" &&
    (uiAction === "wait" || uiAction === "find" || uiAction === "assert" || uiAction === "compare")
  ) {
    return failure(
      "CLI_USAGE",
      `--dry-run is not meaningful for the read-only ui ${uiAction} action.`,
    );
  }
  if (outputPath !== undefined && command !== "capture") {
    return failure("CLI_USAGE", "--out can only be used with capture.");
  }
  if (durationSeconds !== undefined && (command !== "capture" || captureKind !== "screen-record")) {
    return failure("CLI_USAGE", "--duration can only be used with capture screen-record.");
  }
  if (packageScope !== undefined && command !== "apps") {
    return failure("CLI_USAGE", "--user, --system, and --all can only be used with apps list.");
  }
  if (packageFilter !== undefined && command !== "apps") {
    return failure("CLI_USAGE", "--filter can only be used with apps list.");
  }
  if (
    (activity !== undefined || replace || grantRuntimePermissions || allowDestructive) &&
    command !== "app"
  ) {
    return failure("CLI_USAGE", "App lifecycle options can only be used with the app command.");
  }
  if (activity !== undefined && appAction !== "launch" && appAction !== "restart") {
    return failure("CLI_USAGE", "--activity can only be used with app launch or app restart.");
  }
  if ((replace || grantRuntimePermissions) && appAction !== "install") {
    return failure(
      "CLI_USAGE",
      "--replace and --grant-runtime-permissions can only be used with app install.",
    );
  }
  if (allowDestructive && appAction !== "clear-data" && appAction !== "uninstall") {
    return failure(
      "CLI_USAGE",
      "--allow-destructive can only be used with app clear-data or app uninstall.",
    );
  }
  if (
    command !== "dev" &&
    command !== "run" &&
    command !== "init" &&
    ((preset !== undefined && command !== "sessions") ||
      packageManager !== undefined ||
      reversePorts.length > 0 ||
      logs !== undefined ||
      cleanupPorts !== undefined ||
      customCommand !== undefined)
  ) {
    return failure("CLI_USAGE", "Development options can only be used with dev or run.");
  }
  if (command === "run" && runCommand === undefined) {
    return failure("CLI_USAGE", "run requires a bounded command after --.");
  }
  if (runTimeoutMs !== undefined && command !== "run") {
    return failure("CLI_USAGE", "--run-timeout can only be used with run.", "--run-timeout");
  }
  if (
    command !== "logs" &&
    (logPackage !== undefined ||
      logPid !== undefined ||
      logTags.length > 0 ||
      logExcludeTags.length > 0 ||
      logPriority !== undefined ||
      logBuffers.length > 0 ||
      logSince !== undefined ||
      logTail !== undefined ||
      logDump ||
      logMaxRecords !== undefined)
  ) {
    return failure("CLI_USAGE", "Log filtering options can only be used with the logs command.");
  }
  if (logPackage !== undefined && logPid !== undefined) {
    return failure("CLI_USAGE", "--package and --pid cannot be combined.");
  }
  if (logSince !== undefined && logTail !== undefined) {
    return failure("CLI_USAGE", "--since and --tail cannot be combined.");
  }
  if (contextBudget !== undefined && command !== "context") {
    return failure("CLI_USAGE", "--budget can only be used with the context command.");
  }
  if ((contextSinceMs !== undefined || contextOnly.length > 0) && command !== "context") {
    return failure("CLI_USAGE", "Context filtering options can only be used with context.");
  }
  if (format === "markdown" && command !== "context") {
    return failure("CLI_USAGE", "Markdown output is only available for the context command.");
  }
  if (command === "mcp" && argv.some((argument) => argument !== "mcp")) {
    return failure(
      "CLI_USAGE",
      "mcp does not accept CLI output or target options; configure the spawned stdio server through the project and environment.",
    );
  }
  if (force && command !== "init" && command !== "capture") {
    return failure("CLI_USAGE", "--force can only be used with init or capture.");
  }

  return {
    ok: true,
    options: {
      command,
      ...(helpTarget === undefined ? {} : { helpTarget }),
      format,
      quiet,
      verbose,
      nonInteractive,
      ...(color === undefined ? {} : { color }),
      ...(unicode === undefined ? {} : { unicode }),
      ...(animation === undefined ? {} : { animation }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(adbPath === undefined ? {} : { adbPath }),
      ...(adbHost === undefined ? {} : { adbHost }),
      ...(adbPort === undefined ? {} : { adbPort }),
      ...(configPath === undefined ? {} : { configPath }),
      ...(profileName === undefined ? {} : { profileName }),
      select,
      ...(device === undefined ? {} : { device }),
      ...(transportId === undefined ? {} : { transportId }),
      ...(endpoint === undefined ? {} : { endpoint }),
      pairingCodeStdin,
      remembered,
      dryRun,
      allProjects,
      ...(portDirection === undefined ? {} : { portDirection }),
      ...(portAction === undefined ? {} : { portAction }),
      ...(primaryPort === undefined ? {} : { primaryPort }),
      ...(secondaryPort === undefined ? {} : { secondaryPort }),
      ...(preset === undefined ? {} : { preset }),
      ...(packageManager === undefined ? {} : { packageManager }),
      ...(reversePorts.length === 0 ? {} : { reversePorts }),
      ...(logs === undefined ? {} : { logs }),
      ...(cleanupPorts === undefined ? {} : { cleanupPorts }),
      ...(customCommand === undefined ? {} : { customCommand }),
      ...(runCommand === undefined ? {} : { runCommand }),
      ...(runTimeoutMs === undefined ? {} : { runTimeoutMs }),
      ...(sessionAction === undefined ? {} : { sessionAction }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(sessionStatus === undefined ? {} : { sessionStatus }),
      ...(sessionSinceMs === undefined ? {} : { sessionSinceMs }),
      ...(sessionLimit === undefined ? {} : { sessionLimit }),
      ...(logPackage === undefined ? {} : { logPackage }),
      ...(logPid === undefined ? {} : { logPid }),
      ...(logTags.length === 0 ? {} : { logTags }),
      ...(logExcludeTags.length === 0 ? {} : { logExcludeTags }),
      ...(logPriority === undefined ? {} : { logPriority }),
      ...(logBuffers.length === 0 ? {} : { logBuffers: [...new Set(logBuffers)] }),
      ...(logSince === undefined ? {} : { logSince }),
      ...(logTail === undefined ? {} : { logTail }),
      ...(logDump ? { logDump: true } : {}),
      ...(logMaxRecords === undefined ? {} : { logMaxRecords }),
      ...(contextBudget === undefined ? {} : { contextBudget }),
      ...(contextSinceMs === undefined ? {} : { contextSinceMs }),
      ...(contextOnly.length === 0 ? {} : { contextOnly: [...new Set(contextOnly)] }),
      ...(configAction === undefined ? {} : { configAction }),
      ...(force ? { force: true } : {}),
      ...(appAction === undefined ? {} : { appAction }),
      ...(appId === undefined ? {} : { appId }),
      ...(artifactPaths.length === 0 ? {} : { artifactPath: artifactPaths[0], artifactPaths }),
      ...(activity === undefined ? {} : { activity }),
      ...(packageScope === undefined ? {} : { packageScope }),
      ...(replace ? { replace: true } : {}),
      ...(grantRuntimePermissions ? { grantRuntimePermissions: true } : {}),
      ...(allowDestructive ? { allowDestructive: true } : {}),
      ...(url === undefined ? {} : { url }),
      ...(packageFilter === undefined ? {} : { packageFilter }),
      ...(captureKind === undefined ? {} : { captureKind }),
      ...(outputPath === undefined ? {} : { outputPath }),
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      ...(inspectKind === undefined ? {} : { inspectKind }),
      ...(interactiveOnly ? { interactiveOnly: true } : {}),
      ...(maxDepth === undefined ? {} : { maxDepth }),
      ...(agentClient === undefined ? {} : { agentClient }),
      ...(uiRequest === undefined
        ? {}
        : {
            uiRequest:
              dryRun &&
              (uiRequest.action === "tap" ||
                uiRequest.action === "long-press" ||
                uiRequest.action === "swipe" ||
                uiRequest.action === "type" ||
                uiRequest.action === "press")
                ? { ...uiRequest, dryRun: true }
                : uiRequest,
          }),
    },
  };
}
