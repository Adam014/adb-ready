import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type ExternalVerifierAdapter = "android-cli" | "generic" | "maestro";
export type ExternalVerifierOutcome =
  | "assertion-failed"
  | "cancelled"
  | "passed"
  | "target-failed"
  | "timed-out"
  | "tool-failed"
  | "unavailable";

interface VerifierCommand {
  executable: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface PreparedExternalVerifier {
  adapter: ExternalVerifierAdapter;
  command: VerifierCommand;
  artifactDirectory: string;
  artifactReferences: string[];
  targetArgument: string | null;
  targetMismatch?: string;
}

export interface NativeVerifierArtifact {
  relativePath: string;
  content: Uint8Array;
}

const DEVICE_OPTIONS = ["--device", "--udid"] as const;
const NATIVE_EXTENSIONS = new Set([
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

function executableName(value: string): string {
  return path
    .basename(value)
    .replace(/\.(?:cmd|exe)$/iu, "")
    .toLowerCase();
}

function optionValue(args: readonly string[], names: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    for (const name of names) {
      if (argument === name) return args[index + 1];
      if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
    }
  }
  return undefined;
}

function hasOption(args: readonly string[], names: readonly string[]): boolean {
  return optionValue(args, names) !== undefined;
}

function maestroCommand(
  command: VerifierCommand,
  serial: string,
  artifactDirectory: string,
): PreparedExternalVerifier | undefined {
  if (executableName(command.executable) !== "maestro") return undefined;
  const testIndex = command.args.indexOf("test");
  if (testIndex < 0) return undefined;

  const selected = optionValue(command.args, DEVICE_OPTIONS);
  const report = path.join(artifactDirectory, "report.xml");
  const artifacts = path.join(artifactDirectory, "artifacts");
  const args = [...command.args];
  if (selected === undefined) {
    args.splice(testIndex, 0, `--device=${serial}`);
  }
  if (!hasOption(args, ["--format"])) args.push("--format=junit");
  if (!hasOption(args, ["--output"])) args.push(`--output=${report}`);
  if (!hasOption(args, ["--test-output-dir"])) args.push(`--test-output-dir=${artifacts}`);
  if (!hasOption(args, ["--debug-output"])) args.push(`--debug-output=${artifacts}`);

  return {
    adapter: "maestro",
    command: {
      ...command,
      args,
      env: { ...command.env, ADB_READY_VERIFIER_OUTPUT_DIR: artifactDirectory },
    },
    artifactDirectory,
    artifactReferences: ["report.xml", "artifacts/"],
    targetArgument: selected ?? serial,
    ...(selected === undefined || selected === serial ? {} : { targetMismatch: selected }),
  };
}

function androidCliCommand(
  command: VerifierCommand,
  serial: string,
  artifactDirectory: string,
): PreparedExternalVerifier | undefined {
  if (executableName(command.executable) !== "android") return undefined;
  const action = command.args[0];
  const isLayout = action === "layout";
  const isScreenCapture = action === "screen" && command.args[1] === "capture";
  if (!isLayout && !isScreenCapture) return undefined;

  const selected = optionValue(command.args, ["--device"]);
  const args = [...command.args];
  if (selected === undefined) args.push(`--device=${serial}`);
  const output = path.join(artifactDirectory, isLayout ? "layout.json" : "screen.png");
  if (!hasOption(args, ["--output", "-o"])) args.push(`--output=${output}`);

  return {
    adapter: "android-cli",
    command: {
      ...command,
      args,
      env: { ...command.env, ADB_READY_VERIFIER_OUTPUT_DIR: artifactDirectory },
    },
    artifactDirectory,
    artifactReferences: [isLayout ? "layout.json" : "screen.png"],
    targetArgument: selected ?? serial,
    ...(selected === undefined || selected === serial ? {} : { targetMismatch: selected }),
  };
}

export function verifierArtifactDirectory(cwd: string, sessionId: string): string {
  void cwd;
  const safeSession = sessionId.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 120);
  return path.join(tmpdir(), `adb-ready-verifier-${safeSession}`);
}

export function prepareExternalVerifier(
  command: VerifierCommand,
  options: { cwd: string; serial: string; sessionId: string },
): PreparedExternalVerifier {
  const artifactDirectory = verifierArtifactDirectory(options.cwd, options.sessionId);
  return (
    maestroCommand(command, options.serial, artifactDirectory) ??
    androidCliCommand(command, options.serial, artifactDirectory) ?? {
      adapter: "generic",
      command: {
        ...command,
        env: { ...command.env, ADB_READY_VERIFIER_OUTPUT_DIR: artifactDirectory },
      },
      artifactDirectory,
      artifactReferences: [],
      targetArgument: null,
    }
  );
}

export function classifyExternalVerifier(options: {
  adapter: ExternalVerifierAdapter;
  passed: boolean;
  timedOut: boolean;
  aborted: boolean;
  unavailable: boolean;
  targetFailed: boolean;
  preparationFailed?: boolean;
}): ExternalVerifierOutcome {
  if (options.passed) return "passed";
  if (options.unavailable) return "unavailable";
  if (options.timedOut) return "timed-out";
  if (options.aborted) return "cancelled";
  if (options.targetFailed) return "target-failed";
  if (options.preparationFailed === true) return "tool-failed";
  return options.adapter === "maestro" ? "assertion-failed" : "tool-failed";
}

export async function collectNativeVerifierArtifacts(
  directory: string,
  limits: {
    maxFiles?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
    modifiedSinceMs?: number;
  } = {},
): Promise<{ artifacts: NativeVerifierArtifact[]; omitted: number }> {
  const maxFiles = limits.maxFiles ?? 100;
  const maxFileBytes = limits.maxFileBytes ?? 20 * 1024 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 50 * 1024 * 1024;
  const artifacts: NativeVerifierArtifact[] = [];
  let omitted = 0;
  let total = 0;

  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        omitted += 1;
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile() || !NATIVE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        omitted += 1;
        continue;
      }
      const file = await stat(absolute).catch(() => undefined);
      if (
        file === undefined ||
        (limits.modifiedSinceMs !== undefined && file.mtimeMs < limits.modifiedSinceMs) ||
        file.size > maxFileBytes ||
        total + file.size > maxTotalBytes ||
        artifacts.length >= maxFiles
      ) {
        omitted += 1;
        continue;
      }
      const content = await readFile(absolute);
      artifacts.push({
        relativePath: path.relative(directory, absolute).split(path.sep).join("/"),
        content,
      });
      total += content.byteLength;
    }
  };

  await visit(directory);
  return { artifacts, omitted };
}
