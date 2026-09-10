import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { locateExecutable } from "../platform/executable.js";

export type PackageManagerName = "bun" | "npm" | "pnpm" | "yarn";
export type DevPreset = "custom" | "expo" | "gradle" | "react-native";

export interface PackageManagerResolution {
  name?: PackageManagerName;
  executable?: string;
  source?: "config" | "executable" | "lockfile" | "package-json";
  conflicts: PackageManagerName[];
}

export interface ProjectDetection {
  root: string;
  packageJson?: {
    path: string;
    name?: string;
    packageManager?: string;
    scripts: Record<string, string>;
  };
  preset?: DevPreset;
  presetEvidence: string[];
  packageManager: PackageManagerResolution;
}

export interface DetectProjectOptions {
  cwd: string;
  explicitPackageManager?: PackageManagerName;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fileExists?: (file: string) => Promise<boolean>;
  readText?: (file: string) => Promise<string>;
  locate?: (name: string) => Promise<string | undefined>;
}

const MANAGER_FIELD = /^(npm|pnpm|yarn|bun)@[^\s]+$/u;
const LOCKFILES: ReadonlyArray<readonly [string, PackageManagerName]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];
const FALLBACK_ORDER: readonly PackageManagerName[] = ["npm", "pnpm", "yarn", "bun"];

async function defaultFileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringRecord(value: unknown): Record<string, string> {
  const source = record(value);
  return source === undefined
    ? {}
    : Object.fromEntries(
        Object.entries(source).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
}

async function nearestProjectRoot(
  start: string,
  exists: (file: string) => Promise<boolean>,
): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    const markers = [
      "package.json",
      "gradlew",
      "gradlew.bat",
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
    ];
    if (
      (await Promise.all(markers.map((marker) => exists(path.join(current, marker))))).some(Boolean)
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

function managerFromField(value: string | undefined): PackageManagerName | undefined {
  return value?.match(MANAGER_FIELD)?.[1] as PackageManagerName | undefined;
}

export async function detectProject(options: DetectProjectOptions): Promise<ProjectDetection> {
  const exists = options.fileExists ?? defaultFileExists;
  const readText = options.readText ?? (async (file: string) => await readFile(file, "utf8"));
  const root = await nearestProjectRoot(options.cwd, exists);
  const packagePath = path.join(root, "package.json");
  let packageDocument: Record<string, unknown> | undefined;
  if (await exists(packagePath)) {
    try {
      packageDocument = record(JSON.parse(await readText(packagePath)));
    } catch {
      packageDocument = undefined;
    }
  }
  const dependencies = {
    ...stringRecord(packageDocument?.dependencies),
    ...stringRecord(packageDocument?.devDependencies),
  };
  const scripts = stringRecord(packageDocument?.scripts);
  const packageManagerField =
    typeof packageDocument?.packageManager === "string"
      ? packageDocument.packageManager
      : undefined;

  const presetEvidence: string[] = [];
  let preset: DevPreset | undefined;
  if (dependencies.expo !== undefined) {
    preset = "expo";
    presetEvidence.push("package.json dependency: expo");
  } else if (dependencies["react-native"] !== undefined) {
    preset = "react-native";
    presetEvidence.push("package.json dependency: react-native");
  } else if (
    (await exists(path.join(root, "gradlew"))) ||
    (await exists(path.join(root, "gradlew.bat"))) ||
    (await exists(path.join(root, "build.gradle"))) ||
    (await exists(path.join(root, "build.gradle.kts")))
  ) {
    preset = "gradle";
    presetEvidence.push("Gradle wrapper or build file");
  }

  const locate =
    options.locate ??
    (async (name: string) =>
      await locateExecutable(name, {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.platform === undefined ? {} : { platform: options.platform }),
      }));
  let packageManager: PackageManagerResolution = { conflicts: [] };
  const selectedFromField = managerFromField(packageManagerField);
  if (options.explicitPackageManager !== undefined) {
    packageManager = {
      name: options.explicitPackageManager,
      source: "config",
      conflicts: [],
      ...(await locate(options.explicitPackageManager).then((executable) =>
        executable === undefined ? {} : { executable },
      )),
    };
  } else if (selectedFromField !== undefined) {
    packageManager = {
      name: selectedFromField,
      source: "package-json",
      conflicts: [],
      ...(await locate(selectedFromField).then((executable) =>
        executable === undefined ? {} : { executable },
      )),
    };
  } else {
    const foundLockfiles = new Set<PackageManagerName>();
    for (const [filename, manager] of LOCKFILES) {
      if (await exists(path.join(root, filename))) foundLockfiles.add(manager);
    }
    if (foundLockfiles.size === 1) {
      const name = [...foundLockfiles][0];
      if (name !== undefined) {
        const executable = await locate(name);
        packageManager = {
          name,
          source: "lockfile",
          conflicts: [],
          ...(executable === undefined ? {} : { executable }),
        };
      }
    } else if (foundLockfiles.size > 1) {
      packageManager = { conflicts: [...foundLockfiles].sort() };
    } else {
      for (const name of FALLBACK_ORDER) {
        const executable = await locate(name);
        if (executable !== undefined) {
          packageManager = { name, executable, source: "executable", conflicts: [] };
          break;
        }
      }
    }
  }

  return {
    root,
    ...(packageDocument === undefined
      ? {}
      : {
          packageJson: {
            path: packagePath,
            ...(typeof packageDocument.name === "string" ? { name: packageDocument.name } : {}),
            ...(packageManagerField === undefined ? {} : { packageManager: packageManagerField }),
            scripts,
          },
        }),
    ...(preset === undefined ? {} : { preset }),
    presetEvidence,
    packageManager,
  };
}

export function packageScriptCommand(
  manager: PackageManagerName,
  executable: string,
  script: string,
  extraArgs: readonly string[] = [],
): { executable: string; args: string[] } {
  const separator = manager === "npm" && extraArgs.length > 0 ? ["--"] : [];
  return {
    executable,
    args: ["run", script, ...separator, ...extraArgs],
  };
}
