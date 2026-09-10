import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";

export interface EvidenceDestination {
  root: string;
  finalPath: string;
  relativePath: string;
  temporaryPath: string;
}

export class EvidencePathError extends Error {
  readonly code: "EXISTS" | "OUTSIDE_ROOT" | "SYMLINK" | "UNSAFE_TYPE";

  constructor(code: EvidencePathError["code"], message: string) {
    super(message);
    this.name = "EvidencePathError";
    this.code = code;
  }
}

async function optionalLstat(file: string): Promise<Stats | undefined> {
  try {
    return await lstat(file);
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw caught;
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function createSafeParent(root: string, parent: string): Promise<void> {
  const relative = path.relative(root, parent);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const existing = await optionalLstat(current);
    if (existing?.isSymbolicLink()) {
      throw new EvidencePathError("SYMLINK", "Evidence output directories cannot be symlinks.");
    }
    if (existing !== undefined && !existing.isDirectory()) {
      throw new EvidencePathError("UNSAFE_TYPE", "An evidence output parent is not a directory.");
    }
    if (existing === undefined) await mkdir(current, { mode: 0o700 });
  }
}

export async function prepareEvidenceDestination(options: {
  root: string;
  requested?: string;
  defaultName: string;
  force?: boolean;
  nonce: string;
}): Promise<EvidenceDestination> {
  const root = await realpath(options.root);
  const requested = options.requested ?? path.join(".adb-ready", "evidence", options.defaultName);
  if (path.isAbsolute(requested)) {
    throw new EvidencePathError("OUTSIDE_ROOT", "Evidence output must be relative to the project.");
  }
  const finalPath = path.resolve(root, requested);
  if (!inside(root, finalPath)) {
    throw new EvidencePathError("OUTSIDE_ROOT", "Evidence output cannot leave the project root.");
  }
  const parent = path.dirname(finalPath);
  await createSafeParent(root, parent);
  const existing = await optionalLstat(finalPath);
  if (existing?.isSymbolicLink()) {
    throw new EvidencePathError("SYMLINK", "Evidence output cannot replace or follow a symlink.");
  }
  if (existing !== undefined && !existing.isFile()) {
    throw new EvidencePathError("UNSAFE_TYPE", "Evidence output can only replace a regular file.");
  }
  if (existing !== undefined && options.force !== true) {
    throw new EvidencePathError(
      "EXISTS",
      "Evidence output already exists; pass --force to replace it.",
    );
  }
  return {
    root,
    finalPath,
    relativePath: path.relative(root, finalPath).split(path.sep).join("/"),
    temporaryPath: path.join(parent, `.adb-ready-${options.nonce}.tmp`),
  };
}

export async function openEvidenceTemporary(destination: EvidenceDestination) {
  return await open(
    destination.temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
}

export async function commitEvidenceDestination(
  destination: EvidenceDestination,
  force: boolean,
): Promise<void> {
  if (force) {
    const existing = await optionalLstat(destination.finalPath);
    if (existing?.isSymbolicLink()) {
      throw new EvidencePathError("SYMLINK", "Evidence output changed into a symlink.");
    }
    await rename(destination.temporaryPath, destination.finalPath);
    return;
  }
  await link(destination.temporaryPath, destination.finalPath);
  await unlink(destination.temporaryPath);
}

export async function discardEvidenceDestination(destination: EvidenceDestination): Promise<void> {
  await rm(destination.temporaryPath, { force: true });
}
