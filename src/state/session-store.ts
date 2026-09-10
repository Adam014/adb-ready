import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import type { EventBus } from "../core/event-bus.js";
import { type RedactionOptions, redactText } from "../core/redaction.js";
import type { AdbReadyEvent, JsonValue, Problem, Severity } from "../domain/contracts.js";

export type StoredSessionStatus = "completed" | "failed" | "interrupted" | "running";

export interface StoredProblem {
  code: string;
  category: string;
  severity: Severity;
  summary: string;
  detail: string;
  retryable: boolean;
}

export interface SessionManifest {
  schemaVersion: 1;
  sessionId: string;
  status: StoredSessionStatus;
  command: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  eventFile: string;
  eventCount: number;
  eventBytes: number;
  targetFingerprint?: string;
  projectFingerprint?: string;
  preset?: string;
  problems: StoredProblem[];
}

export interface SessionStoreOptions {
  directory?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  maxSessions?: number;
  maxAgeDays?: number;
  maxBytes?: number;
  redaction?: RedactionOptions;
}

export interface SessionRecorderInput {
  sessionId: string;
  command: string;
  startedAt: string;
  privateLiterals?: readonly string[];
}

export interface SessionFinishInput {
  status: Exclude<StoredSessionStatus, "running">;
  finishedAt: string;
  problems?: readonly Problem[];
  targetIdentity?: string;
  projectName?: string;
  preset?: string;
}

export type SessionStoreResult<T> =
  | { ok: true; value: T; directory: string }
  | {
      ok: false;
      code: "SESSION_INVALID" | "SESSION_UNREADABLE" | "SESSION_UNWRITABLE";
      message: string;
      directory: string;
    };

const DEFAULT_MAX_SESSIONS = 30;
const DEFAULT_MAX_AGE_DAYS = 14;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

export function defaultSessionStoreDirectory(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  if (env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME.trim() !== "") {
    return platformPath.join(env.XDG_STATE_HOME, "adb-ready", "sessions");
  }
  if (platform === "win32") {
    const root = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim() || homeDirectory;
    return platformPath.join(root, "adb-ready", "sessions");
  }
  if (platform === "darwin") {
    return platformPath.join(
      homeDirectory,
      "Library",
      "Application Support",
      "adb-ready",
      "sessions",
    );
  }
  return platformPath.join(homeDirectory, ".local", "state", "adb-ready", "sessions");
}

function resolveDirectory(options: SessionStoreOptions): string {
  return (
    options.directory ??
    defaultSessionStoreDirectory(
      options.platform ?? process.platform,
      options.env ?? process.env,
      options.homeDirectory ?? homedir(),
    )
  );
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new RangeError("sessionId contains unsupported characters");
  }
}

function manifestPath(directory: string, sessionId: string): string {
  assertSessionId(sessionId);
  return path.join(directory, `${sessionId}.json`);
}

function eventPath(directory: string, sessionId: string): string {
  assertSessionId(sessionId);
  return path.join(directory, `${sessionId}.ndjson`);
}

async function atomicJson(file: string, value: JsonValue): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function storedProblem(problem: Problem, options: RedactionOptions): StoredProblem {
  return {
    code: problem.code,
    category: problem.category,
    severity: problem.severity,
    summary: redactText(problem.summary, options).value,
    detail: redactText(problem.detail, options).value,
    retryable: problem.retryable,
  };
}

function redactedJson(value: JsonValue, options: RedactionOptions): JsonValue {
  if (typeof value === "string") return redactText(value, options).value;
  if (Array.isArray(value)) return value.map((item) => redactedJson(item, options));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactedJson(item, options)]),
    );
  }
  return value;
}

function privateValues(event: AdbReadyEvent): string[] {
  const values = new Set<string>();
  if (event.correlation.targetId !== undefined) values.add(event.correlation.targetId);
  const data = event.data;
  for (const key of ["serial", "hardwareSerial", "endpoint", "targetId"] as const) {
    const value = data?.[key];
    if (typeof value === "string" && value !== "") values.add(value);
  }
  const args = data?.args;
  if (Array.isArray(args)) {
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if ((argument === "-s" || argument === "-t") && typeof args[index + 1] === "string") {
        values.add(args[index + 1] as string);
      }
      if ((argument === "connect" || argument === "pair") && typeof args[index + 1] === "string") {
        values.add(args[index + 1] as string);
      }
    }
  }
  return [...values];
}

