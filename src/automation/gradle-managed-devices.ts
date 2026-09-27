import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactText } from "../core/redaction.js";
import {
  ExitCode,
  type OperationPlan,
  type Problem,
  type ResultEnvelope,
  SCHEMA_VERSION,
} from "../domain/contracts.js";
import { type ProcessResult, type ProcessRunner, runProcess } from "../platform/process-runner.js";
import { collectNativeVerifierArtifacts } from "./external-verifier.js";

export type GradleManagedOutcome =
  | "assertion-failed"
  | "cancelled"
  | "infrastructure-failed"
  | "passed"
  | "timed-out";

export interface GradleManagedTestData {
  status: "completed" | "discovered" | "planned";
  wrapper: string;
  task?: string;
  tasks?: string[];
  command?: { executable: string; args: string[] };
  plan?: OperationPlan;
  outcome?: GradleManagedOutcome;
  tests?: { total: number; failed: number; errors: number; skipped: number };
  reports?: string[];
  evidence?: {
    path: string;
    nativeFiles: number;
    omittedFiles: number;
    provenance: "fresh" | "gradle-cache" | "none";
  };
}

export interface GradleManagedTestOptions {
  cwd: string;
  task?: string;
  gradlePath?: string;
  shards?: number;
  softwareRendering?: boolean;
  timeoutMs?: number;
  dryRun?: boolean;
}

export interface GradleManagedTestDependencies {
  clock?: () => Date;
  idFactory?: () => string;
  runner?: ProcessRunner;
}

export interface GradleManagedTestExecution {
  result: ResultEnvelope<GradleManagedTestData>;
  exitCode: number;
}

const MANAGED_RESULT_SUFFIX = path.join("build", "outputs", "androidTest-results", "managedDevice");
const MANAGED_REPORT_SUFFIX = path.join("build", "reports", "androidTests", "managedDevice");
const MANAGED_ADDITIONAL_OUTPUT_SUFFIX = path.join(
  "build",
  "outputs",
  "managed_device_android_test_additional_output",
);
const SKIPPED_DIRECTORIES = new Set([".git", ".gradle", ".idea", ".adb-ready", "node_modules"]);

function problem(
  code: string,
  category: string,
  summary: string,
  detail: string,
  commandId: string,
  evidence: Problem["evidence"] = [],
): Problem {
  return {
    code,
    category,
    severity: "error",
    summary,
    detail,
    retryable: true,
    evidence,
    actions: [],
    correlation: { commandId },
  };
}

function finish(
  started: Date,
  finished: Date,
  commandId: string,
  data: GradleManagedTestData | null,
  problems: Problem[],
  exitCode: number,
): GradleManagedTestExecution {
  return {
    exitCode,
    result: {
      schemaVersion: SCHEMA_VERSION,
      command: "test gradle",
      commandId,
      ok: exitCode === ExitCode.Success,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: Math.max(0, finished.getTime() - started.getTime()),
      data,
      problems,
    },
  };
}

async function regularFile(candidate: string): Promise<boolean> {
  return await stat(candidate)
    .then((entry) => entry.isFile())
    .catch(() => false);
}

async function resolveGradle(
  cwd: string,
  explicit: string | undefined,
): Promise<{ executable: string; display: string } | undefined> {
  if (explicit !== undefined) {
    const executable = path.isAbsolute(explicit) ? explicit : path.resolve(cwd, explicit);
    return { executable, display: explicit };
  }
  const wrapper = process.platform === "win32" ? "gradlew.bat" : "gradlew";
  for (const relative of [wrapper, path.join("android", wrapper)]) {
    const executable = path.join(cwd, relative);
    if (await regularFile(executable))
      return { executable, display: relative.split(path.sep).join("/") };
  }
  return undefined;
}

function validManagedTask(task: string): boolean {
  const leaf = task.split(":").filter(Boolean).at(-1) ?? "";
  return (
    /^[A-Za-z][A-Za-z0-9_]*AndroidTest$/u.test(leaf) &&
    !/^connected[A-Z]/u.test(leaf) &&
    !/^device[A-Z].*AndroidTest$/u.test(leaf)
  );
}

export function parseGradleManagedTasks(output: string): string[] {
  const tasks = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^\s*(:?[A-Za-z0-9_.:-]+AndroidTest)\s+-\s+(.+)$/u);
    if (match === null) continue;
    const task = match[1];
    const description = (match[2] ?? "").toLowerCase();
    const leaf = task?.split(":").filter(Boolean).at(-1) ?? "";
    if (
      task !== undefined &&
      validManagedTask(task) &&
      (/managed device|all devices (?:defined|in)/u.test(description) ||
        /Group[A-Z].*AndroidTest$/u.test(leaf))
    ) {
      tasks.add(task);
    }
  }
  return [...tasks].sort((left, right) => left.localeCompare(right));
}

