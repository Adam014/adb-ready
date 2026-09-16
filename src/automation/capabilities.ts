import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { locateExecutable } from "../platform/executable.js";
import { type ProcessRunner, runProcess } from "../platform/process-runner.js";

export type CapabilityStatus = "incompatible" | "supported" | "unavailable" | "unverified";

export type AndroidToolId =
  | "android-cli"
  | "avdmanager"
  | "bundletool"
  | "emulator"
  | "external-verifier"
  | "gradle"
  | "java";

export type CapabilitySource = "explicit" | "path" | "project" | "sdk";

export interface ToolInvocation {
  executable: string;
  argsPrefix: string[];
  cwd?: string;
}

export interface AndroidToolCapability {
  id: AndroidToolId;
  status: CapabilityStatus;
  source?: CapabilitySource;
  path?: string;
  version?: string;
  detail: string;
  next?: string;
  invocation?: ToolInvocation;
}

export interface AndroidCapabilities {
  sdk: {
    status: CapabilityStatus;
    root?: string;
    candidates: string[];
    detail: string;
    next?: string;
  };
  tools: AndroidToolCapability[];
}

export interface DetectAndroidCapabilitiesOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  runner?: ProcessRunner;
  timeoutMs?: number;
  explicit?: Partial<Record<Exclude<AndroidToolId, "external-verifier">, string>>;
  verifier?: { executable: string; args?: readonly string[]; cwd?: string };
}

const PROBE_TIMEOUT_MS = 3_000;

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

async function regularFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function executableFile(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function defaultSdkRoot(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): string | undefined {
  const paths = pathApi(platform);
  if (platform === "darwin") return paths.join(homeDirectory, "Library", "Android", "sdk");
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    return localAppData === undefined || localAppData === ""
      ? undefined
      : paths.join(localAppData, "Android", "Sdk");
  }
  return paths.join(homeDirectory, "Android", "Sdk");
}

async function resolveSdk(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): Promise<AndroidCapabilities["sdk"]> {
  const paths = pathApi(platform);
  const environmentRoots = unique(
    [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]
      .filter((value): value is string => value !== undefined)
      .map((value) => paths.resolve(value)),
  );
  const fallback = defaultSdkRoot(platform, env, homeDirectory);
  const candidates = unique([
    ...environmentRoots,
    ...(fallback === undefined ? [] : [paths.resolve(fallback)]),
  ]);

  if (environmentRoots.length > 1) {
    return {
      status: "incompatible",
      candidates,
      detail: "ANDROID_HOME and ANDROID_SDK_ROOT resolve to different SDK directories.",
      next: "Keep one canonical Android SDK root, or make both variables resolve to the same directory.",
    };
  }

  const selected = environmentRoots[0] ?? fallback;
  if (
    selected === undefined ||
    !(await stat(selected)
      .then((value) => value.isDirectory())
      .catch(() => false))
  ) {
    return {
      status: "unavailable",
      candidates,
      detail: "No Android SDK directory was found at a deterministic location.",
      next: "Set ANDROID_HOME to the Android SDK directory.",
    };
  }
  return {
    status: "supported",
    root: paths.resolve(selected),
    candidates,
    detail: "One Android SDK directory was selected deterministically.",
  };
}

