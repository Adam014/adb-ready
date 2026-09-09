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
  cli?: ConfigValues;
}

const DEFAULTS: Required<Pick<ConfigValues, "timeoutMs">> = { timeoutMs: 5_000 };
const ROOT_KEYS = new Set(["$schema", "version", "adb", "timeoutMs", "output"]);
const ADB_KEYS = new Set(["path", "host", "port"]);
const OUTPUT_KEYS = new Set(["color", "unicode", "animation", "interactive"]);

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

function validateDocument(
  document: unknown,
  source: Extract<ConfigSource, "project" | "user">,
  location: string,
): { values: ConfigValues; errors: ConfigError[] } {
  const errors: ConfigError[] = [];
  const values: ConfigValues = {};
  if (!isObject(document)) {
    return {
      values,
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

  return { values, errors };
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
): Promise<{ values: ConfigValues; errors: ConfigError[]; loaded: boolean }> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (caught) {
    const code = (caught as NodeJS.ErrnoException).code;
    if (!required && code === "ENOENT") {
      return { values: {}, errors: [], loaded: false };
    }
    return {
      values: {},
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
  ] as const;
  for (const [name, key] of strings) {
    const candidate = env[name];
    if (candidate !== undefined) {
      if (candidate.trim() === "") {
        errors.push(error("environment", name, name, `${name} cannot be empty.`));
      } else {
        values[key] = candidate;
      }
    }
  }

  const integers = [
    ["ADB_READY_ADB_PORT", "adbPort", 65_535],
    ["ADB_READY_TIMEOUT_MS", "timeoutMs", 2_147_483_647],
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
  provenance: Record<ConfigKey, ConfigProvenance | undefined>,
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
  const provenance = {} as Record<ConfigKey, ConfigProvenance | undefined>;
  const files: LoadedConfig["files"] = {};

  applyValues(values, provenance, DEFAULTS, "default");

  const user = await readConfigDocument(userFile, "user", false);
  errors.push(...user.errors);
  if (user.loaded) {
    files.user = userFile;
    applyValues(values, provenance, user.values, "user", userFile);
  }

  if (projectFile !== undefined) {
    const project = await readConfigDocument(projectFile, "project", projectRequired);
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

  const environment = parseEnvironment(env);
  errors.push(...environment.errors);
  applyValues(values, provenance, environment.values, "environment");
  applyValues(values, provenance, options.cli ?? {}, "cli");

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    config: {
      values: values as LoadedConfig["values"],
      provenance,
      files,
    },
  };
}
