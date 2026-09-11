import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import type {
  ConfigError,
  ConfigKey,
  ConfigLoadResult,
  ConfigProvenance,
  ConfigSource,
  ConfigValues,
  LoadedConfig,
} from "./types.js";

export interface LoadConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  explicitProjectConfig?: boolean;
  profileName?: string;
  cli?: ConfigValues;
}

interface ConfigProfile {
  extends?: string;
  values: ConfigValues;
}

interface ValidatedDocument {
  values: ConfigValues;
  profiles: Record<string, ConfigProfile>;
  defaultProfile?: string;
  errors: ConfigError[];
}

const DEFAULTS: Required<Pick<ConfigValues, "timeoutMs">> = { timeoutMs: 5_000 };
const ROOT_KEYS = new Set([
  "$schema",
  "version",
  "adb",
  "timeoutMs",
  "output",
  "targets",
  "app",
  "dev",
  "defaultProfile",
  "profiles",
]);
const PROFILE_KEYS = new Set(["extends", "adb", "timeoutMs", "output", "targets", "app", "dev"]);
const ADB_KEYS = new Set(["path", "host", "port"]);
const OUTPUT_KEYS = new Set(["color", "unicode", "animation", "interactive"]);
const TARGET_KEYS = new Set(["aliases"]);
const APP_KEYS = new Set(["android"]);
const ANDROID_APP_KEYS = new Set(["package"]);
const DEV_KEYS = new Set([
  "preset",
  "packageManager",
  "command",
  "reversePorts",
  "logs",
  "cleanupPorts",
  "watch",
  "ready",
  "recovery",
  "session",
  "journal",
  "hooks",
]);
const COMMAND_KEYS = new Set(["executable", "args", "cwd"]);
const PORT_KEYS = new Set(["device", "host"]);
const JOURNAL_KEYS = new Set([
  "maxEntries",
  "maxBytes",
  "sources",
  "minimumSeverity",
  "redactEnvironment",
]);
const HOOK_EVENTS = new Set([
  "beforeDev",
  "onTargetReady",
  "onPortsReady",
  "onReady",
  "onChildExit",
  "finally",
]);
const HOOK_KEYS = new Set(["run", "timeoutMs", "failure", "cwd", "envAllowlist"]);
const RECOVERY_KEYS = new Set(["maxAttempts", "initialDelayMs", "maxDelayMs", "totalTimeoutMs"]);
const SESSION_KEYS = new Set(["persist", "maxSessions", "maxAgeDays", "maxBytes"]);
const READY_KEYS = new Set(["all", "timeoutMs", "pollIntervalMs"]);
const READY_ASSERTION_KEYS = new Set([
  "kind",
  "value",
  "package",
  "host",
  "port",
  "url",
  "status",
  "contains",
  "absent",
  "selector",
  "state",
]);
const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(
  source: ConfigError["source"],
  location: string | undefined,
  pathValue: string,
  message: string,
  code: ConfigError["code"] = "CONFIG_INVALID_VALUE",
): ConfigError {
  return {
    code,
    path: pathValue,
    message,
    source,
    ...(location === undefined ? {} : { location }),
  };
}

function validateUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  prefix: string,
  source: ConfigError["source"],
  location: string,
  errors: ConfigError[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(
        error(source, location, `${prefix}${key}`, `Unknown configuration key: ${prefix}${key}`),
      );
    }
  }
}

