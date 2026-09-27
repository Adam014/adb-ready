import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactText } from "../core/redaction.js";
import {
  ExitCode,
  type OperationPlan,
  type Problem,
  type ResultEnvelope,
  SCHEMA_VERSION,
} from "../domain/contracts.js";
import { type ProcessResult, type ProcessRunner, runProcess } from "../platform/process-runner.js";

export type FirebaseTestType = "instrumentation" | "robo";
export type FirebaseAction = "cancel" | "devices" | FirebaseTestType;
export type FirebaseOutcome =
  | "assertion-failed"
  | "auth-failed"
  | "cancelled"
  | "flaky"
  | "inconclusive"
  | "infrastructure-failed"
  | "observation-stopped"
  | "observation-timed-out"
  | "passed"
  | "unsupported";

export interface FirebaseDevice {
  model: string;
  version: string;
  locale: string;
  orientation: "landscape" | "portrait";
}

export interface FirebaseCatalogDevice extends FirebaseDevice {
  name: string;
  form: string;
  formFactor?: string;
  capacity: "high" | "low" | "medium" | "none" | "unknown";
  tags: string[];
}

export interface FirebaseTestLabData {
  status: "cancelled" | "catalogued" | "completed" | "planned";
  action: FirebaseAction;
  project?: string;
  devices?: FirebaseCatalogDevice[];
  selectedDevices?: FirebaseDevice[];
  command?: { executable: string; args: string[] };
  plan?: OperationPlan;
  outcome?: FirebaseOutcome;
  matrixId?: string;
  consoleUrl?: string;
  results?: Array<{ outcome: string; axis: string; details: string }>;
  evidence?: {
    path: string;
    providerFiles: number;
    omittedFiles: number;
    collection: "complete" | "not-configured" | "remote-running" | "unavailable";
    remotePrefix?: string;
  };
  remoteContinues?: boolean;
}

export interface FirebaseTestLabOptions {
  cwd: string;
  action: FirebaseAction;
  gcloudPath?: string;
  project?: string;
  app?: string;
  test?: string;
  devices?: FirebaseDevice[];
  matrixId?: string;
  resultsBucket?: string;
  resultsDir?: string;
  testTimeout?: string;
  observationTimeoutMs?: number;
  allowDeprecated?: boolean;
  allowReducedStability?: boolean;
  allowLowCapacity?: boolean;
  dryRun?: boolean;
}

export interface FirebaseTestLabDependencies {
  clock?: () => Date;
  idFactory?: () => string;
  runner?: ProcessRunner;
  fetch?: typeof fetch;
}

export interface FirebaseTestLabExecution {
  result: ResultEnvelope<FirebaseTestLabData>;
  exitCode: number;
}

interface CatalogModel {
  id?: string;
  name?: string;
  form?: string;
  formFactor?: string;
  supportedVersionIds?: string[];
  tags?: string[];
  accessDeniedReasons?: string[];
  perVersionInfo?: Array<{
    versionId?: string;
    deviceCapacity?: string;
    tags?: string[];
  }>;
}

interface CatalogVersion {
  id?: string;
  tags?: string[];
}

const AUTH_PATTERN =
  /active account|auth login|authentication|credentials|permission denied|unauthenticated|unauthorized/iu;
const MATRIX_PATTERN = /Test \[([^\]\r\n]+)\] has been created in the Google Cloud\./u;
const CONSOLE_URL_PATTERN = /https:\/\/console\.firebase\.google\.com\/[A-Za-z0-9%_./?=&-]+/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PROVIDER_FILE_LIMIT = 100;
const PROVIDER_FILE_BYTES = 20 * 1024 * 1024;
const PROVIDER_TOTAL_BYTES = 50 * 1024 * 1024;
const PROVIDER_EXTENSIONS = new Set([
  ".ec",
  ".html",
  ".jpeg",
  ".jpg",
  ".json",
  ".log",
  ".mp4",
  ".png",
  ".proto",
  ".txt",
  ".webm",
  ".xml",
]);