function gradleArgs(options: GradleManagedTestOptions, task: string): string[] {
  return [
    task,
    "--console=plain",
    "--no-daemon",
    ...(options.shards === undefined
      ? []
      : [`-Pandroid.experimental.androidTest.numManagedDeviceShards=${String(options.shards)}`]),
    ...(options.softwareRendering === true
      ? ["-Pandroid.testoptions.manageddevices.emulator.gpu=swiftshader_indirect"]
      : []),
  ];
}

async function findManagedRoots(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8 || found.length >= 100) return;
    const resultRoot = path.join(directory, MANAGED_RESULT_SUFFIX);
    const reportRoot = path.join(directory, MANAGED_REPORT_SUFFIX);
    const additionalOutputRoot = path.join(directory, MANAGED_ADDITIONAL_OUTPUT_SUFFIX);
    for (const candidate of [resultRoot, reportRoot, additionalOutputRoot]) {
      const directoryExists = await stat(candidate)
        .then((entry) => entry.isDirectory())
        .catch(() => false);
      if (directoryExists) found.push(candidate);
    }
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name))
        continue;
      if (entry.name === "build") continue;
      await visit(path.join(directory, entry.name), depth + 1);
    }
  };
  await visit(root, 0);
  return [...new Set(found)].sort((left, right) => left.localeCompare(right));
}

function junitSummary(documents: readonly string[]): {
  total: number;
  failed: number;
  errors: number;
  skipped: number;
} {
  const summary = { total: 0, failed: 0, errors: 0, skipped: 0 };
  for (const document of documents) {
    for (const match of document.matchAll(/<testsuite\b([^>]*)>/giu)) {
      const attributes = match[1] ?? "";
      const read = (name: string): number => {
        const value = attributes.match(new RegExp(`\\b${name}=["'](\\d+)["']`, "iu"))?.[1];
        return value === undefined ? 0 : Number(value);
      };
      summary.total += read("tests");
      summary.failed += read("failures");
      summary.errors += read("errors");
      summary.skipped += read("skipped");
    }
  }
  return summary;
}