function validateReadiness(
  ready: unknown,
  source: ConfigError["source"],
  location: string,
  errors: ConfigError[],
): ConfigValues["devReadiness"] {
  if (!isObject(ready)) {
    errors.push(error(source, location, "dev.ready", "dev.ready must be an object."));
    return undefined;
  }
  validateUnknownKeys(ready, READY_KEYS, "dev.ready.", source, location, errors);
  const all = ready.all;
  const assertions: NonNullable<ConfigValues["devReadiness"]>["all"] = [];
  if (!Array.isArray(all)) {
    errors.push(error(source, location, "dev.ready.all", "dev.ready.all must be an array."));
  } else {
    all.forEach((candidate, index) => {
      const prefix = `dev.ready.all.${String(index)}`;
      if (!isObject(candidate)) {
        errors.push(error(source, location, prefix, "Readiness assertion must be an object."));
        return;
      }
      validateUnknownKeys(candidate, READY_ASSERTION_KEYS, `${prefix}.`, source, location, errors);
      const kind = candidate.kind;
      let assertion: (typeof assertions)[number] | undefined;
      if (kind === "boot" || kind === "unlocked") assertion = { kind };
      else if (kind === "foreground" || kind === "process") {
        assertion =
          typeof candidate.package === "string" &&
          /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u.test(candidate.package)
            ? { kind, package: candidate.package }
            : undefined;
      } else if (kind === "activity") {
        assertion =
          typeof candidate.value === "string" && candidate.value.trim() !== ""
            ? { kind, value: candidate.value }
            : undefined;
      } else if (kind === "host-port") {
        assertion =
          Number.isSafeInteger(candidate.port) &&
          (candidate.port as number) >= 1 &&
          (candidate.port as number) <= 65_535 &&
          (candidate.host === undefined ||
            (typeof candidate.host === "string" && candidate.host.trim() !== ""))
            ? {
                kind,
                port: candidate.port as number,
                ...(candidate.host === undefined ? {} : { host: candidate.host as string }),
              }
            : undefined;
      } else if (kind === "http") {
        const statuses = candidate.status;
        assertion =
          typeof candidate.url === "string" &&
          /^https?:\/\//u.test(candidate.url) &&
          (statuses === undefined ||
            (Array.isArray(statuses) &&
              statuses.length > 0 &&
              statuses.every(
                (value) => Number.isSafeInteger(value) && value >= 100 && value <= 599,
              )))
            ? {
                kind,
                url: candidate.url,
                ...(statuses === undefined ? {} : { status: statuses as number[] }),
              }
            : undefined;
      } else if (kind === "log") {
        assertion =
          typeof candidate.contains === "string" &&
          candidate.contains.length >= 1 &&
          candidate.contains.length <= 256 &&
          (candidate.absent === undefined || typeof candidate.absent === "boolean")
            ? {
                kind,
                contains: candidate.contains,
                ...(candidate.absent === undefined ? {} : { absent: candidate.absent }),
              }
            : undefined;
      } else if (kind === "ui") {
        assertion =
          typeof candidate.selector === "string" &&
          /^(?:desc|id|package|text)=.{1,256}$/u.test(candidate.selector) &&
          (candidate.state === undefined ||
            candidate.state === "visible" ||
            candidate.state === "gone")
            ? {
                kind,
                selector: candidate.selector,
                ...(candidate.state === undefined ? {} : { state: candidate.state }),
              }
            : undefined;
      }
      if (assertion === undefined) {
        errors.push(
          error(source, location, prefix, "Invalid readiness assertion or assertion fields."),
        );
      } else assertions.push(assertion);
    });
  }
  let validTiming = true;
  for (const key of ["timeoutMs", "pollIntervalMs"] as const) {
    const candidate = ready[key];
    if (
      candidate !== undefined &&
      (!Number.isSafeInteger(candidate) || (candidate as number) < 1)
    ) {
      validTiming = false;
      errors.push(
        error(source, location, `dev.ready.${key}`, `dev.ready.${key} must be a positive integer.`),
      );
    }
  }
  return Array.isArray(all) && assertions.length === all.length && validTiming
    ? {
        all: assertions,
        ...(ready.timeoutMs === undefined ? {} : { timeoutMs: ready.timeoutMs as number }),
        ...(ready.pollIntervalMs === undefined
          ? {}
          : { pollIntervalMs: ready.pollIntervalMs as number }),
      }
    : undefined;
}