function redactEvent(
  event: AdbReadyEvent,
  literals: ReadonlySet<string>,
  options: RedactionOptions,
): AdbReadyEvent {
  const redaction: RedactionOptions = {
    ...options,
    additionalLiterals: [...(options.additionalLiterals ?? []), ...literals],
  };
  return {
    ...event,
    message: redactText(event.message, redaction).value,
    correlation: {
      ...event.correlation,
      ...(event.correlation.targetId === undefined
        ? {}
        : { targetId: fingerprint(event.correlation.targetId) }),
    },
    ...(event.data === undefined
      ? {}
      : { data: redactedJson(event.data, redaction) as Record<string, JsonValue> }),
  };
}

function validManifest(value: unknown): value is SessionManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<SessionManifest>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.sessionId === "string" &&
    SESSION_ID_PATTERN.test(candidate.sessionId) &&
    (candidate.status === "running" ||
      candidate.status === "completed" ||
      candidate.status === "failed" ||
      candidate.status === "interrupted") &&
    typeof candidate.command === "string" &&
    typeof candidate.startedAt === "string" &&
    Number.isFinite(Date.parse(candidate.startedAt)) &&
    typeof candidate.updatedAt === "string" &&
    Number.isFinite(Date.parse(candidate.updatedAt)) &&
    typeof candidate.eventFile === "string" &&
    candidate.eventFile === `${candidate.sessionId}.ndjson` &&
    typeof candidate.eventCount === "number" &&
    typeof candidate.eventBytes === "number" &&
    Array.isArray(candidate.problems)
  );
}

async function pruneSessions(options: SessionStoreOptions): Promise<void> {
  const directory = resolveDirectory(options);
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  positiveInteger(maxSessions, "maxSessions");
  positiveInteger(maxAgeDays, "maxAgeDays");
  positiveInteger(maxBytes, "maxBytes");
  const listed = await listSessions(options);
  if (!listed.ok) return;
  const completed = listed.value
    .filter(({ status }) => status !== "running")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1_000;
  let retainedBytes = 0;
  for (const [index, manifest] of completed.entries()) {
    const files = [
      manifestPath(directory, manifest.sessionId),
      eventPath(directory, manifest.sessionId),
    ];
    const sizes = await Promise.all(
      files.map(async (file) => (await stat(file).catch(() => undefined))?.size ?? 0),
    );
    const bytes = sizes.reduce((total, size) => total + size, 0);
    const expired = Date.parse(manifest.updatedAt) < cutoff;
    const exceedsCount = index >= maxSessions;
    const exceedsBytes = retainedBytes + bytes > maxBytes;
    if (expired || exceedsCount || exceedsBytes) {
      await Promise.all(files.map(async (file) => await rm(file, { force: true })));
    } else {
      retainedBytes += bytes;
    }
  }
}

export class SessionRecorder {
  readonly #bus: EventBus;
  readonly #directory: string;
  readonly #eventPath: string;
  readonly #manifestPath: string;
  readonly #options: SessionStoreOptions;
  readonly #privateLiterals: Set<string>;
  readonly #unsubscribe: () => void;
  #manifest: SessionManifest;
  #pending: Promise<void> = Promise.resolve();
  #writeFailed = false;
  #closed = false;

  private constructor(
    bus: EventBus,
    manifest: SessionManifest,
    options: SessionStoreOptions,
    privateLiterals: readonly string[],
  ) {
    this.#bus = bus;
    this.#manifest = manifest;
    this.#options = options;
    this.#directory = resolveDirectory(options);
    this.#eventPath = eventPath(this.#directory, manifest.sessionId);
    this.#manifestPath = manifestPath(this.#directory, manifest.sessionId);
    this.#privateLiterals = new Set(privateLiterals.filter(Boolean));
    this.#unsubscribe = this.#bus.subscribe((event) => this.#record(event));
  }

