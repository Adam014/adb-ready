import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { parseAdbDevices } from "../adb/parsers.js";
import { parseAndroidLockState } from "../app/android-app.js";
import { type ProcessResult, type ProcessRunner, runProcess } from "../platform/process-runner.js";

const FIRST_EMULATOR_PORT = 5554;
const LAST_EMULATOR_PORT = 5682;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 5_000;

export interface RunningAvd {
  name: string;
  serial: string;
  port: number;
  state: string;
}

export interface UnresolvedRunningEmulator {
  serial: string;
  port: number;
  state: string;
  reason: "avd-name-unavailable";
}

export interface AvdReadiness {
  adb: boolean;
  boot: boolean;
  packageManager: boolean;
  unlocked: boolean;
  attempts: number;
  durationMs: number;
}

export interface SpawnedEmulator {
  pid: number;
  exited(): boolean;
  kill(signal: NodeJS.Signals): boolean;
  waitForExit(timeoutMs: number): Promise<boolean>;
}

export interface EmulatorSpawnRequest {
  executable: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type EmulatorSpawner = (request: EmulatorSpawnRequest) => Promise<SpawnedEmulator>;

export interface AvdLifecycleDependencies {
  runner?: ProcessRunner;
  spawnEmulator?: EmulatorSpawner;
  portAvailable?: (port: number) => Promise<boolean>;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  clock?: () => Date;
}

export interface PrepareAvdOptions {
  name: string;
  emulator: string;
  adb: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export type AvdLifecycleFailureCode =
  | "AVD_AMBIGUOUS_RUNNING"
  | "AVD_CANCELLED"
  | "AVD_EMULATOR_EXITED"
  | "AVD_LIST_FAILED"
  | "AVD_NOT_FOUND"
  | "AVD_PORT_UNAVAILABLE"
  | "AVD_READINESS_TIMEOUT"
  | "AVD_RUNNING_UNVERIFIED"
  | "AVD_START_FAILED";

export interface AvdLifecycleFailure {
  code: AvdLifecycleFailureCode;
  summary: string;
  detail: string;
  next: string;
  cleanup?: AvdCleanupResult;
}

export interface AvdCleanupResult {
  attempted: boolean;
  stopped: boolean;
  forced: boolean;
  detail: string;
}

export interface PreparedAvd {
  name: string;
  serial: string;
  port: number;
  ownership: "owned" | "reused";
  pid?: number;
  readiness: AvdReadiness;
  release(signal?: AbortSignal): Promise<AvdCleanupResult>;
}

export type PrepareAvdResult =
  | { ok: true; avd: PreparedAvd }
  | { ok: false; failure: AvdLifecycleFailure };

function processSucceeded(result: ProcessResult): boolean {
  return (
    result.spawnError === undefined &&
    result.streamError === undefined &&
    result.exitCode === 0 &&
    !result.timedOut &&
    !result.aborted
  );
}

function validAvdName(value: string): boolean {
  const printable = [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 31 && code !== 127;
  });
  return value.trim() === value && value.length > 0 && value.length <= 256 && printable;
}

export function parseAvdList(output: string): string[] {
  return [
    ...new Set(
      output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(validAvdName),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export function parseEmulatorSerial(serial: string): number | undefined {
  const match = /^emulator-(\d+)$/u.exec(serial);
  if (match === null) return undefined;
  const port = Number(match[1]);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_534 ? port : undefined;
}

function avdNameFromConsole(output: string): string | undefined {
  const name = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line !== "" && line !== "OK");
  return name !== undefined && validAvdName(name) ? name : undefined;
}

async function run(
  runner: ProcessRunner,
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProcessResult> {
  return await runner({
    executable,
    args,
    ...(signal === undefined ? {} : { signal }),
    timeoutMs,
    maxBufferBytes: 1024 * 1024,
  });
}

export async function listConfiguredAvds(
  emulator: string,
  runner: ProcessRunner = runProcess,
  signal?: AbortSignal,
): Promise<{ avds: string[]; process: ProcessResult }> {
  const process = await run(runner, emulator, ["-list-avds"], signal);
  return { avds: processSucceeded(process) ? parseAvdList(process.stdout) : [], process };
}

export async function listRunningAvds(
  adb: string,
  runner: ProcessRunner = runProcess,
  signal?: AbortSignal,
): Promise<{
  avds: RunningAvd[];
  unresolved: UnresolvedRunningEmulator[];
  process: ProcessResult;
}> {
  const devices = await run(runner, adb, ["devices", "-l"], signal);
  if (!processSucceeded(devices)) return { avds: [], unresolved: [], process: devices };
  const emulators = parseAdbDevices(devices.stdout)
    .map((device) => ({ device, port: parseEmulatorSerial(device.serial) }))
    .filter(
      (item): item is { device: ReturnType<typeof parseAdbDevices>[number]; port: number } =>
        item.port !== undefined,
    );
  const resolved = await Promise.all(
    emulators.map(async ({ device, port }) => {
      const observation = await run(
        runner,
        adb,
        ["-s", device.serial, "emu", "avd", "name"],
        signal,
      );
      const name = processSucceeded(observation)
        ? avdNameFromConsole(observation.stdout)
        : undefined;
      return name === undefined
        ? {
            unresolved: {
              serial: device.serial,
              port,
              state: device.state,
              reason: "avd-name-unavailable" as const,
            },
          }
        : { avd: { name, serial: device.serial, port, state: device.state } };
    }),
  );
  const avds: RunningAvd[] = [];
  const unresolved: UnresolvedRunningEmulator[] = [];
  for (const item of resolved) {
    if (item.avd !== undefined) avds.push(item.avd);
    if (item.unresolved !== undefined) unresolved.push(item.unresolved);
  }
  avds.sort((left, right) => left.serial.localeCompare(right.serial));
  unresolved.sort((left, right) => left.serial.localeCompare(right.serial));
  return { avds, unresolved, process: devices };
}

async function defaultPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    const finish = (available: boolean) => {
      server.removeAllListeners();
      if (server.listening) server.close(() => resolve(available));
      else resolve(available);
    };
    server.once("error", () => finish(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => finish(true));
  });
}

export async function selectEmulatorPort(
  running: readonly {
    port: number;
    name?: string;
    serial?: string;
    state?: string;
  }[],
  available: (port: number) => Promise<boolean> = defaultPortAvailable,
): Promise<number | undefined> {
  const used = new Set(running.flatMap(({ port }) => [port, port + 1]));
  for (let port = FIRST_EMULATOR_PORT; port <= LAST_EMULATOR_PORT; port += 2) {
    if (used.has(port) || used.has(port + 1)) continue;
    if ((await available(port)) && (await available(port + 1))) return port;
  }
  return undefined;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export const spawnEmulator: EmulatorSpawner = async (request) => {
  const child = spawn(request.executable, request.args, {
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.env === undefined ? {} : { env: request.env }),
    detached: false,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (child.pid === undefined) throw new Error("Android Emulator started without a process ID.");
  let exited = child.exitCode !== null || child.signalCode !== null;
  child.once("exit", () => {
    exited = true;
  });
  return {
    pid: child.pid,
    exited: () => exited,
    kill: (signal) => child.kill(signal),
    waitForExit: async (timeoutMs) => {
      if (exited) return true;
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          child.removeListener("exit", onExit);
          resolve(false);
        }, timeoutMs);
        const onExit = () => {
          clearTimeout(timer);
          resolve(true);
        };
        child.once("exit", onExit);
      });
    },
  };
};