function validateDocument(
  document: unknown,
  source: Extract<ConfigSource, "project" | "user">,
  location: string,
): ValidatedDocument {
  const errors: ConfigError[] = [];
  const values: ConfigValues = {};
  const profiles: Record<string, ConfigProfile> = {};
  if (!isObject(document)) {
    return {
      values,
      profiles,
      errors: [error(source, location, "$", "Configuration must be a JSON object.")],
    };
  }

  validateUnknownKeys(document, ROOT_KEYS, "", source, location, errors);
  if (document.$schema !== undefined && typeof document.$schema !== "string") {
    errors.push(error(source, location, "$schema", "$schema must be a string."));
  }
  if (document.version !== 1) {
    errors.push(error(source, location, "version", "version must be exactly 1."));
  }

  if (document.timeoutMs !== undefined) {
    if (
      !Number.isSafeInteger(document.timeoutMs) ||
      (document.timeoutMs as number) < 1 ||
      (document.timeoutMs as number) > 2_147_483_647
    ) {
      errors.push(
        error(source, location, "timeoutMs", "timeoutMs must be an integer from 1 to 2147483647."),
      );
    } else {
      values.timeoutMs = document.timeoutMs as number;
    }
  }

  if (document.adb !== undefined) {
    if (!isObject(document.adb)) {
      errors.push(error(source, location, "adb", "adb must be an object."));
    } else {
      validateUnknownKeys(document.adb, ADB_KEYS, "adb.", source, location, errors);
      for (const [key, configKey] of [
        ["path", "adbPath"],
        ["host", "adbHost"],
      ] as const) {
        const candidate = document.adb[key];
        if (candidate !== undefined) {
          if (typeof candidate !== "string" || candidate.trim() === "") {
            errors.push(
              error(source, location, `adb.${key}`, `adb.${key} must be a non-empty string.`),
            );
          } else {
            values[configKey] = candidate;
          }
        }
      }
      if (document.adb.port !== undefined) {
        if (
          !Number.isSafeInteger(document.adb.port) ||
          (document.adb.port as number) < 1 ||
          (document.adb.port as number) > 65_535
        ) {
          errors.push(
            error(source, location, "adb.port", "adb.port must be an integer from 1 to 65535."),
          );
        } else {
          values.adbPort = document.adb.port as number;
        }
      }
    }
  }

  if (document.output !== undefined) {
    if (!isObject(document.output)) {
      errors.push(error(source, location, "output", "output must be an object."));
    } else {
      validateUnknownKeys(document.output, OUTPUT_KEYS, "output.", source, location, errors);
      for (const [key, configKey] of [
        ["color", "color"],
        ["unicode", "unicode"],
        ["animation", "animation"],
        ["interactive", "interactive"],
      ] as const) {
        const candidate = document.output[key];
        if (candidate !== undefined) {
          if (typeof candidate !== "boolean") {
            errors.push(
              error(source, location, `output.${key}`, `output.${key} must be a boolean.`),
            );
          } else {
            values[configKey] = candidate;
          }
        }
      }
    }
  }

  if (document.targets !== undefined) {
    if (!isObject(document.targets)) {
      errors.push(error(source, location, "targets", "targets must be an object."));
    } else {
      validateUnknownKeys(document.targets, TARGET_KEYS, "targets.", source, location, errors);
      if (document.targets.aliases !== undefined) {
        if (!isObject(document.targets.aliases)) {
          errors.push(
            error(source, location, "targets.aliases", "targets.aliases must be an object."),
          );
        } else {
          const aliases: Record<string, string> = {};
          for (const [alias, selector] of Object.entries(document.targets.aliases)) {
            if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(alias)) {
              errors.push(
                error(
                  source,
                  location,
                  `targets.aliases.${alias}`,
                  "Target alias must be 1-64 letters, numbers, dots, underscores, or hyphens.",
                ),
              );
            } else if (typeof selector !== "string" || selector.trim() === "") {
              errors.push(
                error(
                  source,
                  location,
                  `targets.aliases.${alias}`,
                  "Target alias value must be a non-empty selector.",
                ),
              );
            } else {
              aliases[alias] = selector;
            }
          }
          values.targetAliases = aliases;
        }
      }
    }
  }

  if (document.app !== undefined) {
    if (!isObject(document.app)) {
      errors.push(error(source, location, "app", "app must be an object."));
    } else {
      validateUnknownKeys(document.app, APP_KEYS, "app.", source, location, errors);
      if (document.app.android !== undefined) {
        if (!isObject(document.app.android)) {
          errors.push(error(source, location, "app.android", "app.android must be an object."));
        } else {
          validateUnknownKeys(
            document.app.android,
            ANDROID_APP_KEYS,
            "app.android.",
            source,
            location,
            errors,
          );
          const packageName = document.app.android.package;
          if (packageName !== undefined) {
            if (
              typeof packageName !== "string" ||
              !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u.test(packageName)
            ) {
              errors.push(
                error(
                  source,
                  location,
                  "app.android.package",
                  "app.android.package must be a valid Android application ID.",
                ),
              );
            } else {
              values.appPackage = packageName;
            }
          }
        }
      }
    }
  }

  if (document.dev !== undefined) {
    if (!isObject(document.dev)) {
      errors.push(error(source, location, "dev", "dev must be an object."));
    } else {
      validateUnknownKeys(document.dev, DEV_KEYS, "dev.", source, location, errors);
      if (document.dev.preset !== undefined) {
        if (
          !new Set(["capacitor", "custom", "expo", "flutter", "gradle", "react-native"]).has(
            document.dev.preset as string,
          )
        ) {
          errors.push(
            error(
              source,
              location,
              "dev.preset",
              "dev.preset must be capacitor, custom, expo, flutter, gradle, or react-native.",
            ),
          );
        } else {
          values.devPreset = document.dev.preset as NonNullable<ConfigValues["devPreset"]>;
        }
      }
      if (document.dev.packageManager !== undefined) {
        if (!new Set(["bun", "npm", "pnpm", "yarn"]).has(document.dev.packageManager as string)) {
          errors.push(
            error(
              source,
              location,
              "dev.packageManager",
              "dev.packageManager must be bun, npm, pnpm, or yarn.",
            ),
          );
        } else {
          values.packageManager = document.dev.packageManager as NonNullable<
            ConfigValues["packageManager"]
          >;
        }
      }
      if (document.dev.command !== undefined) {
        if (!isObject(document.dev.command)) {
          errors.push(error(source, location, "dev.command", "dev.command must be an object."));
        } else {
          validateUnknownKeys(
            document.dev.command,
            COMMAND_KEYS,
            "dev.command.",
            source,
            location,
            errors,
          );
          const executable = document.dev.command.executable;
          const args = document.dev.command.args;
          const cwd = document.dev.command.cwd;
          if (typeof executable !== "string" || executable.trim() === "") {
            errors.push(
              error(
                source,
                location,
                "dev.command.executable",
                "dev.command.executable must be a non-empty string.",
              ),
            );
          }
          if (!Array.isArray(args) || !args.every((item) => typeof item === "string")) {
            errors.push(
              error(
                source,
                location,
                "dev.command.args",
                "dev.command.args must be an array of strings.",
              ),
            );
          }
          if (cwd !== undefined && (typeof cwd !== "string" || cwd.trim() === "")) {
            errors.push(
              error(
                source,
                location,
                "dev.command.cwd",
                "dev.command.cwd must be a non-empty string.",
              ),
            );
          }
          if (
            typeof executable === "string" &&
            executable.trim() !== "" &&
            Array.isArray(args) &&
            args.every((item) => typeof item === "string") &&
            (cwd === undefined || (typeof cwd === "string" && cwd.trim() !== ""))
          ) {
            values.devCommand = {
              executable,
              args,
              ...(cwd === undefined ? {} : { cwd }),
            };
          }
        }
      }
      if (document.dev.reversePorts !== undefined) {
        if (!Array.isArray(document.dev.reversePorts)) {
          errors.push(
            error(source, location, "dev.reversePorts", "dev.reversePorts must be an array."),
          );
        } else {
          const ports: NonNullable<ConfigValues["devReversePorts"]> = [];
          document.dev.reversePorts.forEach((candidate, index) => {
            const port = typeof candidate === "number" ? { device: candidate } : candidate;
            if (!isObject(port)) {
              errors.push(
                error(
                  source,
                  location,
                  `dev.reversePorts.${String(index)}`,
                  "Each reverse port must be an integer or an object.",
                ),
              );
              return;
            }
            validateUnknownKeys(
              port,
              PORT_KEYS,
              `dev.reversePorts.${String(index)}.`,
              source,
              location,
              errors,
            );
            if (
              !Number.isSafeInteger(port.device) ||
              (port.device as number) < 1 ||
              (port.device as number) > 65_535
            ) {
              errors.push(
                error(
                  source,
                  location,
                  `dev.reversePorts.${String(index)}.device`,
                  "Device port must be an integer from 1 to 65535.",
                ),
              );
              return;
            }
            if (
              port.host !== undefined &&
              (!Number.isSafeInteger(port.host) ||
                (port.host as number) < 1 ||
                (port.host as number) > 65_535)
            ) {
              errors.push(
                error(
                  source,
                  location,
                  `dev.reversePorts.${String(index)}.host`,
                  "Host port must be an integer from 1 to 65535.",
                ),
              );
              return;
            }
            ports.push({
              device: port.device as number,
              ...(port.host === undefined ? {} : { host: port.host as number }),
            });
          });
          values.devReversePorts = ports;
        }
      }
      for (const [key, configKey] of [
        ["logs", "devLogs"],
        ["cleanupPorts", "devCleanupPorts"],
        ["watch", "devWatch"],
      ] as const) {
        const candidate = document.dev[key];
        if (candidate !== undefined) {
          if (typeof candidate !== "boolean") {
            errors.push(error(source, location, `dev.${key}`, `dev.${key} must be a boolean.`));
          } else {
            values[configKey] = candidate;
          }
        }
      }
      if (document.dev.ready !== undefined) {
        const readiness = validateReadiness(document.dev.ready, source, location, errors);
        if (readiness !== undefined) values.devReadiness = readiness;
      }
      if (document.dev.recovery !== undefined) {
        if (!isObject(document.dev.recovery)) {
          errors.push(error(source, location, "dev.recovery", "dev.recovery must be an object."));
        } else {
          validateUnknownKeys(
            document.dev.recovery,
            RECOVERY_KEYS,
            "dev.recovery.",
            source,
            location,
            errors,
          );
          for (const [key, configKey] of [
            ["maxAttempts", "recoveryMaxAttempts"],
            ["initialDelayMs", "recoveryInitialDelayMs"],
            ["maxDelayMs", "recoveryMaxDelayMs"],
            ["totalTimeoutMs", "recoveryTotalTimeoutMs"],
          ] as const) {
            const candidate = document.dev.recovery[key];
            if (candidate === undefined) continue;
            if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
              errors.push(
                error(
                  source,
                  location,
                  `dev.recovery.${key}`,
                  `dev.recovery.${key} must be a positive integer.`,
                ),
              );
            } else {
              values[configKey] = candidate as number;
            }
          }
        }
      }
      if (document.dev.session !== undefined) {
        if (!isObject(document.dev.session)) {
          errors.push(error(source, location, "dev.session", "dev.session must be an object."));
        } else {
          validateUnknownKeys(
            document.dev.session,
            SESSION_KEYS,
            "dev.session.",
            source,
            location,
            errors,
          );
          if (document.dev.session.persist !== undefined) {
            if (typeof document.dev.session.persist !== "boolean") {
              errors.push(
                error(
                  source,
                  location,
                  "dev.session.persist",
                  "dev.session.persist must be a boolean.",
                ),
              );
            } else {
              values.sessionPersist = document.dev.session.persist;
            }
          }
          for (const [key, configKey] of [
            ["maxSessions", "sessionMaxSessions"],
            ["maxAgeDays", "sessionMaxAgeDays"],
            ["maxBytes", "sessionMaxBytes"],
          ] as const) {
            const candidate = document.dev.session[key];
            if (candidate === undefined) continue;
            if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
              errors.push(
                error(
                  source,
                  location,
                  `dev.session.${key}`,
                  `dev.session.${key} must be a positive integer.`,
                ),
              );
            } else {
              values[configKey] = candidate as number;
            }
          }
        }
      }
      if (document.dev.journal !== undefined) {
        if (!isObject(document.dev.journal)) {
          errors.push(error(source, location, "dev.journal", "dev.journal must be an object."));
        } else {
          validateUnknownKeys(
            document.dev.journal,
            JOURNAL_KEYS,
            "dev.journal.",
            source,
            location,
            errors,
          );
          for (const [key, configKey] of [
            ["maxEntries", "journalMaxEntries"],
            ["maxBytes", "journalMaxBytes"],
          ] as const) {
            const candidate = document.dev.journal[key];
            if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
              if (candidate !== undefined) {
                errors.push(
                  error(
                    source,
                    location,
                    `dev.journal.${key}`,
                    `dev.journal.${key} must be a positive integer.`,
                  ),
                );
              }
            } else {
              values[configKey] = candidate as number;
            }
          }
          if (document.dev.journal.sources !== undefined) {
            if (
              !Array.isArray(document.dev.journal.sources) ||
              !document.dev.journal.sources.every(
                (item) => typeof item === "string" && item.trim() !== "",
              )
            ) {
              errors.push(
                error(
                  source,
                  location,
                  "dev.journal.sources",
                  "dev.journal.sources must be an array of non-empty strings.",
                ),
              );
            } else {
              values.journalSources = [...new Set(document.dev.journal.sources as string[])];
            }
          }
          if (document.dev.journal.minimumSeverity !== undefined) {
            if (
              !new Set(["debug", "info", "warning", "error"]).has(
                document.dev.journal.minimumSeverity as string,
              )
            ) {
              errors.push(
                error(
                  source,
                  location,
                  "dev.journal.minimumSeverity",
                  "dev.journal.minimumSeverity must be debug, info, warning, or error.",
                ),
              );
            } else {
              values.journalMinimumSeverity = document.dev.journal.minimumSeverity as NonNullable<
                ConfigValues["journalMinimumSeverity"]
              >;
            }
          }
          if (document.dev.journal.redactEnvironment !== undefined) {
            if (
              !Array.isArray(document.dev.journal.redactEnvironment) ||
              !document.dev.journal.redactEnvironment.every(
                (item) => typeof item === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(item),
              )
            ) {
              errors.push(
                error(
                  source,
                  location,
                  "dev.journal.redactEnvironment",
                  "dev.journal.redactEnvironment must contain valid environment variable names.",
                ),
              );
            } else {
              values.journalRedactEnvironment = [
                ...new Set(document.dev.journal.redactEnvironment as string[]),
              ];
            }
          }
        }
      }
      if (document.dev.hooks !== undefined) {
        if (!isObject(document.dev.hooks)) {
          errors.push(error(source, location, "dev.hooks", "dev.hooks must be an object."));
        } else {
          validateUnknownKeys(
            document.dev.hooks,
            HOOK_EVENTS,
            "dev.hooks.",
            source,
            location,
            errors,
          );
          const hooks: NonNullable<ConfigValues["devHooks"]> = {};
          for (const [eventName, candidates] of Object.entries(document.dev.hooks)) {
            if (!HOOK_EVENTS.has(eventName)) continue;
            if (!Array.isArray(candidates)) {
              errors.push(
                error(
                  source,
                  location,
                  `dev.hooks.${eventName}`,
                  `dev.hooks.${eventName} must be an array.`,
                ),
              );
              continue;
            }
            const validatedHooks: NonNullable<ConfigValues["devHooks"]>[keyof NonNullable<
              ConfigValues["devHooks"]
            >] = [];
            candidates.forEach((candidate, index) => {
              const prefix = `dev.hooks.${eventName}.${String(index)}`;
              if (!isObject(candidate)) {
                errors.push(error(source, location, prefix, "Hook must be an object."));
                return;
              }
              validateUnknownKeys(candidate, HOOK_KEYS, `${prefix}.`, source, location, errors);
              const run = candidate.run;
              const timeoutMs = candidate.timeoutMs;
              const failure = candidate.failure;
              const cwd = candidate.cwd;
              const envAllowlist = candidate.envAllowlist;
              let valid = true;
              if (
                !Array.isArray(run) ||
                run.length < 1 ||
                !run.every((item) => typeof item === "string") ||
                (run[0] as string | undefined)?.trim() === ""
              ) {
                valid = false;
                errors.push(
                  error(
                    source,
                    location,
                    `${prefix}.run`,
                    "Hook run must be a non-empty executable and argument array.",
                  ),
                );
              }
              if (
                timeoutMs !== undefined &&
                (!Number.isSafeInteger(timeoutMs) ||
                  (timeoutMs as number) < 1 ||
                  (timeoutMs as number) > 2_147_483_647)
              ) {
                valid = false;
                errors.push(
                  error(
                    source,
                    location,
                    `${prefix}.timeoutMs`,
                    "Hook timeoutMs must be a positive integer.",
                  ),
                );
              }
              if (
                failure !== undefined &&
                !new Set(["fail", "ignore", "warn"]).has(failure as string)
              ) {
                valid = false;
                errors.push(
                  error(
                    source,
                    location,
                    `${prefix}.failure`,
                    "Hook failure must be fail, warn, or ignore.",
                  ),
                );
              }
              if (cwd !== undefined && (typeof cwd !== "string" || cwd.trim() === "")) {
                valid = false;
                errors.push(
                  error(source, location, `${prefix}.cwd`, "Hook cwd must be a non-empty string."),
                );
              }
              if (
                envAllowlist !== undefined &&
                (!Array.isArray(envAllowlist) ||
                  !envAllowlist.every(
                    (item) => typeof item === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(item),
                  ))
              ) {
                valid = false;
                errors.push(
                  error(
                    source,
                    location,
                    `${prefix}.envAllowlist`,
                    "Hook envAllowlist must contain valid environment variable names.",
                  ),
                );
              }
              if (valid) {
                const command = run as [string, ...string[]];
                validatedHooks?.push({
                  run: command,
                  ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
                  ...(failure === undefined
                    ? {}
                    : { failure: failure as "fail" | "ignore" | "warn" }),
                  ...(cwd === undefined ? {} : { cwd: cwd as string }),
                  ...(envAllowlist === undefined
                    ? {}
                    : { envAllowlist: [...new Set(envAllowlist as string[])] }),
                });
              }
            });
            Object.assign(hooks, { [eventName]: validatedHooks });
          }
          values.devHooks = hooks;
        }
      }
    }
  }

  let defaultProfile: string | undefined;
  if (document.defaultProfile !== undefined) {
    if (
      typeof document.defaultProfile !== "string" ||
      !PROFILE_NAME.test(document.defaultProfile)
    ) {
      errors.push(
        error(
          source,
          location,
          "defaultProfile",
          "defaultProfile must be a valid profile name of 1-64 letters, numbers, dots, underscores, or hyphens.",
        ),
      );
    } else {
      defaultProfile = document.defaultProfile;
    }
  }

  if (document.profiles !== undefined) {
    if (!isObject(document.profiles)) {
      errors.push(error(source, location, "profiles", "profiles must be an object."));
    } else {
      for (const [name, candidate] of Object.entries(document.profiles)) {
        const prefix = `profiles.${name}.`;
        if (!PROFILE_NAME.test(name)) {
          errors.push(
            error(
              source,
              location,
              `profiles.${name}`,
              "Profile name must be 1-64 letters, numbers, dots, underscores, or hyphens.",
            ),
          );
          continue;
        }
        if (!isObject(candidate)) {
          errors.push(
            error(source, location, `profiles.${name}`, "Profile definition must be an object."),
          );
          continue;
        }
        validateUnknownKeys(candidate, PROFILE_KEYS, prefix, source, location, errors);
        let parent: string | undefined;
        if (candidate.extends !== undefined) {
          if (typeof candidate.extends !== "string" || !PROFILE_NAME.test(candidate.extends)) {
            errors.push(
              error(source, location, `${prefix}extends`, "extends must be a valid profile name."),
            );
          } else {
            parent = candidate.extends;
          }
        }
        const profileDocument: Record<string, unknown> = { version: 1 };
        for (const key of ["adb", "timeoutMs", "output", "targets", "app", "dev"] as const) {
          if (candidate[key] !== undefined) {
            profileDocument[key] = candidate[key];
          }
        }
        const validated = validateDocument(profileDocument, source, location);
        errors.push(
          ...validated.errors.map((item) => ({
            ...item,
            path: `${prefix}${item.path}`,
          })),
        );
        profiles[name] = {
          ...(parent === undefined ? {} : { extends: parent }),
          values: validated.values,
        };
      }
    }
  }

  if (defaultProfile !== undefined && profiles[defaultProfile] === undefined) {
    errors.push(
      error(
        source,
        location,
        "defaultProfile",
        `defaultProfile references an unknown profile: ${defaultProfile}`,
      ),
    );
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) {
      return;
    }
    const profile = profiles[name];
    if (profile === undefined) {
      return;
    }
    visiting.add(name);
    const parent = profile.extends;
    if (parent !== undefined) {
      if (profiles[parent] === undefined) {
        errors.push(
          error(
            source,
            location,
            `profiles.${name}.extends`,
            `Profile ${name} extends an unknown profile: ${parent}`,
          ),
        );
      } else if (visiting.has(parent)) {
        errors.push(
          error(
            source,
            location,
            `profiles.${name}.extends`,
            `Profile inheritance cycle detected through ${parent}.`,
          ),
        );
      } else {
        visit(parent);
      }
    }
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of Object.keys(profiles)) {
    visit(name);
  }

  return {
    values,
    profiles,
    ...(defaultProfile === undefined ? {} : { defaultProfile }),
    errors,
  };
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export function defaultUserConfigPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  if (env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.trim() !== "") {
    return platformPath.join(env.XDG_CONFIG_HOME, "adb-ready", "config.json");
  }
  if (platform === "win32" && env.APPDATA !== undefined && env.APPDATA.trim() !== "") {
    return platformPath.join(env.APPDATA, "adb-ready", "config.json");
  }
  if (platform === "darwin") {
    return platformPath.join(
      homeDirectory,
      "Library",
      "Application Support",
      "adb-ready",
      "config.json",
    );
  }
  return platformPath.join(homeDirectory, ".config", "adb-ready", "config.json");
}