interface StorageObject {
  url?: string;
  type?: string;
  metadata?: { size?: string | number };
}

function problem(
  code: string,
  category: string,
  summary: string,
  detail: string,
  commandId: string,
  retryable = true,
): Problem {
  return {
    code,
    category,
    severity: "error",
    summary,
    detail,
    retryable,
    evidence: [],
    actions: [],
    correlation: { commandId },
  };
}

function finish(
  started: Date,
  finished: Date,
  commandId: string,
  data: FirebaseTestLabData | null,
  problems: Problem[],
  exitCode: number,
): FirebaseTestLabExecution {
  return {
    exitCode,
    result: {
      schemaVersion: SCHEMA_VERSION,
      command: "test firebase",
      commandId,
      ok: exitCode === ExitCode.Success,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: Math.max(0, finished.getTime() - started.getTime()),
      data,
      problems,
    },
  };
}

function parseJsonArray<T>(value: string): T[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : undefined;
  } catch {
    return undefined;
  }
}

function success(result: ProcessResult): boolean {
  return (
    result.spawnError === undefined &&
    result.streamError === undefined &&
    result.exitCode === 0 &&
    !result.timedOut &&
    !result.aborted
  );
}

function capacity(value: string | undefined): FirebaseCatalogDevice["capacity"] {
  const normalized = value?.replace(/^DEVICE_CAPACITY_/u, "").toLowerCase();
  return normalized === "high" ||
    normalized === "medium" ||
    normalized === "low" ||
    normalized === "none"
    ? normalized
    : "unknown";
}

function hasTag(tags: readonly string[], expected: string): boolean {
  return tags.some((tag) => tag.toLowerCase().includes(expected));
}

function artifactArgument(cwd: string, value: string): string {
  return value.startsWith("gs://") ? value : path.resolve(cwd, value);
}

export function parseFirebaseDevice(value: string): FirebaseDevice | undefined {
  const fields = new Map<string, string>();
  for (const part of value.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) return undefined;
    const key = part.slice(0, separator).trim();
    const fieldValue = part.slice(separator + 1).trim();
    if (!new Set(["locale", "model", "orientation", "version"]).has(key) || fieldValue === "") {
      return undefined;
    }
    if (fields.has(key)) return undefined;
    fields.set(key, fieldValue);
  }
  const model = fields.get("model");
  const version = fields.get("version");
  const locale = fields.get("locale") ?? "en";
  const orientation = fields.get("orientation") ?? "portrait";
  if (
    model === undefined ||
    version === undefined ||
    !SAFE_ID.test(model) ||
    !SAFE_ID.test(version) ||
    !/^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})?$/u.test(locale) ||
    (orientation !== "portrait" && orientation !== "landscape")
  ) {
    return undefined;
  }
  return { model, version, locale, orientation };
}

export function parseFirebaseCatalog(
  modelsOutput: string,
  versionsOutput: string,
): FirebaseCatalogDevice[] | undefined {
  const models = parseJsonArray<CatalogModel>(modelsOutput);
  const versions = parseJsonArray<CatalogVersion>(versionsOutput);
  if (models === undefined || versions === undefined) return undefined;
  const versionTags = new Map(
    versions
      .filter(
        (version): version is CatalogVersion & { id: string } => typeof version.id === "string",
      )
      .map((version) => [version.id, version.tags ?? []]),
  );
  const devices: FirebaseCatalogDevice[] = [];
  for (const model of models) {
    if (typeof model.id !== "string" || !SAFE_ID.test(model.id)) continue;
    for (const version of model.supportedVersionIds ?? []) {
      if (!SAFE_ID.test(version)) continue;
      const info = model.perVersionInfo?.find((candidate) => candidate.versionId === version);
      devices.push({
        model: model.id,
        version,
        locale: "en",
        orientation: "portrait",
        name: model.name ?? model.id,
        form: model.form ?? "UNKNOWN",
        ...(model.formFactor === undefined ? {} : { formFactor: model.formFactor }),
        capacity: capacity(info?.deviceCapacity),
        tags: [
          ...new Set([
            ...(model.tags ?? []),
            ...((model.accessDeniedReasons?.length ?? 0) === 0 ? [] : ["access_denied"]),
            ...(versionTags.get(version) ?? []),
            ...(info?.tags ?? []),
          ]),
        ]
          .map((tag) => tag.toLowerCase())
          .sort(),
      });
    }
  }
  return devices.sort((left, right) =>
    `${left.model}/${left.version}`.localeCompare(`${right.model}/${right.version}`),
  );
}