function readinessFrom(
  stages: Omit<AvdReadiness, "attempts" | "durationMs">,
  attempts: number,
  durationMs: number,
): AvdReadiness {
  return { ...stages, attempts, durationMs };
}

async function probeReadiness(
  adb: string,
  serial: string,
  runner: ProcessRunner,
  signal?: AbortSignal,
): Promise<Omit<AvdReadiness, "attempts" | "durationMs">> {
  const state = await run(runner, adb, ["-s", serial, "get-state"], signal);
  const adbReady = processSucceeded(state) && state.stdout.trim() === "device";
  if (!adbReady) return { adb: false, boot: false, packageManager: false, unlocked: false };

  const [boot, packages, lock] = await Promise.all([
    run(runner, adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], signal),
    run(runner, adb, ["-s", serial, "shell", "cmd", "package", "path", "android"], signal),
    run(runner, adb, ["-s", serial, "shell", "dumpsys", "window", "policy"], signal),
  ]);
  return {
    adb: true,
    boot: processSucceeded(boot) && boot.stdout.trim() === "1",
    packageManager: processSucceeded(packages) && /^package:\S+/mu.test(packages.stdout),
    unlocked: processSucceeded(lock) && parseAndroidLockState(lock.stdout) === "unlocked",
  };
}

async function waitForAvdReadiness(
  options: PrepareAvdOptions,
  serial: string,
  process: SpawnedEmulator | undefined,
  dependencies: AvdLifecycleDependencies,
): Promise<
  | { ready: true; readiness: AvdReadiness }
  | { ready: false; readiness: AvdReadiness; reason: "cancelled" | "exited" | "timeout" }
