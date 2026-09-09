import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

export interface ExecutableSearchOptions {
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

async function isExecutable(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const value = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return value
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
}

function candidateNames(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (platform !== "win32" || pathApi.extname(name) !== "") {
    return [name];
  }
  return [name, ...windowsExtensions(env).map((extension) => `${name}${extension}`)];
}

async function resolveFromPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const pathValue = env.PATH ?? env.Path ?? env.path;
  if (pathValue === undefined) {
    return undefined;
  }

  const delimiter = platform === "win32" ? ";" : ":";
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  for (const directory of pathValue.split(delimiter)) {
    if (directory.trim() === "") {
      continue;
    }
    for (const candidateName of candidateNames(name, platform, env)) {
      const candidate = pathApi.resolve(directory.replace(/^"|"$/g, ""), candidateName);
      if (await isExecutable(candidate, platform)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function sdkCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDirectory: string,
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const executable = platform === "win32" ? "adb.exe" : "adb";
  const roots = [env.ANDROID_SDK_ROOT, env.ANDROID_HOME].filter(
    (value): value is string => value !== undefined && value.trim() !== "",
  );

  if (platform === "darwin") {
    roots.push(pathApi.join(homeDirectory, "Library", "Android", "sdk"));
  } else if (platform === "win32") {
    if (env.LOCALAPPDATA !== undefined) {
      roots.push(pathApi.join(env.LOCALAPPDATA, "Android", "Sdk"));
    }
  } else {
    roots.push(pathApi.join(homeDirectory, "Android", "Sdk"));
  }

  return [...new Set(roots.map((root) => pathApi.join(root, "platform-tools", executable)))];
}

export async function locateAdb(
  options: ExecutableSearchOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;

  if (options.explicitPath !== undefined) {
    const explicit = options.explicitPath.trim();
    if (explicit === "") {
      return undefined;
    }
    if (pathApi.isAbsolute(explicit) || explicit.includes("/") || explicit.includes("\\")) {
      const candidate = pathApi.resolve(explicit);
      return (await isExecutable(candidate, platform)) ? candidate : undefined;
    }
    return await resolveFromPath(explicit, env, platform);
  }

  const fromPath = await resolveFromPath("adb", env, platform);
  if (fromPath !== undefined) {
    return fromPath;
  }

  for (const candidate of sdkCandidates(env, platform, options.homeDirectory ?? homedir())) {
    if (await isExecutable(candidate, platform)) {
      return candidate;
    }
  }

  return undefined;
}
