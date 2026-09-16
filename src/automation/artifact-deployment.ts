import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parsePackageInfo, parseResolvedActivity } from "../app/android-app.js";
import type { ProcessResult, ProcessRunner } from "../platform/process-runner.js";
import { runProcess } from "../platform/process-runner.js";
import type { AndroidArtifact } from "./artifact-resolution.js";

const TOOL_TIMEOUT_MS = 10 * 60 * 1_000;
const VERIFY_TIMEOUT_MS = 10_000;
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u;

export type ArtifactDeploymentFailureCode =
  | "DEPLOYMENT_BUILD_FAILED"
  | "DEPLOYMENT_CLEANUP_FAILED"
  | "DEPLOYMENT_IDENTITY_CONFLICT"
  | "DEPLOYMENT_IDENTITY_REQUIRED"
  | "DEPLOYMENT_INSTALL_FAILED"
  | "DEPLOYMENT_INVALID_INPUT"
  | "DEPLOYMENT_TOOL_REQUIRED"
  | "DEPLOYMENT_VERIFICATION_FAILED";

export interface ArtifactDeploymentFailure {
  code: ArtifactDeploymentFailureCode;
  summary: string;
  detail: string;
  next: string;
  stage: "build" | "cleanup" | "identity" | "install" | "input" | "verify";
}

export interface ArtifactDeployment {
  artifactKind: AndroidArtifact["kind"];
  applicationId: string;
  serial: string;
  installed: true;
  launchable: true;
  activity: string;
  versionCode?: number;
  versionName?: string;
  temporaryApkSetCreated: boolean;
  temporaryApkSetCleaned: boolean;
}

export type ArtifactDeploymentResult =
  | { ok: true; deployment: ArtifactDeployment }
  | { ok: false; failure: ArtifactDeploymentFailure };

export interface DeployAndroidArtifactOptions {
  artifact: AndroidArtifact;
  serial: string;
  adb: string;
  applicationId?: string;
  java?: string;
  bundletool?: string;
  replace?: boolean;
  grantRuntimePermissions?: boolean;
  signal?: AbortSignal;
}

export interface ArtifactDeploymentDependencies {
  runner?: ProcessRunner;
  makeTemporaryDirectory?: () => Promise<string>;
  removeTemporaryDirectory?: (directory: string) => Promise<void>;
}

function failed(
  code: ArtifactDeploymentFailureCode,
  stage: ArtifactDeploymentFailure["stage"],
  summary: string,
  detail: string,
  next: string,
): { ok: false; failure: ArtifactDeploymentFailure } {
  return { ok: false, failure: { code, stage, summary, detail, next } };
}

function succeeded(process: ProcessResult): boolean {
  return (
    process.spawnError === undefined &&
    process.streamError === undefined &&
    process.exitCode === 0 &&
    !process.timedOut &&
    !process.aborted
  );
}

function processDetail(process: ProcessResult): string {
  if (process.aborted) return "The operation was cancelled.";
  if (process.timedOut) return "The operation exceeded its bounded timeout.";
  if (process.spawnError !== undefined) return process.spawnError.message;
  if (process.streamError !== undefined) return process.streamError.message;
  const output = process.stderr.trim() || process.stdout.trim();
  return output === ""
    ? `The process exited with code ${String(process.exitCode)}.`
    : output.slice(0, 2_000);
}