> {
  const runner = dependencies.runner ?? runProcess;
  const clock = dependencies.clock ?? (() => new Date());
  const sleep = dependencies.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new RangeError("AVD timeoutMs must be a positive integer");
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1)
    throw new RangeError("AVD pollIntervalMs must be a positive integer");
  const started = clock().getTime();
  let attempts = 0;
  let stages = { adb: false, boot: false, packageManager: false, unlocked: false };
  while (true) {
    if (options.signal?.aborted === true)
      return {
        ready: false,
        readiness: readinessFrom(stages, attempts, clock().getTime() - started),
        reason: "cancelled",
      };
    if (process?.exited() === true)
      return {
        ready: false,
        readiness: readinessFrom(stages, attempts, clock().getTime() - started),
        reason: "exited",
      };
    attempts += 1;
    stages = await probeReadiness(options.adb, serial, runner, options.signal);
    const durationMs = Math.max(0, clock().getTime() - started);
    if (Object.values(stages).every(Boolean))
      return { ready: true, readiness: readinessFrom(stages, attempts, durationMs) };
    if (durationMs >= timeoutMs)
      return {
        ready: false,
        readiness: readinessFrom(stages, attempts, durationMs),
        reason: "timeout",
      };
    await sleep(Math.min(pollIntervalMs, timeoutMs - durationMs), options.signal);
  }
}

async function cleanupOwnedEmulator(
  adb: string,
  serial: string,
  owned: SpawnedEmulator,
  runner: ProcessRunner,
  signal?: AbortSignal,
): Promise<AvdCleanupResult> {
  if (owned.exited())
    return {
      attempted: false,
      stopped: true,
      forced: false,
      detail: "The owned emulator process had already exited.",
    };
  const stopped = await run(runner, adb, ["-s", serial, "emu", "kill"], signal).catch(
    () => undefined,
  );
  if (stopped !== undefined && processSucceeded(stopped) && (await owned.waitForExit(5_000))) {
    return {
      attempted: true,
      stopped: true,
      forced: false,
      detail: "The owned emulator stopped through its target-scoped console command.",
    };
  }
  owned.kill("SIGTERM");
  if (await owned.waitForExit(2_000))
    return {
      attempted: true,
      stopped: true,
      forced: true,
      detail: "The owned emulator required direct process termination.",
    };
  owned.kill("SIGKILL");
  const exited = await owned.waitForExit(2_000);
  return {
    attempted: true,
    stopped: exited,
    forced: true,
    detail: exited
      ? "The owned emulator required forced process termination."
      : "The owned emulator did not exit after forced termination.",
  };
}

function readinessFailure(
  reason: "cancelled" | "exited" | "timeout",
  name: string,
  cleanup?: AvdCleanupResult,
): AvdLifecycleFailure {
  if (reason === "cancelled")
    return {
      code: "AVD_CANCELLED",
      summary: "AVD preparation was cancelled.",
      detail: `${name} did not become ready before cancellation.`,
      next: "Retry when the workflow can remain active.",
      ...(cleanup === undefined ? {} : { cleanup }),
    };
  if (reason === "exited")
    return {
      code: "AVD_EMULATOR_EXITED",
      summary: "The Android Emulator exited during startup.",
      detail: `${name} ended before Android became ready.`,
      next: `Start ${name} in Android Studio to inspect its startup error, then retry.`,
      ...(cleanup === undefined ? {} : { cleanup }),
    };
  return {
    code: "AVD_READINESS_TIMEOUT",
    summary: "The Android Emulator did not become ready in time.",
    detail: `${name} did not satisfy ADB, boot, package-manager, and unlock readiness.`,
    next: "Increase --run-timeout only after checking the emulator boot screen and available host resources.",
    ...(cleanup === undefined ? {} : { cleanup }),
  };
}

