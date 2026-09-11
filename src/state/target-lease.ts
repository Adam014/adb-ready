import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import process from "node:process";

export interface TargetLeaseOwner {
  schemaVersion: 1;
  leaseId: string;
  targetFingerprint: string;
  projectFingerprint: string;
  purpose: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface TargetLeaseOptions {
  directory?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  ttlMs?: number;
  heartbeatIntervalMs?: number;
  clock?: () => Date;
  pid?: number;
  hostname?: string;
  processAlive?: (pid: number) => boolean;
}

export interface TargetLeaseRequest {
  targetIdentity: string;
  projectRoot: string;
  purpose: string;
}

export interface TargetLeaseHandle {
  owner: TargetLeaseOwner;
  release(): Promise<boolean>;
}

export type TargetLeaseResult =
  | { ok: true; lease: TargetLeaseHandle }
  | {
      ok: false;
      code: "TARGET_BUSY" | "TARGET_LEASE_UNAVAILABLE";
      message: string;
      owner?: TargetLeaseOwner;
    };

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const OWNER_FILE = "owner.json";

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export function defaultTargetLeaseDirectory(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  if (env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME.trim() !== "") {
    return platformPath.join(env.XDG_STATE_HOME, "adb-ready", "leases");
  }
  if (platform === "win32") {
    const root = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim() || homeDirectory;
    return platformPath.join(root, "adb-ready", "leases");
  }
  if (platform === "darwin") {
    return platformPath.join(
      homeDirectory,
      "Library",
      "Application Support",
      "adb-ready",
      "leases",
    );
  }
  return platformPath.join(homeDirectory, ".local", "state", "adb-ready", "leases");
}

function leaseDirectory(options: TargetLeaseOptions): string {
  return (
    options.directory ??
    defaultTargetLeaseDirectory(
      options.platform ?? process.platform,
      options.env ?? process.env,
      options.homeDirectory ?? homedir(),
    )
  );
}

function validOwner(value: unknown): value is TargetLeaseOwner {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Partial<TargetLeaseOwner>;
  return (
    owner.schemaVersion === 1 &&
    typeof owner.leaseId === "string" &&
    typeof owner.targetFingerprint === "string" &&
    typeof owner.projectFingerprint === "string" &&
    typeof owner.purpose === "string" &&
    typeof owner.pid === "number" &&
    typeof owner.hostname === "string" &&
    typeof owner.acquiredAt === "string" &&
    typeof owner.updatedAt === "string" &&
    typeof owner.expiresAt === "string" &&
    Number.isFinite(Date.parse(owner.expiresAt))
  );
}

async function readOwner(directory: string): Promise<TargetLeaseOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(directory, OWNER_FILE), "utf8"));
    return validOwner(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function atomicOwner(directory: string, owner: TargetLeaseOwner): Promise<void> {
  const temporary = path.join(directory, `.${OWNER_FILE}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(owner, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path.join(directory, OWNER_FILE));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function staleLease(
  directory: string,
  owner: TargetLeaseOwner | undefined,
  now: Date,
  options: TargetLeaseOptions,
): Promise<boolean> {
  if (owner !== undefined) {
    if (Date.parse(owner.expiresAt) <= now.getTime()) return true;
    const localHostname = options.hostname ?? hostname();
    const alive = options.processAlive ?? processAlive;
    return owner.hostname === localHostname && !alive(owner.pid);
  }
  const metadata = await stat(directory).catch(() => undefined);
  return (
    metadata !== undefined && now.getTime() - metadata.mtimeMs >= (options.ttlMs ?? DEFAULT_TTL_MS)
  );
}

export async function acquireTargetLease(
  request: TargetLeaseRequest,
  options: TargetLeaseOptions = {},
): Promise<TargetLeaseResult> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const heartbeatMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000) {
    throw new RangeError("target lease ttlMs must be at least 1000");
  }
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 0 || heartbeatMs >= ttlMs) {
    throw new RangeError(
      "target lease heartbeatIntervalMs must be non-negative and less than ttlMs",
    );
  }
  const root = leaseDirectory(options);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(path.resolve(request.projectRoot)).catch(() =>
    path.resolve(request.projectRoot),
  );
  const targetFingerprint = fingerprint(request.targetIdentity);
  const projectFingerprint = fingerprint(
    `root:${process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot}`,
  );
  const directory = path.join(root, targetFingerprint.replace(":", "-"));
  const clock = options.clock ?? (() => new Date());

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = clock();
    try {
      await mkdir(directory, { mode: 0o700 });
      const owner: TargetLeaseOwner = {
        schemaVersion: 1,
        leaseId: randomUUID(),
        targetFingerprint,
        projectFingerprint,
        purpose: request.purpose.slice(0, 128),
        pid: options.pid ?? process.pid,
        hostname: options.hostname ?? hostname(),
        acquiredAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      };
      try {
        await atomicOwner(directory, owner);
      } catch {
        await rm(directory, { force: true, recursive: true }).catch(() => undefined);
        throw new Error("owner write failed");
      }

      let activeOwner = owner;
      let released = false;
      const heartbeat = async (): Promise<void> => {
        if (released) return;
        const current = await readOwner(directory);
        if (current?.leaseId !== owner.leaseId) return;
        const heartbeatAt = clock();
        activeOwner = {
          ...current,
          updatedAt: heartbeatAt.toISOString(),
          expiresAt: new Date(heartbeatAt.getTime() + ttlMs).toISOString(),
        };
        await atomicOwner(directory, activeOwner).catch(() => undefined);
      };
      const timer =
        heartbeatMs === 0
          ? undefined
          : setInterval(() => {
              void heartbeat();
            }, heartbeatMs);
      timer?.unref?.();
      return {
        ok: true,
        lease: {
          get owner() {
            return activeOwner;
          },
          async release(): Promise<boolean> {
            if (released) return true;
            released = true;
            if (timer !== undefined) clearInterval(timer);
            const current = await readOwner(directory);
            if (current?.leaseId !== owner.leaseId) return false;
            await rm(directory, { force: true, recursive: true });
            return true;
          },
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return {
          ok: false,
          code: "TARGET_LEASE_UNAVAILABLE",
          message: "ADB Ready could not create the target ownership lease.",
        };
      }
    }

    const owner = await readOwner(directory);
    if (!(await staleLease(directory, owner, now, options))) {
      return {
        ok: false,
        code: "TARGET_BUSY",
        message:
          owner === undefined
            ? "The selected Android target is being acquired by another process."
            : `The selected Android target is already owned for ${owner.purpose}.`,
        ...(owner === undefined ? {} : { owner }),
      };
    }
    const quarantine = `${directory}.stale-${randomUUID()}`;
    try {
      await rename(directory, quarantine);
      await rm(quarantine, { force: true, recursive: true });
    } catch {}
  }
  return {
    ok: false,
    code: "TARGET_LEASE_UNAVAILABLE",
    message: "ADB Ready could not safely recover the stale target lease.",
  };
}