export async function findProjectConfig(startDirectory: string): Promise<string | undefined> {
  let current = path.resolve(startDirectory);
  while (true) {
    const candidate = path.join(current, "adb-ready.config.json");
    if (await fileExists(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function readConfigDocument(
  file: string,
  source: Extract<ConfigSource, "project" | "user">,
  required: boolean,
): Promise<ValidatedDocument & { loaded: boolean }> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (caught) {
    const code = (caught as NodeJS.ErrnoException).code;
    if (!required && code === "ENOENT") {
      return { values: {}, profiles: {}, errors: [], loaded: false };
    }
    return {
      values: {},
      profiles: {},
      errors: [
        error(
          source,
          file,
          "$",
          `Configuration file could not be read: ${file}`,
          "CONFIG_NOT_FOUND",
        ),
      ],
      loaded: false,
    };
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (caught) {
    return {
      values: {},
      profiles: {},
      errors: [
        error(
          source,
          file,
          "$",
          `Invalid JSON: ${caught instanceof Error ? caught.message : "unknown parse error"}`,
          "CONFIG_INVALID_JSON",
        ),
      ],
      loaded: true,
    };
  }

  const validated = validateDocument(document, source, file);
  return { ...validated, loaded: true };
}

function parseEnvironment(env: NodeJS.ProcessEnv): { values: ConfigValues; errors: ConfigError[] } {
  const values: ConfigValues = {};
  const errors: ConfigError[] = [];
  const strings = [
    ["ADB_READY_ADB_PATH", "adbPath"],
    ["ADB_READY_ADB_HOST", "adbHost"],
    ["ADB_READY_APP_PACKAGE", "appPackage"],
  ] as const;
  for (const [name, key] of strings) {
    const candidate = env[name];
    if (candidate !== undefined) {
      if (candidate.trim() === "") {
        errors.push(error("environment", name, name, `${name} cannot be empty.`));
      } else if (
        key === "appPackage" &&
        !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u.test(candidate)
      ) {
        errors.push(
          error("environment", name, name, `${name} must be a valid Android application ID.`),
        );
      } else {
        values[key] = candidate;
      }
    }
  }

  const enumStrings = [
    [
      "ADB_READY_PRESET",
      "devPreset",
      new Set(["capacitor", "custom", "expo", "flutter", "gradle", "react-native"]),
    ],
    ["ADB_READY_PACKAGE_MANAGER", "packageManager", new Set(["bun", "npm", "pnpm", "yarn"])],
    [
      "ADB_READY_JOURNAL_MINIMUM_SEVERITY",
      "journalMinimumSeverity",
      new Set(["debug", "info", "warning", "error"]),
    ],
  ] as const;
  for (const [name, key, allowed] of enumStrings) {
    const candidate = env[name];
    if (candidate !== undefined) {
      if (!allowed.has(candidate)) {
        errors.push(
          error("environment", name, name, `${name} must be one of: ${[...allowed].join(", ")}.`),
        );
      } else {
        Object.assign(values, { [key]: candidate });
      }
    }
  }

  if (env.ADB_READY_REVERSE_PORTS !== undefined) {
    const rawPorts = env.ADB_READY_REVERSE_PORTS.split(",").map((value) => value.trim());
    const parsed = rawPorts.map((value) => Number(value));
    if (
      rawPorts.length === 0 ||
      rawPorts.some((value) => value === "") ||
      parsed.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535)
    ) {
      errors.push(
        error(
          "environment",
          "ADB_READY_REVERSE_PORTS",
          "ADB_READY_REVERSE_PORTS",
          "ADB_READY_REVERSE_PORTS must be a comma-separated list of ports from 1 to 65535.",
        ),
      );
    } else {
      values.devReversePorts = parsed.map((device) => ({ device }));
    }
  }

  if (env.ADB_READY_JOURNAL_REDACT_ENVIRONMENT !== undefined) {
    const names = env.ADB_READY_JOURNAL_REDACT_ENVIRONMENT.split(",").map((value) => value.trim());
    if (names.length === 0 || names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) {
      errors.push(
        error(
          "environment",
          "ADB_READY_JOURNAL_REDACT_ENVIRONMENT",
          "ADB_READY_JOURNAL_REDACT_ENVIRONMENT",
          "ADB_READY_JOURNAL_REDACT_ENVIRONMENT must be a comma-separated list of environment variable names.",
        ),
      );
    } else {
      values.journalRedactEnvironment = [...new Set(names)];
    }
  }

  const integers = [
    ["ADB_READY_ADB_PORT", "adbPort", 65_535],
    ["ADB_READY_TIMEOUT_MS", "timeoutMs", 2_147_483_647],
    ["ADB_READY_JOURNAL_MAX_ENTRIES", "journalMaxEntries", 2_147_483_647],
    ["ADB_READY_JOURNAL_MAX_BYTES", "journalMaxBytes", 2_147_483_647],
    ["ADB_READY_RECOVERY_MAX_ATTEMPTS", "recoveryMaxAttempts", 2_147_483_647],
    ["ADB_READY_RECOVERY_INITIAL_DELAY_MS", "recoveryInitialDelayMs", 2_147_483_647],
    ["ADB_READY_RECOVERY_MAX_DELAY_MS", "recoveryMaxDelayMs", 2_147_483_647],
    ["ADB_READY_RECOVERY_TOTAL_TIMEOUT_MS", "recoveryTotalTimeoutMs", 2_147_483_647],
    ["ADB_READY_SESSION_MAX_SESSIONS", "sessionMaxSessions", 2_147_483_647],
    ["ADB_READY_SESSION_MAX_AGE_DAYS", "sessionMaxAgeDays", 2_147_483_647],
    ["ADB_READY_SESSION_MAX_BYTES", "sessionMaxBytes", 2_147_483_647],
  ] as const;
  for (const [name, key, maximum] of integers) {
    const candidate = env[name];
    if (candidate !== undefined) {
      const parsed = Number(candidate);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
        errors.push(
          error("environment", name, name, `${name} must be an integer from 1 to ${maximum}.`),
        );
      } else {
        values[key] = parsed;
      }
    }
  }

  const booleans = [
    ["ADB_READY_COLOR", "color"],
    ["ADB_READY_UNICODE", "unicode"],
    ["ADB_READY_ANIMATION", "animation"],
    ["ADB_READY_INTERACTIVE", "interactive"],
    ["ADB_READY_DEV_LOGS", "devLogs"],
    ["ADB_READY_CLEANUP_PORTS", "devCleanupPorts"],
    ["ADB_READY_DEV_WATCH", "devWatch"],
    ["ADB_READY_SESSION_PERSIST", "sessionPersist"],
  ] as const;
  for (const [name, key] of booleans) {
    const candidate = env[name];
    if (candidate !== undefined) {
      const normalized = candidate.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) {
        values[key] = true;
      } else if (["0", "false", "no", "off"].includes(normalized)) {
        values[key] = false;
      } else {
        errors.push(
          error("environment", name, name, `${name} must be true/false, 1/0, yes/no, or on/off.`),
        );
      }
    }
  }

  return { values, errors };
}

function applyValues(
  target: ConfigValues,
  provenance: Partial<Record<ConfigKey, ConfigProvenance | undefined>>,
  values: ConfigValues,
  source: ConfigSource,
  location?: string,
): void {
  for (const key of Object.keys(values) as ConfigKey[]) {
    const value = values[key];
    if (value !== undefined) {
      Object.assign(target, { [key]: value });
      provenance[key] = { source, ...(location === undefined ? {} : { location }) };
    }
  }
}

function resolveProfile(
  name: string,
  profiles: Readonly<Record<string, ConfigProfile>>,
): Array<{ name: string; values: ConfigValues }> {
  const chain: Array<{ name: string; values: ConfigValues }> = [];
  const seen = new Set<string>();
  let current: string | undefined = name;
  while (current !== undefined) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    const profile: ConfigProfile | undefined = profiles[current];
    if (profile === undefined) {
      break;
    }
    chain.unshift({ name: current, values: profile.values });
    current = profile.extends;
  }
  return chain;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<ConfigLoadResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const userFile = options.userConfigPath ?? defaultUserConfigPath(platform, env, homeDirectory);
  const environmentProjectFile = env.ADB_READY_CONFIG?.trim();
  const projectFile =
    options.projectConfigPath ??
    (environmentProjectFile === undefined || environmentProjectFile === ""
      ? options.explicitProjectConfig
        ? undefined
        : await findProjectConfig(cwd)
      : path.resolve(cwd, environmentProjectFile));
  const projectRequired =
    (options.explicitProjectConfig ?? false) ||
    (environmentProjectFile !== undefined && environmentProjectFile !== "");
  const errors: ConfigError[] = [];
  const values: ConfigValues = {};
  const provenance: Partial<Record<ConfigKey, ConfigProvenance | undefined>> = {};
  const files: LoadedConfig["files"] = {};

  applyValues(values, provenance, DEFAULTS, "default");

  const user = await readConfigDocument(userFile, "user", false);
  errors.push(...user.errors);
  if (user.loaded) {
    files.user = userFile;
    applyValues(values, provenance, user.values, "user", userFile);
  }

  let project: ValidatedDocument & { loaded: boolean } = {
    values: {},
    profiles: {},
    errors: [],
    loaded: false,
  };
  if (projectFile !== undefined) {
    project = await readConfigDocument(projectFile, "project", projectRequired);
    errors.push(...project.errors);
    if (project.loaded) {
      files.project = projectFile;
      applyValues(values, provenance, project.values, "project", projectFile);
    }
  } else if (projectRequired) {
    errors.push(
      error(
        "project",
        undefined,
        "$",
        "An explicit project configuration path is required.",
        "CONFIG_NOT_FOUND",
      ),
    );
  }

  const environmentProfile = env.ADB_READY_PROFILE;
  const validEnvironmentProfile =
    environmentProfile !== undefined && PROFILE_NAME.test(environmentProfile)
      ? environmentProfile
      : undefined;
  if (
    environmentProfile !== undefined &&
    (environmentProfile.trim() === "" || !PROFILE_NAME.test(environmentProfile))
  ) {
    errors.push(
      error(
        "environment",
        "ADB_READY_PROFILE",
        "ADB_READY_PROFILE",
        "ADB_READY_PROFILE must be a valid profile name.",
      ),
    );
  }
  const selectedProfile =
    options.profileName ?? validEnvironmentProfile ?? project.defaultProfile ?? user.defaultProfile;
  let loadedProfile: LoadedConfig["profile"];
  if (selectedProfile !== undefined) {
    const profileSource =
      project.profiles[selectedProfile] !== undefined
        ? { document: project, source: "project" as const, file: projectFile }
        : user.profiles[selectedProfile] !== undefined
          ? { document: user, source: "user" as const, file: userFile }
          : undefined;
    if (profileSource === undefined) {
      const selectionSource =
        options.profileName !== undefined
          ? { source: "cli" as const, location: "--profile" }
          : validEnvironmentProfile !== undefined
            ? { source: "environment" as const, location: "ADB_READY_PROFILE" }
            : ({
                source: project.defaultProfile === selectedProfile ? "project" : "user",
                location: project.defaultProfile === selectedProfile ? projectFile : userFile,
              } as const);
      errors.push(
        error(
          selectionSource.source,
          selectionSource.location,
          "profile",
          `Unknown configuration profile: ${selectedProfile}`,
        ),
      );
    } else {
      const chain = resolveProfile(selectedProfile, profileSource.document.profiles);
      for (const item of chain) {
        applyValues(
          values,
          provenance,
          item.values,
          "profile",
          `${profileSource.file ?? "configuration"}#profiles.${item.name}`,
        );
      }
      loadedProfile = {
        name: selectedProfile,
        source: profileSource.source,
        chain: chain.map(({ name }) => name),
      };
    }
  }

  const environment = parseEnvironment(env);
  errors.push(...environment.errors);
  applyValues(values, provenance, environment.values, "environment");
  applyValues(values, provenance, options.cli ?? {}, "cli");

  if (
    values.recoveryInitialDelayMs !== undefined &&
    values.recoveryMaxDelayMs !== undefined &&
    values.recoveryMaxDelayMs < values.recoveryInitialDelayMs
  ) {
    const source = provenance.recoveryMaxDelayMs?.source ?? "project";
    errors.push(
      error(
        source === "default" ? "project" : source,
        provenance.recoveryMaxDelayMs?.location,
        "dev.recovery.maxDelayMs",
        "Resolved recovery maxDelayMs must be at least initialDelayMs.",
      ),
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    config: {
      values: values as LoadedConfig["values"],
      provenance,
      ...(loadedProfile === undefined ? {} : { profile: loadedProfile }),
      files,
    },
  };
}