export async function prepareExistingAvd(
  options: PrepareAvdOptions,
  dependencies: AvdLifecycleDependencies = {},
): Promise<PrepareAvdResult> {
  if (!validAvdName(options.name))
    throw new RangeError("AVD name must be a non-empty printable value of at most 256 characters");
  const runner = dependencies.runner ?? runProcess;
  const configured = await listConfiguredAvds(options.emulator, runner, options.signal);
  if (!processSucceeded(configured.process)) {
    return {
      ok: false,
      failure: {
        code: "AVD_LIST_FAILED",
        summary: "Configured Android virtual devices could not be listed.",
        detail: "The Android Emulator returned an error for -list-avds.",
        next: `Run ${options.emulator} -list-avds and repair the Emulator installation.`,
      },
    };
  }
  if (!configured.avds.includes(options.name)) {
    return {
      ok: false,
      failure: {
        code: "AVD_NOT_FOUND",
        summary: `AVD ${options.name} does not exist.`,
        detail:
          configured.avds.length === 0
            ? "No existing Android virtual devices were reported."
            : `Available AVDs: ${configured.avds.join(", ")}.`,
        next: "Choose an exact existing AVD name; ADB Ready never creates one implicitly.",
      },
    };
  }
  const running = await listRunningAvds(options.adb, runner, options.signal);
  if (!processSucceeded(running.process)) {
    return {
      ok: false,
      failure: {
        code: "AVD_LIST_FAILED",
        summary: "Running Android emulators could not be inspected.",
        detail: "ADB devices failed before AVD ownership could be determined.",
        next: `Run ${options.adb} devices -l and repair the ADB server before retrying.`,
      },
    };
  }
  const matches = running.avds.filter(({ name }) => name === options.name);
  if (matches.length > 1) {
    return {
      ok: false,
      failure: {
        code: "AVD_AMBIGUOUS_RUNNING",
        summary: `Multiple running emulators use AVD ${options.name}.`,
        detail: `Matching serials: ${matches.map(({ serial }) => serial).join(", ")}.`,
        next: "Stop or explicitly disambiguate the duplicate emulator instances before retrying.",
      },
    };
  }
  if (matches.length === 0 && running.unresolved.length > 0) {
    return {
      ok: false,
      failure: {
        code: "AVD_RUNNING_UNVERIFIED",
        summary: "A running emulator could not be identified safely.",
        detail: `ADB could not read the AVD name for ${running.unresolved
          .map(({ serial, state }) => `${serial} (${state})`)
          .join(", ")}. It may already be ${options.name}.`,
        next: "Wait for the existing emulator to answer ADB, or stop it explicitly before retrying. ADB Ready will not risk starting a duplicate AVD.",
      },
    };
  }

  let owned: SpawnedEmulator | undefined;
  let serial: string;
  let port: number;
  if (matches[0] !== undefined) {
    serial = matches[0].serial;
    port = matches[0].port;
  } else {
    const selectedPort = await selectEmulatorPort(
      [...running.avds, ...running.unresolved],
      dependencies.portAvailable,
    );
    if (selectedPort === undefined) {
      return {
        ok: false,
        failure: {
          code: "AVD_PORT_UNAVAILABLE",
          summary: "No safe Android Emulator console port is available.",
          detail: `ADB Ready checked even console ports ${String(FIRST_EMULATOR_PORT)}-${String(LAST_EMULATOR_PORT)} and their adjacent ADB ports.`,
          next: "Stop an unused emulator or free one complete emulator port pair, then retry.",
        },
      };
    }
    port = selectedPort;
    serial = `emulator-${String(port)}`;
    try {
      owned = await (dependencies.spawnEmulator ?? spawnEmulator)({
        executable: options.emulator,
        args: ["-avd", options.name, "-port", String(port)],
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
      });
    } catch (error) {
      return {
        ok: false,
        failure: {
          code: "AVD_START_FAILED",
          summary: `AVD ${options.name} could not be started.`,
          detail: error instanceof Error ? error.message : String(error),
          next: `Run ${options.emulator} -avd ${options.name} and inspect the Emulator startup diagnostics.`,
        },
      };
    }
  }

  const readiness = await waitForAvdReadiness(options, serial, owned, dependencies);
  if (!readiness.ready) {
    const cleanup =
      owned === undefined
        ? undefined
        : await cleanupOwnedEmulator(options.adb, serial, owned, runner);
    return { ok: false, failure: readinessFailure(readiness.reason, options.name, cleanup) };
  }
  const ownership = owned === undefined ? "reused" : "owned";
  let released = false;
  return {
    ok: true,
    avd: {
      name: options.name,
      serial,
      port,
      ownership,
      ...(owned === undefined ? {} : { pid: owned.pid }),
      readiness: readiness.readiness,
      release: async (signal) => {
        if (released)
          return {
            attempted: false,
            stopped: ownership === "owned" ? owned?.exited() === true : false,
            forced: false,
            detail: "AVD release was already finalized.",
          };
        released = true;
        return owned === undefined
          ? {
              attempted: false,
              stopped: false,
              forced: false,
              detail: "The emulator was already running and is not owned by this workflow.",
            }
          : await cleanupOwnedEmulator(options.adb, serial, owned, runner, signal);
      },
    },
  };
}
