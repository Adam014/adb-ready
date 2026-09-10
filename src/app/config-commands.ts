import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConfigProvenance, ConfigValues, LoadedConfig } from "../config/types.js";
import { redactText } from "../core/redaction.js";
import { type DevPreset, detectProject, type PackageManagerName } from "../dev/project.js";
import type { JsonValue, Problem, ResultEnvelope } from "../domain/contracts.js";
import { ExitCode, SCHEMA_VERSION } from "../domain/contracts.js";

export interface ConfigCommandDependencies {
  clock?: () => Date;
  detectProject?: typeof detectProject;
  idFactory?: () => string;
}

export interface InitOptions {
  cwd: string;
  preset?: DevPreset;
  packageManager?: PackageManagerName;
  reversePorts?: readonly number[];
  logs?: boolean;
  cleanupPorts?: boolean;
  force?: boolean;
  dryRun?: boolean;
}

export interface InitData {
  status: "created" | "planned" | "replaced";
  path: string;
  detectedPreset?: DevPreset;
  detectedPackageManager?: PackageManagerName;
  document: JsonValue;
}

export interface ConfigValueExplanation {
  key: string;
  value: JsonValue;
  source: ConfigProvenance["source"];
  location?: string;
}

export interface ConfigReportData {
  action: "explain" | "validate";
  valid: true;
  files: { project?: string; user?: string };
  profile?: LoadedConfig["profile"];
  values?: ConfigValueExplanation[];
}

export interface ConfigCommandExecution<T> {
  result: ResultEnvelope<T>;
  exitCode: number;
}

function execute<T>(
  command: string,
  data: T | null,
  problems: Problem[],
  dependencies: ConfigCommandDependencies,
): ConfigCommandExecution<T> {
  const now = (dependencies.clock ?? (() => new Date()))();
  const ok = problems.every(({ severity }) => severity !== "error");
  return {
    exitCode: ok ? ExitCode.Success : ExitCode.InvalidInput,
    result: {
      schemaVersion: SCHEMA_VERSION,
      command,
      commandId: (dependencies.idFactory ?? randomUUID)(),
      ok,
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      durationMs: 0,
      data,
      problems,
    },
  };
}

function configProblem(code: string, summary: string, detail: string): Problem {
  return {
    code,
    category: "input.configuration",
    severity: "error",
    summary,
    detail,
    retryable: true,
    evidence: [],
    actions: [],
    correlation: { commandId: "config" },
  };
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function safeLocation(location: string | undefined): string | undefined {
  if (location === undefined) return undefined;
  return redactText(path.basename(location)).value;
}

export function projectConfigDocument(options: {
  preset?: DevPreset;
  packageManager?: PackageManagerName;
  reversePorts?: readonly number[];
  logs?: boolean;
  cleanupPorts?: boolean;
}): JsonValue {
  const frameworkPorts =
    options.preset === "expo" || options.preset === "react-native" ? [8081] : [];
  const reversePorts = [...new Set(options.reversePorts ?? frameworkPorts)];
  const dev = {
    ...(options.preset === undefined ? {} : { preset: options.preset }),
    ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
    ...(reversePorts.length === 0 ? {} : { reversePorts }),
    logs: options.logs ?? true,
    cleanupPorts: options.cleanupPorts ?? true,
    watch: true,
  };
  return {
    $schema: "./node_modules/adb-ready/schema/config-v1.schema.json",
    version: 1,
    dev,
  };
}

export async function runInit(
  options: InitOptions,
  dependencies: ConfigCommandDependencies = {},
): Promise<ConfigCommandExecution<InitData>> {
  const project = await (dependencies.detectProject ?? detectProject)({
    cwd: options.cwd,
    ...(options.packageManager === undefined
      ? {}
      : { explicitPackageManager: options.packageManager }),
  });
  const preset = options.preset ?? project.preset;
  const packageManager = options.packageManager ?? project.packageManager.name;
  const document = projectConfigDocument({
    ...(preset === undefined ? {} : { preset }),
    ...(packageManager === undefined ? {} : { packageManager }),
    ...(options.reversePorts === undefined ? {} : { reversePorts: options.reversePorts }),
    ...(options.logs === undefined ? {} : { logs: options.logs }),
    ...(options.cleanupPorts === undefined ? {} : { cleanupPorts: options.cleanupPorts }),
  });
  const destination = path.join(project.root, "adb-ready.config.json");
  const displayPath = path.relative(options.cwd, destination) || path.basename(destination);
  const exists = await stat(destination)
    .then((entry) => entry.isFile())
    .catch(() => false);
  if (exists && !options.force) {
    return execute<InitData>(
      "init",
      null,
      [
        configProblem(
          "CONFIG_ALREADY_EXISTS",
          "A project configuration already exists.",
          "Review the existing file or pass --force to replace it explicitly.",
        ),
      ],
      dependencies,
    );
  }
  if (options.dryRun) {
    return execute(
      "init",
      {
        status: "planned",
        path: displayPath,
        ...(project.preset === undefined ? {} : { detectedPreset: project.preset }),
        ...(project.packageManager.name === undefined
          ? {}
          : { detectedPackageManager: project.packageManager.name }),
        document,
      },
      [],
      dependencies,
    );
  }
  const temporary = path.join(project.root, `.adb-ready.config-${randomUUID()}.tmp`);
  const backup = path.join(project.root, `.adb-ready.config-${randomUUID()}.backup`);
  let movedExisting = false;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    if (exists) {
      await rename(destination, backup);
      movedExisting = true;
    }
    await rename(temporary, destination);
    JSON.parse(await readFile(destination, "utf8"));
    if (movedExisting) await rm(backup, { force: true });
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (movedExisting) {
      await rm(destination, { force: true }).catch(() => undefined);
      await rename(backup, destination).catch(() => undefined);
    }
    return execute<InitData>(
      "init",
      null,
      [
        configProblem(
          "CONFIG_WRITE_FAILED",
          "The project configuration could not be written safely.",
          "Check project directory permissions and retry.",
        ),
      ],
      dependencies,
    );
  }
  return execute(
    "init",
    {
      status: exists ? "replaced" : "created",
      path: displayPath,
      ...(project.preset === undefined ? {} : { detectedPreset: project.preset }),
      ...(project.packageManager.name === undefined
        ? {}
        : { detectedPackageManager: project.packageManager.name }),
      document,
    },
    [],
    dependencies,
  );
}

export function runConfigReport(
  action: "explain" | "validate",
  loaded: LoadedConfig,
  dependencies: ConfigCommandDependencies = {},
): ConfigCommandExecution<ConfigReportData> {
  const projectFile = safeLocation(loaded.files.project);
  const userFile = safeLocation(loaded.files.user);
  const files = {
    ...(projectFile === undefined ? {} : { project: projectFile }),
    ...(userFile === undefined ? {} : { user: userFile }),
  };
  const values = (Object.keys(loaded.values) as Array<keyof ConfigValues>)
    .sort()
    .flatMap((key): ConfigValueExplanation[] => {
      const value = loaded.values[key];
      const provenance = loaded.provenance[key];
      if (value === undefined || provenance === undefined) return [];
      const location = safeLocation(provenance.location);
      return [
        {
          key,
          value: jsonValue(value),
          source: provenance.source,
          ...(location === undefined ? {} : { location }),
        },
      ];
    });
  return execute<ConfigReportData>(
    `config ${action}`,
    {
      action,
      valid: true,
      files,
      ...(loaded.profile === undefined ? {} : { profile: loaded.profile }),
      ...(action === "explain" ? { values } : {}),
    },
    [],
    dependencies,
  );
}