function validateDevices(
  requested: readonly FirebaseDevice[],
  catalog: readonly FirebaseCatalogDevice[],
  options: FirebaseTestLabOptions,
): string | undefined {
  for (const device of requested) {
    const current = catalog.find(
      (candidate) => candidate.model === device.model && candidate.version === device.version,
    );
    if (current === undefined)
      return `${device.model}/${device.version} is unavailable or incompatible.`;
    if (hasTag(current.tags, "access_denied"))
      return `${device.model}/${device.version} is not accessible to this project.`;
    if (hasTag(current.tags, "deprecated") && options.allowDeprecated !== true)
      return `${device.model}/${device.version} is deprecated.`;
    if (hasTag(current.tags, "reduced_stability") && options.allowReducedStability !== true)
      return `${device.model}/${device.version} currently has reduced stability.`;
    if (current.capacity === "none")
      return `${device.model}/${device.version} currently has no capacity.`;
    if (current.capacity === "low" && options.allowLowCapacity !== true)
      return `${device.model}/${device.version} currently has low capacity.`;
  }
  return undefined;
}

function gcloudBase(options: FirebaseTestLabOptions): string[] {
  return ["--quiet", ...(options.project === undefined ? [] : [`--project=${options.project}`])];
}

function deviceArgument(device: FirebaseDevice): string {
  return `model=${device.model},version=${device.version},locale=${device.locale},orientation=${device.orientation}`;
}

function runArguments(options: FirebaseTestLabOptions, resultsDir: string): string[] {
  return [
    "firebase",
    "test",
    "android",
    "run",
    `--type=${options.action}`,
    `--app=${artifactArgument(options.cwd, options.app ?? "")}`,
    ...(options.action === "instrumentation"
      ? [`--test=${artifactArgument(options.cwd, options.test ?? "")}`]
      : []),
    ...(options.devices ?? []).flatMap((device) => ["--device", deviceArgument(device)]),
    ...(options.testTimeout === undefined ? [] : [`--timeout=${options.testTimeout}`]),
    ...(options.resultsBucket === undefined ? [] : [`--results-bucket=${options.resultsBucket}`]),
    ...(options.resultsBucket === undefined ? [] : [`--results-dir=${resultsDir}`]),
    "--format=json",
    ...gcloudBase(options),
  ];
}

function extractProviderIdentity(output: string): { matrixId?: string; consoleUrl?: string } {
  const matrixId = output.match(MATRIX_PATTERN)?.[1];
  const consoleUrl = output.match(CONSOLE_URL_PATTERN)?.[0];
  return {
    ...(matrixId === undefined ? {} : { matrixId }),
    ...(consoleUrl === undefined ? {} : { consoleUrl }),
  };
}

function parseOutcomes(output: string): Array<{ outcome: string; axis: string; details: string }> {
  const values = parseJsonArray<Record<string, unknown>>(output) ?? [];
  return values.flatMap((value) => {
    if (typeof value.outcome !== "string") return [];
    return [
      {
        outcome: value.outcome,
        axis: typeof value.axis_value === "string" ? value.axis_value : "unknown",
        details: typeof value.test_details === "string" ? value.test_details : "",
      },
    ];
  });
}