function executableName(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${name}.exe` : name;
}

async function resolveExecutable(
  id: Exclude<AndroidToolId, "external-verifier">,
  name: string,
  options: DetectAndroidCapabilitiesOptions,
  sdkRoot: string | undefined,
  sdkRelative?: readonly string[],
): Promise<{ path: string; source: CapabilitySource } | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const paths = pathApi(platform);
  const explicit = options.explicit?.[id]?.trim();
  if (explicit !== undefined && explicit !== "") {
    const candidate = paths.resolve(options.cwd ?? process.cwd(), explicit);
    return (await executableFile(candidate, platform))
      ? { path: candidate, source: "explicit" }
      : undefined;
  }

  if (sdkRoot !== undefined && sdkRelative !== undefined) {
    const candidate = paths.join(sdkRoot, ...sdkRelative, executableName(name, platform));
    if (await executableFile(candidate, platform)) return { path: candidate, source: "sdk" };
  }

  const located = await locateExecutable(name, { env, platform });
  return located === undefined ? undefined : { path: located, source: "path" };
}

function parseVersion(id: AndroidToolId, output: string): string | undefined {
  const patterns: Partial<Record<AndroidToolId, RegExp>> = {
    "android-cli": /(?:android(?: cli)?\s+)?v?(\d+(?:\.\d+)+)/iu,
    bundletool: /(?:bundletool\s+)?(?:version:\s*)?(\d+(?:\.\d+)+)/iu,
    emulator: /Android emulator version\s+(\d+(?:\.\d+)+)/iu,
    gradle: /Gradle\s+(\d+(?:\.\d+)+)/u,
    java: /version\s+"?(\d+(?:\.\d+)*)/iu,
  };
  return patterns[id]?.exec(output)?.[1];
}

function majorVersion(id: AndroidToolId, version: string): number | undefined {
  const parts = version.split(".");
  const first = Number(parts[0]);
  const major = id === "java" && first === 1 && parts[1] !== undefined ? Number(parts[1]) : first;
  return Number.isSafeInteger(major) ? major : undefined;
}

async function probe(
  id: AndroidToolId,
  resolved: { path: string; source: CapabilitySource },
  args: readonly string[],
  options: DetectAndroidCapabilitiesOptions,
  minimumMajor?: number,
): Promise<AndroidToolCapability> {
  const runner = options.runner ?? runProcess;
  const result = await runner({
    executable: resolved.path,
    args,
    timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    inheritEnv: true,
  });
  const invocation = { executable: resolved.path, argsPrefix: [] };
  if (
    result.spawnError !== undefined ||
    result.timedOut ||
    result.aborted ||
    result.exitCode !== 0
  ) {
    return {
      id,
      status: "unverified",
      source: resolved.source,
      path: resolved.path,
      detail: `${id} was found, but its version probe did not complete successfully.`,
      next: `Run ${resolved.path} ${args.join(" ")} and repair the installation before using it in an autonomous run.`,
      invocation,
    };
  }
  const version = parseVersion(id, `${result.stdout}\n${result.stderr}`);
  if (version === undefined) {
    return {
      id,
      status: "unverified",
      source: resolved.source,
      path: resolved.path,
      detail: `${id} responded, but ADB Ready could not verify its version.`,
      next: "Use a current stable tool release or provide an explicit verified path.",
      invocation,
    };
  }
  if (minimumMajor !== undefined && (majorVersion(id, version) ?? 0) < minimumMajor) {
    return {
      id,
      status: "incompatible",
      source: resolved.source,
      path: resolved.path,
      version,
      detail: `${id} ${version} does not provide the command contract required by ADB Ready.`,
      next: `Upgrade ${id} to major version ${String(minimumMajor)} or newer.`,
      invocation,
    };
  }
  return {
    id,
    status: "supported",
    source: resolved.source,
    path: resolved.path,
    version,
    detail: `${id} ${version} is available.`,
    invocation,
  };
}

function unavailable(id: AndroidToolId, next: string): AndroidToolCapability {
  return { id, status: "unavailable", detail: `${id} was not found.`, next };
}

async function resolveGradle(
  options: DetectAndroidCapabilitiesOptions,
): Promise<AndroidToolCapability> {
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const paths = pathApi(platform);
  const properties = paths.join(cwd, "gradle", "wrapper", "gradle-wrapper.properties");
  if (await regularFile(properties)) {
    const contents = await readFile(properties, "utf8").catch(() => "");
    const version = /gradle-(\d+(?:\.\d+){1,2})-(?:all|bin)\.zip/u.exec(contents)?.[1];
    const wrapper = paths.join(cwd, platform === "win32" ? "gradlew.bat" : "gradlew");
    const wrapperAvailable =
      platform === "win32" ? await regularFile(wrapper) : await executableFile(wrapper, platform);
    if (!wrapperAvailable) {
      return {
        id: "gradle",
        status: "unverified",
        source: "project",
        path: wrapper,
        ...(version === undefined ? {} : { version }),
        detail: "Gradle wrapper metadata exists, but its platform launcher is missing or unusable.",
        next: "Restore the Gradle wrapper launcher and keep it executable.",
      };
    }
    return {
      id: "gradle",
      status: version === undefined ? "unverified" : "supported",
      source: "project",
      path: wrapper,
      ...(version === undefined ? {} : { version }),
      detail:
        version === undefined
          ? "A Gradle wrapper is present, but its pinned distribution version is not recognizable."
          : `The project pins Gradle ${version} through its wrapper.`,
      ...(version === undefined
        ? { next: "Repair gradle-wrapper.properties before using Gradle as a verifier." }
        : {}),
      invocation: { executable: wrapper, argsPrefix: [], cwd },
    };
  }
  const resolved = await resolveExecutable("gradle", "gradle", options, undefined);
  return resolved === undefined
    ? unavailable("gradle", "Add a Gradle wrapper to the project or install Gradle on PATH.")
    : await probe("gradle", resolved, ["--version"], options);
}

async function resolveBundletool(
  options: DetectAndroidCapabilitiesOptions,
  java: AndroidToolCapability,
): Promise<AndroidToolCapability> {
  const explicit = options.explicit?.bundletool?.trim();
  if (explicit !== undefined && explicit !== "" && explicit.toLowerCase().endsWith(".jar")) {
    const candidate = pathApi(options.platform ?? process.platform).resolve(
      options.cwd ?? process.cwd(),
      explicit,
    );
    if (!(await regularFile(candidate))) {
      return unavailable(
        "bundletool",
        "Provide an existing bundletool-all JAR with --bundletool PATH.",
      );
    }
    if (java.status !== "supported" || java.invocation === undefined) {
      return {
        id: "bundletool",
        status: "incompatible",
        source: "explicit",
        path: candidate,
        detail:
          "The bundletool JAR is present, but a verified compatible Java runtime is not available.",
        next: "Install Java 8 or newer, then retry with the same bundletool JAR.",
      };
    }
    const resolved = { path: java.invocation.executable, source: "explicit" as const };
    const capability = await probe("bundletool", resolved, ["-jar", candidate, "version"], options);
    return {
      ...capability,
      path: candidate,
      invocation: { executable: java.invocation.executable, argsPrefix: ["-jar", candidate] },
    };
  }
  const resolved = await resolveExecutable("bundletool", "bundletool", options, undefined);
  return resolved === undefined
    ? unavailable(
        "bundletool",
        "Provide a verified bundletool executable or bundletool-all JAR explicitly.",
      )
    : await probe("bundletool", resolved, ["version"], options);
}

async function resolveVerifier(
  options: DetectAndroidCapabilitiesOptions,
): Promise<AndroidToolCapability> {
  if (options.verifier === undefined) {
    return {
      id: "external-verifier",
      status: "unverified",
      detail: "No external verifier command was requested.",
      next: "Pass a verifier after -- when planning an autonomous run.",
    };
  }
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const paths = pathApi(platform);
  const requested = options.verifier.executable;
  const hasPath =
    paths.isAbsolute(requested) || requested.includes("/") || requested.includes("\\");
  const resolved = hasPath
    ? paths.resolve(options.verifier.cwd ?? options.cwd ?? process.cwd(), requested)
    : await locateExecutable(requested, { env, platform });
  if (resolved === undefined || !(await executableFile(resolved, platform))) {
    return unavailable(
      "external-verifier",
      `Install ${requested} or pass an executable path that exists.`,
    );
  }
  return {
    id: "external-verifier",
    status: "supported",
    source: hasPath ? "explicit" : "path",
    path: resolved,
    detail: "The requested external verifier can be started directly without a shell.",
    invocation: {
      executable: resolved,
      argsPrefix: [...(options.verifier.args ?? [])],
      ...(options.verifier.cwd === undefined ? {} : { cwd: options.verifier.cwd }),
    },
  };
}

export async function detectAndroidCapabilities(
  options: DetectAndroidCapabilitiesOptions = {},
): Promise<AndroidCapabilities> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const sdk = await resolveSdk(platform, env, homeDirectory);
  const sdkRoot = sdk.status === "supported" ? sdk.root : undefined;

  const emulatorResolved = await resolveExecutable("emulator", "emulator", options, sdkRoot, [
    "emulator",
  ]);
  const androidResolved = await resolveExecutable("android-cli", "android", options, undefined);
  const javaResolved = await resolveExecutable("java", "java", options, undefined);
  const avdmanagerResolved = await resolveExecutable("avdmanager", "avdmanager", options, sdkRoot, [
    "cmdline-tools",
    "latest",
    "bin",
  ]);

  const [emulator, androidCli, java, gradle, verifier] = await Promise.all([
    emulatorResolved === undefined
      ? unavailable("emulator", "Install the Android Emulator package in the selected SDK.")
      : probe("emulator", emulatorResolved, ["-version"], options),
    androidResolved === undefined
      ? unavailable(
          "android-cli",
          "Install Google Android CLI only if its optional adapter is desired.",
        )
      : probe("android-cli", androidResolved, ["--version"], options, 1),
    javaResolved === undefined
      ? unavailable(
          "java",
          "Install Java 8 or newer when bundletool or Gradle verification is required.",
        )
      : probe("java", javaResolved, ["-version"], options, 8),
    resolveGradle(options),
    resolveVerifier(options),
  ]);
  const avdmanager: AndroidToolCapability =
    avdmanagerResolved === undefined
      ? unavailable(
          "avdmanager",
          "Install Android SDK Command-line Tools if AVD inspection is required.",
        )
      : {
          id: "avdmanager",
          status: "supported",
          source: avdmanagerResolved.source,
          path: avdmanagerResolved.path,
          detail: "avdmanager is available for read-only AVD metadata inspection.",
          invocation: { executable: avdmanagerResolved.path, argsPrefix: [] },
        };
  const bundletool = await resolveBundletool(options, java);

  return {
    sdk,
    tools: [emulator, avdmanager, bundletool, java, gradle, androidCli, verifier],
  };
}

export function capability(
  capabilities: AndroidCapabilities,
  id: AndroidToolId,
): AndroidToolCapability {
  const found = capabilities.tools.find((item) => item.id === id);
  if (found === undefined) throw new Error(`Missing capability descriptor: ${id}`);
  return found;
}
