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
  "defaultProfile",
  "profiles",
]);
const PROFILE_KEYS = new Set(["extends", "adb", "timeoutMs", "output", "targets"]);
const ADB_KEYS = new Set(["path", "host", "port"]);
const OUTPUT_KEYS = new Set(["color", "unicode", "animation", "interactive"]);
const TARGET_KEYS = new Set(["aliases"]);
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
        for (const key of ["adb", "timeoutMs", "output", "targets"] as const) {
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
