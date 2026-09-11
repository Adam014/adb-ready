import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

export type AgentDevTaskStatus =
  | "completed"
  | "failed"
  | "interrupted"
  | "running"
  | "starting"
  | "stopping";

interface AgentDevTaskRecord {
  schemaVersion: 1;
  handle: string;
  projectFingerprint: string;
  targetFingerprint: string;
  status: AgentDevTaskStatus;
  ready: boolean;
  pid: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  exitCode?: number;
  resultFile: string;
  diagnosticFile: string;
}

export interface AgentDevTask {
  handle: string;
  status: AgentDevTaskStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  exitCode?: number;
}

export interface AgentDevTaskOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cliPath: string;
  serial: string;
  targetIdentity: string;
  directory?: string;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  clock?: () => Date;
  processAlive?: (pid: number) => boolean;
}

export interface AgentDevTaskLookupOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  directory?: string;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  clock?: () => Date;
  processAlive?: (pid: number) => boolean;
}

const HANDLE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEARTBEAT_STALE_MS = 60_000;
const MAX_PROJECT_TASKS = 50;
const MAX_TASK_AGE_MS = 14 * 24 * 60 * 60 * 1_000;

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function defaultAgentTaskDirectory(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  if (env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME.trim() !== "") {
    return platformPath.join(env.XDG_STATE_HOME, "adb-ready", "agent-tasks");
  }
  if (platform === "win32") {
    const root = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim() || homeDirectory;
    return platformPath.join(root, "adb-ready", "agent-tasks");
  }
  if (platform === "darwin") {
    return platformPath.join(
      homeDirectory,
      "Library",
      "Application Support",
      "adb-ready",
      "agent-tasks",
    );
  }
  return platformPath.join(homeDirectory, ".local", "state", "adb-ready", "agent-tasks");
}

function rootDirectory(options: AgentDevTaskLookupOptions): string {
  return (
    options.directory ??
    defaultAgentTaskDirectory(
      options.platform ?? process.platform,
      options.env,
      options.homeDirectory ?? homedir(),
    )
  );
}

async function projectIdentity(cwd: string): Promise<string> {
  const absolute = path.resolve(cwd);
  const canonical = await realpath(absolute).catch(() => absolute);
  return fingerprint(`root:${process.platform === "win32" ? canonical.toLowerCase() : canonical}`);
}

function recordPath(directory: string, project: string, handle: string): string {
  if (!HANDLE_PATTERN.test(handle)) throw new RangeError("Invalid agent task handle");
  return path.join(directory, project, `${handle}.json`);
}

async function atomicRecord(file: string, record: AgentDevTaskRecord): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
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

function validRecord(value: unknown): value is AgentDevTaskRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<AgentDevTaskRecord>;
  return (
    item.schemaVersion === 1 &&
    typeof item.handle === "string" &&
    HANDLE_PATTERN.test(item.handle) &&
    typeof item.projectFingerprint === "string" &&
    typeof item.targetFingerprint === "string" &&
    new Set<AgentDevTaskStatus>([
      "completed",
      "failed",
      "interrupted",
      "running",
      "starting",
      "stopping",
    ]).has(item.status as AgentDevTaskStatus) &&
    typeof item.ready === "boolean" &&
    typeof item.pid === "number" &&
    Number.isSafeInteger(item.pid) &&
    item.pid >= 0 &&
    typeof item.startedAt === "string" &&
    typeof item.updatedAt === "string" &&
    typeof item.resultFile === "string" &&
    typeof item.diagnosticFile === "string"
  );
}

async function readRecord(file: string): Promise<AgentDevTaskRecord | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return validRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function publicTask(record: AgentDevTaskRecord): AgentDevTask {
  return {
    handle: record.handle,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function runtimeCommand(cliPath: string): { executable: string; args: string[] } {
  if (typeof (globalThis as { Deno?: unknown }).Deno !== "undefined") {
    return { executable: process.execPath, args: ["run", "-A", cliPath] };
  }
  return { executable: process.execPath, args: [cliPath] };
}

async function pruneTasks(taskDirectory: string, now: Date): Promise<void> {
  const entries = await readdir(taskDirectory).catch(() => []);
  const records = (
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => await readRecord(path.join(taskDirectory, entry))),
    )
  )
    .filter(
      (record): record is AgentDevTaskRecord => record !== undefined && terminal(record.status),
    )
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const expired = records.filter(
    (record, index) =>
      index >= MAX_PROJECT_TASKS - 1 ||
      now.getTime() - Date.parse(record.updatedAt) > MAX_TASK_AGE_MS,
  );
  await Promise.all(
    expired.flatMap((record) =>
      [".json", ".result.json", ".stderr.log"].map(
        async (suffix) =>
          await rm(path.join(taskDirectory, `${record.handle}${suffix}`), { force: true }),
      ),
    ),
  );
}