async function retainEvidence(options: {
  cwd: string;
  commandId: string;
  process: ProcessResult;
  task: string;
  outcome: GradleManagedOutcome;
  roots: readonly string[];
}): Promise<{
  path: string;
  nativeFiles: number;
  omittedFiles: number;
  reports: string[];
  tests: { total: number; failed: number; errors: number; skipped: number };
  outcome: GradleManagedOutcome;
  provenance: "fresh" | "gradle-cache" | "none";
}> {
  const safeId = options.commandId.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 80);
  const relative = path.posix.join(".adb-ready", "artifacts", `gradle-managed-${safeId}`);
  const destination = path.join(options.cwd, ...relative.split("/"));
  const temporary = `${destination}.tmp-${randomUUID()}`;
  const collect = async (freshOnly: boolean) => {
    const files: Array<{ name: string; content: Uint8Array }> = [];
    let omitted = 0;
    let retainedBytes = 0;
    for (const [rootIndex, root] of options.roots.entries()) {
      const native = await collectNativeVerifierArtifacts(root, {
        maxFiles: Math.max(0, 100 - files.length),
        maxFileBytes: 20 * 1024 * 1024,
        maxTotalBytes: Math.max(0, 50 * 1024 * 1024 - retainedBytes),
        ...(freshOnly ? { modifiedSinceMs: Date.parse(options.process.startedAt) - 2_000 } : {}),
      });
      omitted += native.omitted;
      for (const artifact of native.artifacts) {
        files.push({
          name: path.posix.join(`root-${String(rootIndex + 1)}`, artifact.relativePath),
          content: artifact.content,
        });
        retainedBytes += artifact.content.byteLength;
      }
    }
    return { files, omitted };
  };
  let collected = await collect(true);
  let provenance: "fresh" | "gradle-cache" | "none" =
    collected.files.length === 0 ? "none" : "fresh";
  if (collected.files.length === 0 && options.outcome === "passed") {
    collected = await collect(false);
    if (collected.files.length > 0) provenance = "gradle-cache";
  }
  const nativeFiles = collected.files;
  const omittedFiles = collected.omitted;
  const reports = nativeFiles.map(({ name }) => path.posix.join(relative, "native", name));
  const junitDocuments = nativeFiles
    .filter(({ name }) => name.toLowerCase().endsWith(".xml"))
    .map(({ content }) => new TextDecoder().decode(content));
  const tests = junitSummary(junitDocuments);
  const outcome =
    provenance === "fresh" && tests.failed + tests.errors > 0
      ? "assertion-failed"
      : options.outcome;
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await mkdir(path.join(temporary, "native"), { recursive: true, mode: 0o700 });
  try {
    for (const file of nativeFiles) {
      const target = path.join(temporary, "native", ...file.name.split("/"));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const text = /\.(?:html|json|log|txt|xml)$/iu.test(file.name);
      await writeFile(
        target,
        text ? redactText(new TextDecoder().decode(file.content)).value : file.content,
        { mode: 0o600 },
      );
    }
    await writeFile(path.join(temporary, "stdout.txt"), redactText(options.process.stdout).value, {
      mode: 0o600,
    });
    await writeFile(path.join(temporary, "stderr.txt"), redactText(options.process.stderr).value, {
      mode: 0o600,
    });
    await writeFile(
      path.join(temporary, "result.json"),
      `${JSON.stringify({ schemaVersion: 1, task: options.task, outcome, provenance, tests, reports }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return {
    path: relative,
    nativeFiles: nativeFiles.length,
    omittedFiles,
    reports,
    tests,
    outcome,
    provenance,
  };
}

function successfulProcess(result: ProcessResult): boolean {
  return (
    result.spawnError === undefined &&
    result.streamError === undefined &&
    result.exitCode === 0 &&
    !result.timedOut &&
    !result.aborted
  );
}

function identifiesManagedDeviceTask(output: string, task: string): boolean {
  const leaf = task.split(":").filter(Boolean).at(-1) ?? "";
  return (
    /ManagedDevice|managed[ -]device/iu.test(output) ||
    (/Group[A-Z].*AndroidTest$/u.test(leaf) && /all devices defined/iu.test(output))
  );
}

export async function runGradleManagedTest(
  options: GradleManagedTestOptions,
  dependencies: GradleManagedTestDependencies = {},
  signal?: AbortSignal,
): Promise<GradleManagedTestExecution> {
  const clock = dependencies.clock ?? (() => new Date());
  const commandId = (dependencies.idFactory ?? randomUUID)();
  const started = clock();
  const runner = dependencies.runner ?? runProcess;
  const gradle = await resolveGradle(options.cwd, options.gradlePath);
  if (gradle === undefined) {
    return finish(
      started,
      clock(),
      commandId,
      null,
      [
        problem(
          "GRADLE_WRAPPER_NOT_FOUND",
          "environment.gradle",
          "No Gradle Wrapper was found for this project.",
          "Run from the Android project root, keep the Wrapper checked in, or pass --gradle PATH.",
          commandId,
        ),
      ],
      ExitCode.Environment,
    );
  }

  if (options.task === undefined) {
    const discovered = await runner({
      executable: gradle.executable,
      args: ["tasks", "--all", "--console=plain", "--no-daemon"],
      cwd: options.cwd,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: options.timeoutMs ?? 120_000,
      killProcessGroup: true,
    });
    if (!successfulProcess(discovered)) {
      const interrupted = discovered.aborted;
      return finish(
        started,
        clock(),
        commandId,
        null,
        [
          problem(
            interrupted ? "GRADLE_DISCOVERY_CANCELLED" : "GRADLE_DISCOVERY_FAILED",
            "automation.gradle.discovery",
            interrupted
              ? "Gradle managed-device discovery was cancelled."
              : "Gradle managed-device tasks could not be discovered.",
            discovered.timedOut
              ? "Gradle task discovery exceeded its timeout."
              : redactText(discovered.stderr || discovered.stdout || "Gradle did not start.").value,
            commandId,
          ),
        ],
        interrupted ? ExitCode.Interrupted : ExitCode.ChildProcess,
      );
    }
    return finish(
      started,
      clock(),
      commandId,
      {
        status: "discovered",
        wrapper: gradle.display,
        tasks: parseGradleManagedTasks(discovered.stdout),
      },
      [],
      ExitCode.Success,
    );
  }

  if (!validManagedTask(options.task)) {
    return finish(
      started,
      clock(),
      commandId,
      null,
      [
        problem(
          "GRADLE_MANAGED_TASK_INVALID",
          "input.gradle.task",
          "The requested Gradle task is not a managed-device test task.",
          "Use a declared task ending in AndroidTest; connected* tasks remain target-bound and belong under adb-ready run.",
          commandId,
          [{ source: "cli", field: "task", value: options.task }],
        ),
      ],
      ExitCode.InvalidInput,
    );
  }

  const args = gradleArgs(options, options.task);
  const command = { executable: gradle.display, args };
  const plan: OperationPlan = {
    schemaVersion: SCHEMA_VERSION,
    dryRun: options.dryRun === true,
    steps: [
      {
        id: "gradle-managed-test",
        title: `Let Gradle provision, test, and tear down ${options.task}`,
        risk: "local-additive",
        executable: gradle.display,
        args,
      },
      {
        id: "retain-gradle-evidence",
        title: "Retain bounded native reports and normalized result",
        risk: "local-additive",
      },
    ],
  };
  if (options.dryRun) {
    return finish(
      started,
      clock(),
      commandId,
      { status: "planned", wrapper: gradle.display, task: options.task, command, plan },
      [],
      ExitCode.Success,
    );
  }

  const preflight = await runner({
    executable: gradle.executable,
    args: ["help", "--task", options.task, "--console=plain", "--no-daemon"],
    cwd: options.cwd,
    ...(signal === undefined ? {} : { signal }),
    timeoutMs: Math.min(options.timeoutMs ?? 15 * 60_000, 120_000),
    killProcessGroup: true,
  });
  if (!successfulProcess(preflight)) {
    const cancelled = preflight.aborted;
    return finish(
      started,
      clock(),
      commandId,
      null,
      [
        problem(
          cancelled ? "GRADLE_TASK_PREFLIGHT_CANCELLED" : "GRADLE_MANAGED_TASK_NOT_FOUND",
          "automation.gradle.task",
          cancelled
            ? "Gradle task validation was cancelled."
            : "The requested Gradle managed-device task is not declared by this build.",
          cancelled
            ? "No Gradle test task was started."
            : "Run adb-ready test gradle to discover declared managed-device tasks.",
          commandId,
          [{ source: "gradle", field: "task", value: options.task }],
        ),
      ],
      cancelled ? ExitCode.Interrupted : ExitCode.InvalidInput,
    );
  }
  if (!identifiesManagedDeviceTask(`${preflight.stdout}\n${preflight.stderr}`, options.task)) {
    return finish(
      started,
      clock(),
      commandId,
      null,
      [
        problem(
          "GRADLE_TASK_NOT_MANAGED_DEVICE",
          "input.gradle.task",
          "Gradle resolved the task, but did not identify it as a managed-device task.",
          "Run adb-ready test gradle and select a task declared by Android Gradle Plugin managedDevices.",
          commandId,
          [{ source: "gradle", field: "task", value: options.task }],
        ),
      ],
      ExitCode.InvalidInput,
    );
  }

  const executed = await runner({
    executable: gradle.executable,
    args,
    cwd: options.cwd,
    ...(signal === undefined ? {} : { signal }),
    timeoutMs: options.timeoutMs ?? 15 * 60_000,
    killProcessGroup: true,
  });
  const roots = await findManagedRoots(options.cwd);
  let provisionalOutcome: GradleManagedOutcome = successfulProcess(executed)
    ? "passed"
    : executed.aborted
      ? "cancelled"
      : executed.timedOut
        ? "timed-out"
        : "infrastructure-failed";
  const retained = await retainEvidence({
    cwd: options.cwd,
    commandId,
    process: executed,
    task: options.task,
    outcome: provisionalOutcome,
    roots,
  });
  provisionalOutcome = retained.outcome;
  const exitCode =
    provisionalOutcome === "passed"
      ? ExitCode.Success
      : provisionalOutcome === "cancelled"
        ? ExitCode.Interrupted
        : ExitCode.ChildProcess;
  const problems =
    provisionalOutcome === "passed"
      ? []
      : [
          problem(
            provisionalOutcome === "assertion-failed"
              ? "GRADLE_TEST_ASSERTION_FAILED"
              : provisionalOutcome === "timed-out"
                ? "GRADLE_MANAGED_TEST_TIMED_OUT"
                : provisionalOutcome === "cancelled"
                  ? "GRADLE_MANAGED_TEST_CANCELLED"
                  : "GRADLE_MANAGED_INFRASTRUCTURE_FAILED",
            provisionalOutcome === "assertion-failed"
              ? "automation.test.assertion"
              : "automation.gradle.infrastructure",
            provisionalOutcome === "assertion-failed"
              ? "One or more Gradle managed-device assertions failed."
              : provisionalOutcome === "timed-out"
                ? "The Gradle managed-device task exceeded its timeout."
                : provisionalOutcome === "cancelled"
                  ? "The Gradle managed-device task was cancelled."
                  : "Gradle could not complete the managed-device infrastructure lifecycle.",
            `Review the retained native reports and Gradle output in ${retained.path}.`,
            commandId,
          ),
        ];
  return finish(
    started,
    clock(),
    commandId,
    {
      status: "completed",
      wrapper: gradle.display,
      task: options.task,
      command,
      outcome: provisionalOutcome,
      tests: retained.tests,
      reports: retained.reports,
      evidence: {
        path: retained.path,
        nativeFiles: retained.nativeFiles,
        omittedFiles: retained.omittedFiles,
        provenance: retained.provenance,
      },
    },
    problems,
    exitCode,
  );
}
