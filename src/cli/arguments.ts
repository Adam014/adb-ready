export type CommandName = "connect" | "devices" | "doctor" | "help" | "pair" | "version";
export type OutputFormat = "human" | "json" | "ndjson" | "plain";

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
  select: boolean;
  device?: string;
  transportId?: string;
  endpoint?: string;
  pairingCodeStdin: boolean;
  remembered: boolean;
  dryRun: boolean;
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

const COMMANDS = new Set<CommandName>(["connect", "devices", "doctor", "help", "pair", "version"]);
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
]);

function failure(code: CliParseFailure["code"], message: string, option?: string): CliParseFailure {
  return { ok: false, code, message, ...(option === undefined ? {} : { option }) };
}

function parseDuration(value: string): number | undefined {
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/u);
  if (match === null) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier = unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
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
  let select = false;
  let device: string | undefined;
  let transportId: string | undefined;
  let endpoint: string | undefined;
  let pairingCodeStdin = false;
  let remembered = false;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
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
          candidate === "devices" ||
          candidate === "doctor" ||
          candidate === "pair"
        ) {
          helpTarget = candidate;
          continue;
        }
      }
      if ((command === "connect" || command === "pair") && endpoint === undefined) {
        endpoint = argument;
        continue;
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
      if (
        command === "connect" ||
        command === "doctor" ||
        command === "devices" ||
        command === "pair"
      ) {
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
      if (!new Set<OutputFormat>(["human", "json", "ndjson", "plain"]).has(value as OutputFormat)) {
        return failure(
          "CLI_INVALID_VALUE",
          `Invalid format: ${value}. Expected human, plain, json, or ndjson.`,
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
    } else {
      return failure("CLI_INVALID_OPTION", `Unknown option: ${option}`, option);
    }
  }

  if (quiet && verbose) {
    return failure("CLI_USAGE", "--quiet and --verbose cannot be used together.");
  }

  command ??= "help";
  if (select && command !== "devices") {
    return failure("CLI_USAGE", "--select can only be used with the devices command.", "--select");
  }
  if ((device !== undefined || transportId !== undefined) && command !== "devices") {
    return failure(
      "CLI_USAGE",
      "Target selection options can only be used with the devices command.",
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
  if (remembered && command !== "devices") {
    return failure("CLI_USAGE", "--last can only be used with the devices command.", "--last");
  }
  if (remembered && (select || device !== undefined || transportId !== undefined)) {
    return failure("CLI_USAGE", "--last cannot be combined with another target selector.");
  }
  if (dryRun && command !== "connect" && command !== "pair") {
    return failure("CLI_USAGE", "--dry-run can only be used with connect or pair.", "--dry-run");
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
      select,
      ...(device === undefined ? {} : { device }),
      ...(transportId === undefined ? {} : { transportId }),
      ...(endpoint === undefined ? {} : { endpoint }),
      pairingCodeStdin,
      remembered,
      dryRun,
    },
  };
}