function classify(
  result: ProcessResult,
  outcomes: readonly { outcome: string }[],
): {
  outcome: FirebaseOutcome;
  exitCode: number;
  code: string;
} {
  if (result.timedOut)
    return {
      outcome: "observation-timed-out",
      exitCode: ExitCode.ChildProcess,
      code: "FTL_OBSERVATION_TIMED_OUT",
    };
  if (result.aborted)
    return {
      outcome: "observation-stopped",
      exitCode: ExitCode.Interrupted,
      code: "FTL_OBSERVATION_STOPPED",
    };
  if (AUTH_PATTERN.test(`${result.stderr}\n${result.stdout}`))
    return { outcome: "auth-failed", exitCode: ExitCode.Environment, code: "FTL_AUTH_FAILED" };
  if (result.exitCode === 0) {
    return {
      outcome: outcomes.some(({ outcome }) => outcome.toLowerCase() === "flaky")
        ? "flaky"
        : "passed",
      exitCode: ExitCode.Success,
      code: "",
    };
  }
  if (result.exitCode === 10)
    return {
      outcome: "assertion-failed",
      exitCode: ExitCode.ChildProcess,
      code: "FTL_ASSERTION_FAILED",
    };
  if (result.exitCode === 15)
    return { outcome: "inconclusive", exitCode: ExitCode.ChildProcess, code: "FTL_INCONCLUSIVE" };
  if (result.exitCode === 18)
    return { outcome: "unsupported", exitCode: ExitCode.InvalidInput, code: "FTL_UNSUPPORTED" };
  if (result.exitCode === 19)
    return { outcome: "cancelled", exitCode: ExitCode.Interrupted, code: "FTL_CANCELLED" };
  return {
    outcome: "infrastructure-failed",
    exitCode: ExitCode.ChildProcess,
    code: "FTL_INFRASTRUCTURE_FAILED",
  };
}

function parseStorageObjects(output: string): StorageObject[] | undefined {
  try {
    const parsed: unknown = JSON.parse(output);
    if (Array.isArray(parsed)) return parsed as StorageObject[];
    if (typeof parsed === "object" && parsed !== null) return [parsed as StorageObject];
  } catch {
    const records: StorageObject[] = [];
    for (const line of output.split(/\r?\n/u).filter((value) => value.trim() !== "")) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
          return undefined;
        records.push(parsed as StorageObject);
      } catch {
        return undefined;
      }
    }
    return records.length === 0 ? undefined : records;
  }
  return undefined;
}

function safeProviderName(index: number, url: string): string {
  const raw = url.slice(url.lastIndexOf("/") + 1) || "artifact";
  const safe = raw.replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 120) || "artifact";
  return `${String(index + 1).padStart(3, "0")}-${safe}`;
}

