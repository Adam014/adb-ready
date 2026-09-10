import type { PortAction } from "../app/commands.js";
import type { DevPreset, PackageManagerName } from "../dev/project.js";
import type { PortDirection } from "../ports/model.js";

export type CommandName =
  | "config"
  | "connect"
  | "context"
  | "dev"
  | "devices"
  | "doctor"
  | "help"
  | "init"
  | "logs"
  | "pair"
  | "ports"
  | "problems"
  | "sessions"
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
  sessionAction?: "events" | "list" | "show";
  sessionId?: string;
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
  "config",
  "connect",
  "context",
  "dev",
  "devices",
  "doctor",
  "help",
  "init",
  "logs",
  "pair",
  "ports",
  "problems",
  "sessions",
  "version",
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
]);

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
  let sessionAction: CliOptions["sessionAction"];
  let sessionId: string | undefined;
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

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }

    if (argument === "--") {
      if (command !== "dev") {
        return failure("CLI_USAGE", "-- command passthrough can only be used with dev.");
      }
      const executable = argv[index + 1];
      if (executable === undefined || executable.trim() === "") {
        return failure("CLI_USAGE", "dev -- requires an executable.");
      }
      customCommand = { executable, args: argv.slice(index + 2) };
      break;
    }

    if (!argument.startsWith("-")) {
      if (command === undefined) {
        if (!COMMANDS.has(argument as CommandName)) {
          return failure("CLI_USAGE", `Unknown command: ${argument}`);
        }
        const candidate = argument as CommandName;
        command = candidate;
        continue;
      }
      if (command === "help" && COMMANDS.has(argument as CommandName)) {
        const candidate = argument as CommandName;
        if (
          candidate === "connect" ||
          candidate === "config" ||
          candidate === "context" ||
          candidate === "dev" ||
          candidate === "devices" ||
          candidate === "doctor" ||
          candidate === "logs" ||
          candidate === "init" ||
          candidate === "pair" ||
          candidate === "ports" ||
          candidate === "problems" ||
          candidate === "sessions"
        ) {
          helpTarget = candidate;
          continue;
        }
      }
      if ((command === "connect" || command === "pair") && endpoint === undefined) {
        endpoint = argument;
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
      logPackage = value;
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
      if (command === "context") {
        contextSinceMs = parseDuration(value);
        if (contextSinceMs === undefined) {
          return failure(
            "CLI_INVALID_VALUE",
            `Invalid context duration: ${value}. Use a value such as 30s, 5m, or 1h.`,
            option,
          );
        }
      } else if (!/^[0-9][0-9 .:-]{0,63}$/u.test(value)) {
        return failure(
          "CLI_INVALID_VALUE",
          `Invalid log start time: ${value}. Use an Android logcat timestamp.`,
          option,
        );
      } else {
        logSince = value;
      }
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
      return failure("CLI_INVALID_OPTION", `Unknown option: ${option}`, option);
    }
  }

  if (quiet && verbose) {
    return failure("CLI_USAGE", "--quiet and --verbose cannot be used together.");
  }

  command ??= "help";
  if (command === "config") configAction ??= "validate";
  if (command === "context" && format === "human") format = "markdown";
  if (command === "sessions") sessionAction ??= "list";
  const targetCommand =
    command === "dev" || command === "devices" || command === "logs" || command === "ports";
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
    command !== "pair" &&
    command !== "ports" &&
    command !== "init"
  ) {
    return failure(
      "CLI_USAGE",
      "--dry-run can only be used with connect, dev, init, pair, or ports.",
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
  if (
    command !== "dev" &&
    command !== "init" &&
    (preset !== undefined ||
      packageManager !== undefined ||
      reversePorts.length > 0 ||
      logs !== undefined ||
      cleanupPorts !== undefined ||
      customCommand !== undefined)
  ) {
    return failure("CLI_USAGE", "Development options can only be used with the dev command.");
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
  if (force && command !== "init") {
    return failure("CLI_USAGE", "--force can only be used with the init command.");
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
      ...(sessionAction === undefined ? {} : { sessionAction }),
      ...(sessionId === undefined ? {} : { sessionId }),
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
    },
  };
}