async function run(
  runner: ProcessRunner,
  executable: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<ProcessResult> {
  const startedAt = new Date().toISOString();
  try {
    return await runner({
      executable,
      args,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs,
      maxBufferBytes: 4 * 1024 * 1024,
    });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    return {
      executable,
      args: [...args],
      startedAt,
      finishedAt,
      durationMs: 0,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
      stoppedAfterIdle: false,
      killEscalated: false,
      spawnError: { message: error instanceof Error ? error.message : String(error) },
    };
  }
}

function validCommandValue(value: string): boolean {
  return (
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 4_096 &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
  );
}

function parseManifestPackage(output: string): string | undefined {
  const trimmed = output.trim().replace(/^['"]|['"]$/gu, "");
  if (PACKAGE_PATTERN.test(trimmed)) return trimmed;
  const captured = output.match(/\bpackage=["']([^"']+)["']/u)?.[1];
  return captured !== undefined && PACKAGE_PATTERN.test(captured) ? captured : undefined;
}

function validArtifactShape(artifact: AndroidArtifact): boolean {
  const extensions = artifact.files.map((file) => path.extname(file).toLowerCase());
  if (new Set(artifact.files).size !== artifact.files.length) return false;
  if (artifact.kind === "apk") return artifact.files.length === 1 && extensions[0] === ".apk";
  if (artifact.kind === "split-apks")
    return artifact.files.length > 1 && extensions.every((extension) => extension === ".apk");
  if (artifact.kind === "aab") return artifact.files.length === 1 && extensions[0] === ".aab";
  return artifact.files.length === 1 && extensions[0] === ".apks";
}

function bundletoolArguments(bundletool: string, command: string, args: string[]): string[] {
  return ["-jar", bundletool, command, ...args];
}

async function resolveApplicationId(
  options: DeployAndroidArtifactOptions,
  runner: ProcessRunner,
): Promise<
  { ok: false; failure: ArtifactDeploymentFailure } | { ok: true; applicationId: string }
> {
  if (
    options.applicationId !== undefined &&
    options.artifact.applicationId !== undefined &&
    options.applicationId !== options.artifact.applicationId
  )
    return failed(
      "DEPLOYMENT_IDENTITY_CONFLICT",
      "identity",
      "The explicit application ID conflicts with artifact metadata.",
      `${options.applicationId} != ${options.artifact.applicationId}`,
      "Use the application ID declared by the selected artifact.",
    );
  const expected = options.applicationId ?? options.artifact.applicationId;
  if (options.artifact.kind !== "aab") {
    return expected === undefined || !PACKAGE_PATTERN.test(expected)
      ? failed(
          "DEPLOYMENT_IDENTITY_REQUIRED",
          "identity",
          "The artifact has no verified application ID.",
          "APK and APK Set deployment cannot prove which package to verify.",
          "Pass the application ID explicitly or use artifact metadata that declares it.",
        )
      : { ok: true, applicationId: expected };
  }
  if (options.java === undefined || options.bundletool === undefined)
    return failed(
      "DEPLOYMENT_TOOL_REQUIRED",
      "identity",
      "AAB inspection requires Java and bundletool.",
      "The application identity must be read before any device mutation.",
      "Provide supported explicit Java and bundletool paths.",
    );
  const dump = await run(
    runner,
    options.java,
    bundletoolArguments(options.bundletool, "dump", [
      "manifest",
      `--bundle=${options.artifact.files[0] ?? ""}`,
      "--module=base",
      "--xpath=/manifest/@package",
    ]),
    options.signal,
    TOOL_TIMEOUT_MS,
  );
  const observed = succeeded(dump) ? parseManifestPackage(dump.stdout) : undefined;
  if (observed === undefined)
    return failed(
      "DEPLOYMENT_BUILD_FAILED",
      "identity",
      "The AAB application ID could not be read.",
      processDetail(dump),
      "Verify the bundle with bundletool dump manifest and rebuild it if necessary.",
    );
  if (expected !== undefined && observed !== expected)
    return failed(
      "DEPLOYMENT_IDENTITY_CONFLICT",
      "identity",
      "The expected application ID does not match the AAB.",
      `${expected} != ${observed}`,
      "Use the application ID declared by the selected bundle.",
    );
  return { ok: true, applicationId: observed };
}

async function verifyDeployment(
  options: DeployAndroidArtifactOptions,
  applicationId: string,
  runner: ProcessRunner,
  temporaryApkSetCreated: boolean,
  temporaryApkSetCleaned: boolean,
): Promise<ArtifactDeploymentResult> {
  const info = await run(
    runner,
    options.adb,
    ["-s", options.serial, "shell", "dumpsys", "package", applicationId],
    options.signal,
    VERIFY_TIMEOUT_MS,
  );
  const observed = parsePackageInfo(applicationId, info.stdout);
  if (!succeeded(info) || !observed.installed)
    return failed(
      "DEPLOYMENT_VERIFICATION_FAILED",
      "verify",
      "The installed package could not be verified.",
      processDetail(info),
      `Inspect ${applicationId} on ${options.serial} and retry the deployment.`,
    );
  if (
    options.artifact.versionCode !== undefined &&
    observed.versionCode !== options.artifact.versionCode
  )
    return failed(
      "DEPLOYMENT_VERIFICATION_FAILED",
      "verify",
      "The installed version code does not match the artifact.",
      `${String(observed.versionCode)} != ${String(options.artifact.versionCode)}`,
      "Remove stale build outputs, rebuild the intended variant, and retry.",
    );
  if (
    options.artifact.versionName !== undefined &&
    observed.versionName !== options.artifact.versionName
  )
    return failed(
      "DEPLOYMENT_VERIFICATION_FAILED",
      "verify",
      "The installed version name does not match the artifact.",
      `${String(observed.versionName)} != ${options.artifact.versionName}`,
      "Remove stale build outputs, rebuild the intended variant, and retry.",
    );
  const activity = await run(
    runner,
    options.adb,
    ["-s", options.serial, "shell", "cmd", "package", "resolve-activity", "--brief", applicationId],
    options.signal,
    VERIFY_TIMEOUT_MS,
  );
  const resolved = succeeded(activity) ? parseResolvedActivity(activity.stdout) : undefined;
  if (resolved?.applicationId !== applicationId)
    return failed(
      "DEPLOYMENT_VERIFICATION_FAILED",
      "verify",
      "The installed package has no verified launch activity.",
      processDetail(activity),
      "Confirm that the selected application variant is launchable on Android.",
    );
  return {
    ok: true,
    deployment: {
      artifactKind: options.artifact.kind,
      applicationId,
      serial: options.serial,
      installed: true,
      launchable: true,
      activity: resolved.activity,
      ...(observed.versionCode === undefined ? {} : { versionCode: observed.versionCode }),
      ...(observed.versionName === undefined ? {} : { versionName: observed.versionName }),
      temporaryApkSetCreated,
      temporaryApkSetCleaned,
    },
  };
}

export async function deployAndroidArtifact(
  options: DeployAndroidArtifactOptions,
  dependencies: ArtifactDeploymentDependencies = {},
): Promise<ArtifactDeploymentResult> {
  if (
    !validCommandValue(options.serial) ||
    /\s/u.test(options.serial) ||
    !validCommandValue(options.adb) ||
    !validArtifactShape(options.artifact) ||
    options.artifact.files.some((file) => !validCommandValue(file))
  )
    return failed(
      "DEPLOYMENT_INVALID_INPUT",
      "input",
      "The deployment target or artifact input is invalid.",
      "Serials, executable paths, and artifact paths must be explicit printable values.",
      "Resolve one target and one validated project-local artifact before deployment.",
    );
  const bundleDeployment = options.artifact.kind === "aab" || options.artifact.kind === "apks";
  if (bundleDeployment && (options.java === undefined || options.bundletool === undefined))
    return failed(
      "DEPLOYMENT_TOOL_REQUIRED",
      "input",
      "Bundle deployment requires Java and bundletool.",
      "No implicit download or SDK mutation is allowed.",
      "Provide supported explicit Java and bundletool paths.",
    );
  if (
    bundleDeployment &&
    options.java !== undefined &&
    options.bundletool !== undefined &&
    (!validCommandValue(options.java) || !validCommandValue(options.bundletool))
  )
    return failed(
      "DEPLOYMENT_INVALID_INPUT",
      "input",
      "The Java or bundletool path is invalid.",
      "Tool paths must be explicit printable values.",
      "Provide the supported Java executable and bundletool JAR paths reported by doctor.",
    );
  if (bundleDeployment && options.grantRuntimePermissions === true)
    return failed(
      "DEPLOYMENT_INVALID_INPUT",
      "input",
      "Grant-all runtime permissions is unavailable for bundletool deployment.",
      "bundletool install-apks does not expose the same verified -g contract as ADB install.",
      "Remove the option or deploy an explicit APK artifact.",
    );
  if (bundleDeployment && options.replace === false)
    return failed(
      "DEPLOYMENT_INVALID_INPUT",
      "input",
      "No-replace installation is unavailable for bundletool deployment.",
      "bundletool install-apks does not expose the same verified no-replace contract as ADB install.",
      "Remove the option or deploy an explicit APK artifact.",
    );
  const runner = dependencies.runner ?? runProcess;
  const identity = await resolveApplicationId(options, runner);
  if (!identity.ok) return identity;

  if (options.artifact.kind === "apk" || options.artifact.kind === "split-apks") {
    const install = await run(
      runner,
      options.adb,
      [
        "-s",
        options.serial,
        options.artifact.kind === "apk" ? "install" : "install-multiple",
        ...(options.replace === false ? [] : ["-r"]),
        ...(options.grantRuntimePermissions === true ? ["-g"] : []),
        ...options.artifact.files,
      ],
      options.signal,
      TOOL_TIMEOUT_MS,
    );
    if (!succeeded(install))
      return failed(
        "DEPLOYMENT_INSTALL_FAILED",
        "install",
        "ADB could not install the selected artifact.",
        processDetail(install),
        `Run the target-scoped ADB install against ${options.serial} and resolve its error.`,
      );
    return await verifyDeployment(options, identity.applicationId, runner, false, false);
  }

  if (options.java === undefined || options.bundletool === undefined)
    throw new Error("Bundle deployment tools passed preflight but became unavailable");

  const removeTemporaryDirectory =
    dependencies.removeTemporaryDirectory ??
    (async (directory: string) => await rm(directory, { recursive: true, force: true }));
  let temporaryDirectory: string | undefined;
  let apkSet = options.artifact.files[0];
  let outcome: ArtifactDeploymentResult | undefined;
  try {
    if (options.artifact.kind === "aab") {
      temporaryDirectory = await (
        dependencies.makeTemporaryDirectory ??
        (async () => await mkdtemp(path.join(tmpdir(), "adb-ready-bundletool-")))
      )();
      apkSet = path.join(temporaryDirectory, "device.apks");
      const build = await run(
        runner,
        options.java,
        bundletoolArguments(options.bundletool, "build-apks", [
          `--bundle=${options.artifact.files[0] ?? ""}`,
          `--output=${apkSet}`,
          "--connected-device",
          `--device-id=${options.serial}`,
          `--adb=${options.adb}`,
        ]),
        options.signal,
        TOOL_TIMEOUT_MS,
      );
      if (!succeeded(build))
        outcome = failed(
          "DEPLOYMENT_BUILD_FAILED",
          "build",
          "bundletool could not build a device-specific APK Set.",
          processDetail(build),
          "Inspect the AAB, target compatibility, Java, and bundletool diagnostics.",
        );
    }
    if (outcome === undefined) {
      const install = await run(
        runner,
        options.java,
        bundletoolArguments(options.bundletool, "install-apks", [
          `--apks=${apkSet ?? ""}`,
          `--device-id=${options.serial}`,
          `--adb=${options.adb}`,
        ]),
        options.signal,
        TOOL_TIMEOUT_MS,
      );
      outcome = succeeded(install)
        ? await verifyDeployment(
            options,
            identity.applicationId,
            runner,
            temporaryDirectory !== undefined,
            false,
          )
        : failed(
            "DEPLOYMENT_INSTALL_FAILED",
            "install",
            "bundletool could not install the APK Set.",
            processDetail(install),
            `Inspect APK Set compatibility with ${options.serial} and retry.`,
          );
    }
  } catch (error) {
    outcome = failed(
      "DEPLOYMENT_BUILD_FAILED",
      "build",
      "Bundle deployment could not be completed.",
      error instanceof Error ? error.message : String(error),
      "Verify the explicit tool paths, temporary directory, and artifact permissions.",
    );
  }
  if (temporaryDirectory !== undefined) {
    try {
      await removeTemporaryDirectory(temporaryDirectory);
    } catch (error) {
      return failed(
        "DEPLOYMENT_CLEANUP_FAILED",
        "cleanup",
        "The owned temporary APK Set could not be removed.",
        error instanceof Error ? error.message : String(error),
        `Remove the owned temporary directory manually: ${temporaryDirectory}`,
      );
    }
    if (outcome?.ok === true) outcome.deployment.temporaryApkSetCleaned = true;
  }
  return (
    outcome ??
    failed(
      "DEPLOYMENT_BUILD_FAILED",
      "build",
      "Bundle deployment ended without an outcome.",
      "No deployment stage produced a result.",
      "Retry and capture verbose diagnostics.",
    )
  );
}