async function collectProviderEvidence(
  options: FirebaseTestLabOptions,
  runner: ProcessRunner,
  destination: string,
  resultsDir: string,
  remoteRunning: boolean,
): Promise<{
  providerFiles: number;
  omittedFiles: number;
  collection: "complete" | "not-configured" | "remote-running" | "unavailable";
  remotePrefix?: string;
  warning?: string;
}> {
  if (options.resultsBucket === undefined) {
    return { providerFiles: 0, omittedFiles: 0, collection: "not-configured" };
  }
  const remotePrefix = `${options.resultsBucket}/${resultsDir.replace(/^\/+|\/+$/gu, "")}`;
  if (remoteRunning) {
    return {
      providerFiles: 0,
      omittedFiles: 0,
      collection: "remote-running",
      remotePrefix,
    };
  }
  const listed = await runner({
    executable: options.gcloudPath ?? "gcloud",
    args: ["storage", "ls", "--recursive", "--json", remotePrefix, ...gcloudBase(options)],
    cwd: options.cwd,
    timeoutMs: 120_000,
    maxBufferBytes: 4 * 1024 * 1024,
  });
  if (!success(listed)) {
    return {
      providerFiles: 0,
      omittedFiles: 0,
      collection: "unavailable",
      remotePrefix,
      warning: redactText(listed.stderr || listed.stdout || "gcloud storage listing failed.").value,
    };
  }
  const objects = parseStorageObjects(listed.stdout);
  if (objects === undefined) {
    return {
      providerFiles: 0,
      omittedFiles: 0,
      collection: "unavailable",
      remotePrefix,
      warning: "gcloud storage returned an unreadable artifact listing.",
    };
  }
  const prefix = `${remotePrefix}/`;
  const eligible = objects.flatMap((object) => {
    if (
      object.type !== "cloud_object" ||
      typeof object.url !== "string" ||
      !object.url.startsWith(prefix) ||
      object.url.includes("?") ||
      !PROVIDER_EXTENSIONS.has(path.extname(object.url).toLowerCase())
    ) {
      return [];
    }
    const bytes = Number(object.metadata?.size);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > PROVIDER_FILE_BYTES) return [];
    return [{ url: object.url, bytes }];
  });
  const selected: Array<{ url: string; bytes: number }> = [];
  let totalBytes = 0;
  for (const object of eligible) {
    if (
      selected.length >= PROVIDER_FILE_LIMIT ||
      totalBytes + object.bytes > PROVIDER_TOTAL_BYTES
    ) {
      continue;
    }
    selected.push(object);
    totalBytes += object.bytes;
  }
  const providerDirectory = path.join(destination, "provider");
  await mkdir(providerDirectory, { recursive: true, mode: 0o700 });
  const manifest: Array<{ source: string; file: string; bytes: number }> = [];
  for (const [index, object] of selected.entries()) {
    const file = safeProviderName(index, object.url);
    const copied = await runner({
      executable: options.gcloudPath ?? "gcloud",
      args: [
        "storage",
        "cp",
        object.url,
        path.join(providerDirectory, file),
        ...gcloudBase(options),
      ],
      cwd: options.cwd,
      timeoutMs: 120_000,
      maxBufferBytes: 256 * 1024,
    });
    if (!success(copied)) {
      return {
        providerFiles: manifest.length,
        omittedFiles: objects.length - manifest.length,
        collection: "unavailable",
        remotePrefix,
        warning: redactText(copied.stderr || copied.stdout || "gcloud storage copy failed.").value,
      };
    }
    const localPath = path.join(providerDirectory, file);
    const local = await stat(localPath).catch(() => undefined);
    if (local === undefined || !local.isFile() || local.size !== object.bytes) {
      return {
        providerFiles: manifest.length,
        omittedFiles: objects.length - manifest.length,
        collection: "unavailable",
        remotePrefix,
        warning: `Downloaded provider artifact failed size verification: ${file}`,
      };
    }
    await chmod(localPath, 0o600);
    manifest.push({ source: object.url, file, bytes: object.bytes });
  }
  await writeFile(
    path.join(destination, "provider-files.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    providerFiles: manifest.length,
    omittedFiles: Math.max(0, objects.length - manifest.length),
    collection: "complete",
    remotePrefix,
  };
}

