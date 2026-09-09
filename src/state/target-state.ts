import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

export interface RememberedTarget {
  serial: string;
  hardwareSerial?: string;
  updatedAt: string;
}

export interface TargetStateDocument {
  version: 1;
  targets: Record<string, RememberedTarget>;
}

export interface TargetStateOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  statePath?: string;
  adbHost?: string;
  adbPort?: number;
}

export type StateReadResult =
  | { ok: true; document: TargetStateDocument; path: string }
  | { ok: false; code: "STATE_INVALID" | "STATE_UNREADABLE"; message: string; path: string };

export type StateWriteResult =
  | { ok: true; path: string }
  | { ok: false; code: "STATE_INVALID" | "STATE_UNWRITABLE"; message: string; path: string };

const EMPTY_STATE: TargetStateDocument = { version: 1, targets: {} };
const MAX_REMEMBERED_SERVERS = 20;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseState(value: unknown): TargetStateDocument | undefined {
  if (!isObject(value) || value.version !== 1 || !isObject(value.targets)) {
    return undefined;
  }
  const targets: Record<string, RememberedTarget> = {};
  for (const [scope, candidate] of Object.entries(value.targets)) {
    if (
      !isObject(candidate) ||
      typeof candidate.serial !== "string" ||
      candidate.serial.trim() === "" ||
      typeof candidate.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.updatedAt)) ||
      (candidate.hardwareSerial !== undefined && typeof candidate.hardwareSerial !== "string")
    ) {
      return undefined;
    }
    targets[scope] = {
      serial: candidate.serial,
      updatedAt: candidate.updatedAt,
      ...(candidate.hardwareSerial === undefined
        ? {}
        : { hardwareSerial: candidate.hardwareSerial }),
    };
  }
  return { version: 1, targets };
}

export function defaultTargetStatePath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  if (env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME.trim() !== "") {
    return platformPath.join(env.XDG_STATE_HOME, "adb-ready", "state.json");
  }
  if (platform === "win32") {
    const root = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim() || homeDirectory;
    return platformPath.join(root, "adb-ready", "state.json");
  }
  if (platform === "darwin") {
    return platformPath.join(
      homeDirectory,
      "Library",
      "Application Support",
      "adb-ready",
      "state.json",
    );
  }
  return platformPath.join(homeDirectory, ".local", "state", "adb-ready", "state.json");
}

export function adbServerScope(options: Pick<TargetStateOptions, "adbHost" | "adbPort">): string {
  if (options.adbHost === undefined && options.adbPort === undefined) {
    return "local:5037";
  }
  return `remote:${(options.adbHost ?? "127.0.0.1").toLowerCase()}:${String(options.adbPort ?? 5037)}`;
}

function resolvedStatePath(options: TargetStateOptions): string {
  return (
    options.statePath ??
    defaultTargetStatePath(
      options.platform ?? process.platform,
      options.env ?? process.env,
      options.homeDirectory ?? homedir(),
    )
  );
}

export async function readTargetState(options: TargetStateOptions = {}): Promise<StateReadResult> {
  const statePath = resolvedStatePath(options);
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, document: structuredClone(EMPTY_STATE), path: statePath };
    }
    return {
      ok: false,
      code: "STATE_UNREADABLE",
      message: "ADB Ready could not read its per-user target state.",
      path: statePath,
    };
  }
  try {
    const document = parseState(JSON.parse(raw));
    return document === undefined
      ? {
          ok: false,
          code: "STATE_INVALID",
          message: "ADB Ready target state has an unsupported or invalid shape.",
          path: statePath,
        }
      : { ok: true, document, path: statePath };
  } catch {
    return {
      ok: false,
      code: "STATE_INVALID",
      message: "ADB Ready target state is not valid JSON.",
      path: statePath,
    };
  }
}

export function rememberedTarget(
  document: TargetStateDocument,
  options: Pick<TargetStateOptions, "adbHost" | "adbPort">,
): RememberedTarget | undefined {
  return document.targets[adbServerScope(options)];
}

export async function writeRememberedTarget(
  target: Omit<RememberedTarget, "updatedAt"> & { updatedAt?: string },
  options: TargetStateOptions = {},
): Promise<StateWriteResult> {
  const statePath = resolvedStatePath(options);
  const existing = await readTargetState({ ...options, statePath });
  if (!existing.ok) {
    return {
      ok: false,
      code: existing.code === "STATE_INVALID" ? "STATE_INVALID" : "STATE_UNWRITABLE",
      message: existing.message,
      path: existing.path,
    };
  }
  const scope = adbServerScope(options);
  const entries = Object.entries({
    ...existing.document.targets,
    [scope]: {
      serial: target.serial,
      ...(target.hardwareSerial === undefined ? {} : { hardwareSerial: target.hardwareSerial }),
      updatedAt: target.updatedAt ?? new Date().toISOString(),
    },
  })
    .sort(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_REMEMBERED_SERVERS);
  const document: TargetStateDocument = { version: 1, targets: Object.fromEntries(entries) };
  const directory = path.dirname(statePath);
  const temporary = path.join(directory, `.state-${String(process.pid)}-${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, statePath);
    return { ok: true, path: statePath };
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    return {
      ok: false,
      code: "STATE_UNWRITABLE",
      message: "ADB Ready could not update its per-user target state.",
      path: statePath,
    };
  }
}