export async function startAgentDevTask(options: AgentDevTaskOptions): Promise<AgentDevTask> {
  const directory = rootDirectory(options);
  const project = await projectIdentity(options.cwd);
  const taskDirectory = path.join(directory, project);
  await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
  const clock = options.clock ?? (() => new Date());
  await pruneTasks(taskDirectory, clock());
  const handle = randomUUID();
  const resultFile = path.join(taskDirectory, `${handle}.result.json`);
  const diagnosticFile = path.join(taskDirectory, `${handle}.stderr.log`);
  const file = recordPath(directory, project, handle);
  const now = clock().toISOString();
  let record: AgentDevTaskRecord = {
    schemaVersion: 1,
    handle,
    projectFingerprint: project,
    targetFingerprint: fingerprint(options.targetIdentity),
    status: "starting",
    ready: false,
    pid: 0,
    startedAt: now,
    updatedAt: now,
    resultFile,
    diagnosticFile,
  };
  await atomicRecord(file, record);

  const stdout = await open(resultFile, "wx", 0o600);
  const stderr = await open(diagnosticFile, "wx", 0o600);
  try {
    const runtime = runtimeCommand(options.cliPath);
    const child = spawn(
      runtime.executable,
      [
        ...runtime.args,
        "dev",
        "--json",
        "--quiet",
        "--non-interactive",
        "--device",
        options.serial,
      ],
      {
        cwd: options.cwd,
        env: {
          ...options.env,
          ADB_READY_AGENT_TASK_FILE: file,
          ADB_READY_AGENT_TASK_HANDLE: handle,
        },
        detached: true,
        shell: false,
        stdio: ["ignore", stdout.fd, stderr.fd],
        windowsHide: true,
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (child.pid === undefined) throw new Error("Managed development process has no PID");
    const updatedAt = clock().toISOString();
    record = { ...record, status: "running", pid: child.pid, updatedAt };
    await atomicRecord(file, record);
    child.unref();
    return publicTask(record);
  } catch (error) {
    const finishedAt = clock().toISOString();
    record = { ...record, status: "failed", updatedAt: finishedAt, finishedAt, exitCode: 70 };
    await atomicRecord(file, record).catch(() => undefined);
    throw error;
  } finally {
    await Promise.all([stdout.close(), stderr.close()]);
  }
}

async function resolveTask(
  handle: string,
  options: AgentDevTaskLookupOptions,
): Promise<{ file: string; record: AgentDevTaskRecord } | undefined> {
  if (!HANDLE_PATTERN.test(handle)) return undefined;
  const project = await projectIdentity(options.cwd);
  const file = recordPath(rootDirectory(options), project, handle);
  const record = await readRecord(file);
  return record?.projectFingerprint === project ? { file, record } : undefined;
}

function terminal(status: AgentDevTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

export async function getAgentDevTask(
  handle: string,
  options: AgentDevTaskLookupOptions,
): Promise<AgentDevTask | undefined> {
  const resolved = await resolveTask(handle, options);
  if (resolved === undefined) return undefined;
  let { record } = resolved;
  if (!terminal(record.status)) {
    const alive = options.processAlive ?? processAlive;
    const now = options.clock ?? (() => new Date());
    if (
      record.pid < 1 ||
      !alive(record.pid) ||
      now().getTime() - Date.parse(record.updatedAt) > HEARTBEAT_STALE_MS
    ) {
      const finishedAt = now().toISOString();
      record = {
        ...record,
        status: "failed",
        updatedAt: finishedAt,
        finishedAt,
        exitCode: 70,
      };
      await atomicRecord(resolved.file, record);
    }
  }
  return publicTask(record);
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function finalizeIntentionalStop(
  file: string,
  expected: AgentDevTaskRecord,
  clock: () => Date,
): Promise<AgentDevTask> {
  const current = await readRecord(file);
  if (current !== undefined && terminal(current.status)) return publicTask(current);
  const owned =
    current !== undefined &&
    current.handle === expected.handle &&
    current.pid === expected.pid &&
    current.projectFingerprint === expected.projectFingerprint &&
    current.targetFingerprint === expected.targetFingerprint;
  if (!owned) return publicTask(expected);
  const finishedAt = clock().toISOString();
  const interrupted: AgentDevTaskRecord = {
    ...current,
    status: "interrupted",
    updatedAt: finishedAt,
    finishedAt,
    exitCode: 130,
  };
  await atomicRecord(file, interrupted);
  return publicTask(interrupted);
}

export async function stopAgentDevTask(
  handle: string,
  options: AgentDevTaskLookupOptions,
): Promise<AgentDevTask | undefined> {
  const resolved = await resolveTask(handle, options);
  if (resolved === undefined) return undefined;
  let { record } = resolved;
  if (terminal(record.status)) return publicTask(record);
  const alive = options.processAlive ?? processAlive;
  const clock = options.clock ?? (() => new Date());
  for (let attempt = 0; !record.ready && attempt < 20; attempt += 1) {
    await wait(50);
    record = (await readRecord(resolved.file)) ?? record;
  }
  if (
    !record.ready ||
    record.pid < 1 ||
    !alive(record.pid) ||
    clock().getTime() - Date.parse(record.updatedAt) > HEARTBEAT_STALE_MS
  ) {
    return await getAgentDevTask(handle, options);
  }

  record = { ...record, status: "stopping", updatedAt: clock().toISOString() };
  await atomicRecord(resolved.file, record);
  const targetPid = (options.platform ?? process.platform) === "win32" ? record.pid : -record.pid;
  try {
    process.kill(targetPid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await wait(100);
    const current = await readRecord(resolved.file);
    if (current !== undefined && terminal(current.status)) return publicTask(current);
    if (!alive(record.pid)) return await finalizeIntentionalStop(resolved.file, record, clock);
  }
  if (alive(record.pid)) {
    try {
      process.kill(targetPid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wait(50);
    const current = await readRecord(resolved.file);
    if (current !== undefined && terminal(current.status)) return publicTask(current);
    if (!alive(record.pid)) return await finalizeIntentionalStop(resolved.file, record, clock);
  }
  return await getAgentDevTask(handle, options);
}

export async function activateAgentTaskFromEnvironment(
  env: NodeJS.ProcessEnv,
): Promise<undefined | { finish(exitCode: number): Promise<void> }> {
  const file = env.ADB_READY_AGENT_TASK_FILE;
  const handle = env.ADB_READY_AGENT_TASK_HANDLE;
  if (file === undefined || handle === undefined || !HANDLE_PATTERN.test(handle)) return undefined;

  let record: AgentDevTaskRecord | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    record = await readRecord(file);
    if (record?.handle === handle && record.pid === process.pid) break;
    await wait(50);
  }
  if (record?.handle !== handle || record.pid !== process.pid) return undefined;
  record = { ...record, ready: true, status: "running", updatedAt: new Date().toISOString() };
  await atomicRecord(file, record);
  const heartbeat = setInterval(() => {
    void (async () => {
      const current = await readRecord(file);
      if (current?.handle !== handle || current.pid !== process.pid || terminal(current.status))
        return;
      await atomicRecord(file, { ...current, updatedAt: new Date().toISOString() }).catch(
        () => undefined,
      );
    })();
  }, 5_000);
  heartbeat.unref?.();
  return {
    async finish(exitCode: number): Promise<void> {
      clearInterval(heartbeat);
      const current = await readRecord(file);
      if (current?.handle !== handle || current.pid !== process.pid || terminal(current.status))
        return;
      const finishedAt = new Date().toISOString();
      await atomicRecord(file, {
        ...current,
        status: exitCode === 0 ? "completed" : exitCode === 130 ? "interrupted" : "failed",
        updatedAt: finishedAt,
        finishedAt,
        exitCode,
      });
    },
  };
}