async function retainEvidence(
  options: FirebaseTestLabOptions,
  commandId: string,
  processResult: ProcessResult,
  data: FirebaseTestLabData,
  runner: ProcessRunner,
  resultsDir: string,
): Promise<{ evidence: NonNullable<FirebaseTestLabData["evidence"]>; warning?: string }> {
  const relative = path.join(".adb-ready", "artifacts", `firebase-${commandId}`);
  const destination = path.resolve(options.cwd, relative);
  const temporary = `${destination}.tmp`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    const provider = await collectProviderEvidence(
      options,
      runner,
      temporary,
      resultsDir,
      processResult.timedOut || processResult.aborted,
    );
    const evidence: NonNullable<FirebaseTestLabData["evidence"]> = {
      path: relative.split(path.sep).join("/"),
      providerFiles: provider.providerFiles,
      omittedFiles: provider.omittedFiles,
      collection: provider.collection,
      ...(provider.remotePrefix === undefined ? {} : { remotePrefix: provider.remotePrefix }),
    };
    data.evidence = evidence;
    await writeFile(path.join(temporary, "stdout.txt"), redactText(processResult.stdout).value, {
      mode: 0o600,
    });
    await writeFile(path.join(temporary, "stderr.txt"), redactText(processResult.stderr).value, {
      mode: 0o600,
    });
    await writeFile(path.join(temporary, "result.json"), `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
    });
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
    return { evidence, ...(provider.warning === undefined ? {} : { warning: provider.warning }) };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function readCatalog(
  options: FirebaseTestLabOptions,
  runner: ProcessRunner,
): Promise<{ catalog?: FirebaseCatalogDevice[]; failure?: ProcessResult }> {
  const executable = options.gcloudPath ?? "gcloud";
  const base = gcloudBase(options);
  const models = await runner({
    executable,
    args: ["firebase", "test", "android", "models", "list", "--format=json", ...base],
    cwd: options.cwd,
    timeoutMs: 120_000,
  });
  if (!success(models)) return { failure: models };
  const versions = await runner({
    executable,
    args: ["firebase", "test", "android", "versions", "list", "--format=json", ...base],
    cwd: options.cwd,
    timeoutMs: 120_000,
  });
  if (!success(versions)) return { failure: versions };
  const catalog = parseFirebaseCatalog(models.stdout, versions.stdout);
  return catalog === undefined ? {} : { catalog };
}

async function cancelMatrix(
  options: FirebaseTestLabOptions,
  runner: ProcessRunner,
  request: typeof fetch,
): Promise<{ ok: true } | { ok: false; detail: string; auth: boolean }> {
  const token = await runner({
    executable: options.gcloudPath ?? "gcloud",
    args: ["auth", "print-access-token", "--quiet"],
    cwd: options.cwd,
    timeoutMs: 30_000,
    maxBufferBytes: 64 * 1024,
  });
  if (!success(token) || token.stdout.trim() === "") {
    return { ok: false, detail: "Google Cloud authentication is unavailable.", auth: true };
  }
  const response = await request(
    `https://testing.googleapis.com/v1/projects/${encodeURIComponent(options.project ?? "")}/testMatrices/${encodeURIComponent(options.matrixId ?? "")}:cancel`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token.stdout.trim()}` },
      signal: AbortSignal.timeout(30_000),
    },
  ).catch(() => undefined);
  if (response === undefined)
    return {
      ok: false,
      detail: "Firebase Test Lab cancellation could not be reached.",
      auth: false,
    };
  if (!response.ok) {
    const detail = redactText(await response.text()).value;
    return {
      ok: false,
      detail: detail || `Firebase Test Lab returned HTTP ${String(response.status)}.`,
      auth: response.status === 401 || response.status === 403,
    };
  }
  return { ok: true };
}