  static async create(
    bus: EventBus,
    input: SessionRecorderInput,
    options: SessionStoreOptions = {},
  ): Promise<SessionRecorder> {
    assertSessionId(input.sessionId);
    const directory = resolveDirectory(options);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const manifest: SessionManifest = {
      schemaVersion: 1,
      sessionId: input.sessionId,
      status: "running",
      command: input.command,
      startedAt: input.startedAt,
      updatedAt: input.startedAt,
      eventFile: `${input.sessionId}.ndjson`,
      eventCount: 0,
      eventBytes: 0,
      problems: [],
    };
    const events = eventPath(directory, input.sessionId);
    try {
      await writeFile(events, "", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await atomicJson(manifestPath(directory, input.sessionId), manifest as unknown as JsonValue);
    } catch (error) {
      await rm(events, { force: true }).catch(() => undefined);
      throw error;
    }
    return new SessionRecorder(bus, manifest, options, input.privateLiterals ?? []);
  }

  addPrivateLiteral(value: string | undefined): void {
    if (value !== undefined && value !== "") this.#privateLiterals.add(value);
  }

  async finish(input: SessionFinishInput): Promise<SessionStoreResult<SessionManifest>> {
    if (this.#closed) {
      return {
        ok: false,
        code: "SESSION_INVALID",
        message: "The session recorder is already closed.",
        directory: this.#directory,
      };
    }
    this.#closed = true;
    this.#unsubscribe();
    await this.#pending;
    if (this.#writeFailed) {
      return {
        ok: false,
        code: "SESSION_UNWRITABLE",
        message: "ADB Ready could not persist all session events.",
        directory: this.#directory,
      };
    }
    const redaction: RedactionOptions = {
      ...this.#options.redaction,
      additionalLiterals: [
        ...(this.#options.redaction?.additionalLiterals ?? []),
        ...this.#privateLiterals,
      ],
    };
    this.#manifest = {
      ...this.#manifest,
      status: input.status,
      updatedAt: input.finishedAt,
      finishedAt: input.finishedAt,
      ...(input.targetIdentity === undefined
        ? {}
        : { targetFingerprint: fingerprint(input.targetIdentity) }),
      ...(input.projectName === undefined
        ? {}
        : { projectFingerprint: fingerprint(input.projectName) }),
      ...(input.preset === undefined ? {} : { preset: input.preset }),
      problems: (input.problems ?? []).map((problem) => storedProblem(problem, redaction)),
    };
    try {
      await atomicJson(this.#manifestPath, this.#manifest as unknown as JsonValue);
      await pruneSessions(this.#options);
      return { ok: true, value: structuredClone(this.#manifest), directory: this.#directory };
    } catch {
      return {
        ok: false,
        code: "SESSION_UNWRITABLE",
        message: "ADB Ready could not finalize its session history.",
        directory: this.#directory,
      };
    }
  }

  #record(event: AdbReadyEvent): void {
    if (this.#closed) return;
    for (const value of privateValues(event)) this.#privateLiterals.add(value);
    const safe = redactEvent(event, this.#privateLiterals, this.#options.redaction ?? {});
    const line = `${JSON.stringify(safe)}\n`;
    const bytes = Buffer.byteLength(line);
    this.#manifest.eventCount += 1;
    this.#manifest.eventBytes += bytes;
    this.#pending = this.#pending
      .then(async () => {
        await appendFile(this.#eventPath, line, { encoding: "utf8", mode: 0o600 });
      })
      .catch(() => {
        this.#writeFailed = true;
      });
  }
}

export async function listSessions(
  options: SessionStoreOptions = {},
): Promise<SessionStoreResult<SessionManifest[]>> {
  const directory = resolveDirectory(options);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, value: [], directory };
    }
    return {
      ok: false,
      code: "SESSION_UNREADABLE",
      message: "ADB Ready could not read its session history.",
      directory,
    };
  }
  const manifests: SessionManifest[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    try {
      const value: unknown = JSON.parse(await readFile(path.join(directory, entry), "utf8"));
      if (validManifest(value) && entry === `${value.sessionId}.json`) manifests.push(value);
    } catch {}
  }
  return {
    ok: true,
    value: manifests.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    directory,
  };
}

export async function readSession(
  sessionId: string,
  options: SessionStoreOptions = {},
): Promise<SessionStoreResult<SessionManifest>> {
  const directory = resolveDirectory(options);
  try {
    const value: unknown = JSON.parse(await readFile(manifestPath(directory, sessionId), "utf8"));
    return validManifest(value)
      ? { ok: true, value, directory }
      : {
          ok: false,
          code: "SESSION_INVALID",
          message: "The stored session manifest is invalid.",
          directory,
        };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof RangeError ? "SESSION_INVALID" : "SESSION_UNREADABLE",
      message: "ADB Ready could not read the requested session.",
      directory,
    };
  }
}

export async function readSessionEvents(
  sessionId: string,
  options: SessionStoreOptions = {},
): Promise<SessionStoreResult<AdbReadyEvent[]>> {
  const directory = resolveDirectory(options);
  try {
    const raw = await readFile(eventPath(directory, sessionId), "utf8");
    const events = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AdbReadyEvent);
    return { ok: true, value: events, directory };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof RangeError ? "SESSION_INVALID" : "SESSION_UNREADABLE",
      message: "ADB Ready could not read the requested session events.",
      directory,
    };
  }
}