export async function runFirebaseTestLab(
  options: FirebaseTestLabOptions,
  dependencies: FirebaseTestLabDependencies = {},
  signal?: AbortSignal,
): Promise<FirebaseTestLabExecution> {
  const clock = dependencies.clock ?? (() => new Date());
  const started = clock();
  const commandId = (dependencies.idFactory ?? randomUUID)();
  const runner = dependencies.runner ?? runProcess;
  const executable = options.gcloudPath ?? "gcloud";

  if (options.action === "cancel") {
    if (options.project === undefined || options.matrixId === undefined) {
      return finish(
        started,
        clock(),
        commandId,
        null,
        [
          problem(
            "FTL_CANCEL_INPUT_INVALID",
            "input.firebase",
            "Cancellation requires a project and matrix ID.",
            "Pass --project PROJECT and one exact matrix ID.",
            commandId,
            false,
          ),
        ],
        ExitCode.InvalidInput,
      );
    }
    if (options.dryRun === true) {
      const plan: OperationPlan = {
        schemaVersion: SCHEMA_VERSION,
        dryRun: true,
        steps: [
          {
            id: "firebase-cancel",
            title: `Cancel Firebase Test Lab matrix ${options.matrixId}`,
            risk: "destructive",
            executable: "Firebase Testing API",
            args: [options.project, options.matrixId],
          },
        ],
      };
      return finish(
        started,
        clock(),
        commandId,
        {
          status: "planned",
          action: "cancel",
          project: options.project,
          matrixId: options.matrixId,
          plan,
        },
        [],
        ExitCode.Success,
      );
    }
    const cancelled = await cancelMatrix(options, runner, dependencies.fetch ?? fetch);
    if (!cancelled.ok) {
      return finish(
        started,
        clock(),
        commandId,
        null,
        [
          problem(
            cancelled.auth ? "FTL_AUTH_FAILED" : "FTL_CANCEL_FAILED",
            cancelled.auth ? "environment.auth" : "provider.firebase",
            "Firebase Test Lab matrix cancellation failed.",
            cancelled.detail,
            commandId,
          ),
        ],
        cancelled.auth ? ExitCode.Environment : ExitCode.ChildProcess,
      );
    }
    return finish(
      started,
      clock(),
      commandId,
      {
        status: "cancelled",
        action: "cancel",
        project: options.project,
        matrixId: options.matrixId,
        outcome: "cancelled",
      },
      [],
      ExitCode.Success,
    );
  }

  if (options.action === "devices") {
    const catalogResult = await readCatalog(options, runner);
    if (catalogResult.failure !== undefined || catalogResult.catalog === undefined) {
      const failure = catalogResult.failure;
      const auth = AUTH_PATTERN.test(`${failure?.stderr ?? ""}\n${failure?.stdout ?? ""}`);
      return finish(
        started,
        clock(),
        commandId,
        null,
        [
          problem(
            auth ? "FTL_AUTH_FAILED" : "FTL_CATALOG_FAILED",
            auth ? "environment.auth" : "provider.firebase.catalog",
            "Firebase Test Lab device catalog is unavailable.",
            auth
              ? "Authenticate gcloud for the selected project."
              : "gcloud did not return a valid machine-readable device catalog.",
            commandId,
          ),
        ],
        auth ? ExitCode.Environment : ExitCode.ChildProcess,
      );
    }
    return finish(
      started,
      clock(),
      commandId,
      {
        status: "catalogued",
        action: "devices",
        ...(options.project === undefined ? {} : { project: options.project }),
        devices: catalogResult.catalog,
      },
      [],
      ExitCode.Success,
    );
  }

  if (
    options.app === undefined ||
    (options.action === "instrumentation" && options.test === undefined) ||
    options.devices === undefined ||
    options.devices.length === 0
  ) {
    return finish(
      started,
      clock(),
      commandId,
      null,
      [
        problem(
          "FTL_RUN_INPUT_INVALID",
          "input.firebase",
          "Firebase Test Lab requires explicit artifacts and at least one device.",
          "Pass --app, --test for instrumentation, and one or more --test-device values.",
          commandId,
          false,
        ),
      ],
      ExitCode.InvalidInput,
    );
  }
  for (const candidate of [options.app, ...(options.test === undefined ? [] : [options.test])]) {
    if (candidate.startsWith("gs://")) continue;
    const exists = await stat(path.resolve(options.cwd, candidate))
      .then((entry) => entry.isFile())
      .catch(() => false);
    if (!exists)
      return finish(
        started,
        clock(),
        commandId,
        null,
        [
          problem(
            "FTL_ARTIFACT_NOT_FOUND",
            "input.artifact",
            "A Firebase Test Lab artifact was not found.",
            candidate,
            commandId,
            false,
          ),
        ],
        ExitCode.InvalidInput,
      );
  }

  const catalogResult = await readCatalog(options, runner);
  if (catalogResult.failure !== undefined || catalogResult.catalog === undefined) {
    const failure = catalogResult.failure;
    const auth = AUTH_PATTERN.test(`${failure?.stderr ?? ""}\n${failure?.stdout ?? ""}`);
    return finish(
      started,
      clock(),
      commandId,
      null,
      [
        problem(
          auth ? "FTL_AUTH_FAILED" : "FTL_CATALOG_FAILED",
          auth ? "environment.auth" : "provider.firebase.catalog",
          "Firebase Test Lab preflight could not read the live device catalog.",
          auth
            ? "Authenticate gcloud for the selected project."
            : "Retry after checking gcloud and Firebase Test Lab availability.",
          commandId,
        ),
      ],
      auth ? ExitCode.Environment : ExitCode.ChildProcess,
    );
  }
  const rejected = validateDevices(options.devices, catalogResult.catalog, options);
  if (rejected !== undefined)
    return finish(
      started,
      clock(),
      commandId,
      null,
      [
        problem(
          "FTL_DEVICE_POLICY_REJECTED",
          "input.firebase.device",
          "The requested Firebase Test Lab device was rejected by policy.",
          rejected,
          commandId,
          false,
        ),
      ],
      ExitCode.InvalidInput,
    );

  const resultsDir = options.resultsDir ?? `adb-ready/${commandId}`;
  const args = runArguments(options, resultsDir);
  const plan: OperationPlan = {
    schemaVersion: SCHEMA_VERSION,
    dryRun: options.dryRun === true,
    steps: [
      {
        id: "firebase-test",
        title: `Run one bounded Firebase Test Lab ${options.action} matrix`,
        risk: "open-world",
        executable,
        args,
      },
    ],
  };
  if (options.dryRun === true)
    return finish(
      started,
      clock(),
      commandId,
      {
        status: "planned",
        action: options.action,
        ...(options.project === undefined ? {} : { project: options.project }),
        selectedDevices: options.devices,
        command: { executable, args },
        plan,
      },
      [],
      ExitCode.Success,
    );

  const executed = await runner({
    executable,
    args,
    cwd: options.cwd,
    ...(signal === undefined ? {} : { signal }),
    timeoutMs: options.observationTimeoutMs ?? 30 * 60_000,
    killSignal: "SIGKILL",
    killProcessGroup: true,
    maxBufferBytes: 4 * 1024 * 1024,
  });
  const results = parseOutcomes(executed.stdout);
  const classified = classify(executed, results);
  const identity = extractProviderIdentity(`${executed.stderr}\n${executed.stdout}`);
  const data: FirebaseTestLabData = {
    status: "completed",
    action: options.action,
    ...(options.project === undefined ? {} : { project: options.project }),
    selectedDevices: options.devices,
    command: { executable, args },
    outcome: classified.outcome,
    ...identity,
    results,
    ...((executed.timedOut || executed.aborted) && identity.matrixId !== undefined
      ? { remoteContinues: true }
      : {}),
  };
  const retained = await retainEvidence(options, commandId, executed, data, runner, resultsDir);
  const problems: Problem[] =
    classified.exitCode === ExitCode.Success
      ? []
      : [
          problem(
            classified.code,
            `provider.firebase.${classified.outcome}`,
            `Firebase Test Lab ${classified.outcome.replaceAll("-", " ")}.`,
            executed.timedOut || executed.aborted
              ? "Local observation stopped without cancelling the remote matrix. Use test firebase cancel explicitly if cancellation is intended."
              : redactText(
                  executed.stderr ||
                    executed.stdout ||
                    "Firebase Test Lab returned no diagnostic output.",
                ).value,
            commandId,
            classified.outcome !== "assertion-failed",
          ),
        ];
  if (retained.warning !== undefined) {
    problems.push({
      ...problem(
        "FTL_EVIDENCE_COLLECTION_FAILED",
        "evidence.firebase",
        "Firebase Test Lab provider evidence could not be collected completely.",
        retained.warning,
        commandId,
      ),
      severity: "warning",
    });
  }
  return finish(started, clock(), commandId, data, problems, classified.exitCode);
}
