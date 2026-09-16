import { describe, expect, test } from "bun:test";
import {
  type AvdLifecycleDependencies,
  listConfiguredAvds,
  listRunningAvds,
  parseAvdList,
  parseEmulatorSerial,
  prepareExistingAvd,
  type SpawnedEmulator,
  selectEmulatorPort,
  spawnEmulator,
} from "../../src/automation/avd-lifecycle.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../../src/platform/process-runner.js";

function result(
  request: ProcessRequest,
  stdout = "",
  overrides: Partial<ProcessResult> = {},
): ProcessResult {
  return {
    executable: request.executable,
    args: [...(request.args ?? [])],
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.001Z",
    durationMs: 1,
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    stoppedAfterIdle: false,
    killEscalated: false,
    ...overrides,
  };
}

function command(request: ProcessRequest): string {
  return [request.executable, ...(request.args ?? [])].join(" ");
}

function readyRunner(options: { devices?: string; avdName?: string; onKill?: () => void } = {}) {
  const requests: ProcessRequest[] = [];
  const runner: ProcessRunner = async (request) => {
    requests.push(request);
    const args = request.args ?? [];
    if (request.executable === "emulator")
      return result(request, "Pixel_9_API_36\nTablet_API_35\n");
    if (args[0] === "devices") {
      return result(
        request,
        options.devices ??
          "List of devices attached\nemulator-5554 device model:sdk_gphone64_arm64 transport_id:1\n",
      );
    }
    if (args.includes("emu") && args.includes("name")) {
      return result(request, `${options.avdName ?? "Pixel_9_API_36"}\nOK\n`);
    }
    if (args.includes("get-state")) return result(request, "device\n");
    if (args.includes("sys.boot_completed")) return result(request, "1\n");
    if (args.includes("package") && args.includes("path")) {
      return result(request, "package:/system/framework/framework-res.apk\n");
    }
    if (args.includes("dumpsys")) return result(request, "showing=false\n");
    if (args.includes("kill")) {
      options.onKill?.();
      return result(request, "OK\n");
    }
    throw new Error(`Unexpected request: ${command(request)}`);
  };
  return { runner, requests };
}

function ownedProcess(onSignal?: (signal: NodeJS.Signals) => void): SpawnedEmulator & {
  setExited(value: boolean): void;
} {
  let exited = false;
  return {
    pid: 4242,
    exited: () => exited,
    setExited: (value) => {
      exited = value;
    },
    kill: (signal) => {
      onSignal?.(signal);
      exited = true;
      return true;
    },
    waitForExit: async () => exited,
  };
}

describe("existing AVD lifecycle", () => {
  test("parses stable AVD inventories and emulator serials without list-order selection", () => {
    expect(parseAvdList("Tablet\r\nPixel\nPixel\n\n bad\u0007name\n")).toEqual(["Pixel", "Tablet"]);
    expect(parseEmulatorSerial("emulator-5554")).toBe(5554);
    expect(parseEmulatorSerial("emulator-0")).toBeUndefined();
    expect(parseEmulatorSerial("device-5554")).toBeUndefined();
  });

  test("lists configured and running AVDs through direct argument arrays", async () => {
    const fixture = readyRunner({
      devices:
        "List of devices attached\nemulator-5556 offline model:Pixel transport_id:2\nusb-1 device model:Phone transport_id:3\n",
      avdName: "Pixel_9_API_36",
    });
    const configured = await listConfiguredAvds("emulator", fixture.runner);
    const running = await listRunningAvds("adb", fixture.runner);

    expect(configured.avds).toEqual(["Pixel_9_API_36", "Tablet_API_35"]);
    expect(running.avds).toEqual([
      { name: "Pixel_9_API_36", serial: "emulator-5556", port: 5556, state: "offline" },
    ]);
    expect(fixture.requests.map(command)).toContain("adb -s emulator-5556 emu avd name");
    expect(fixture.requests.some((request) => request.args?.includes("usb-1"))).toBe(false);
  });

  test("returns an empty inventory when listing commands fail or names are invalid", async () => {
    const runner: ProcessRunner = async (request) =>
      request.executable === "emulator"
        ? result(request, "Pixel\n", { exitCode: 1 })
        : request.args?.[0] === "devices"
          ? result(request, "failure", { exitCode: 1 })
          : result(request, "\u0007\nOK\n");

    expect((await listConfiguredAvds("emulator", runner)).avds).toEqual([]);
    const running = await listRunningAvds("adb", runner);
    expect(running.avds).toEqual([]);
    expect(running.unresolved).toEqual([]);
  });

  test("reuses an exact running AVD and never stops it", async () => {
    const fixture = readyRunner();
    let spawned = false;
    const prepared = await prepareExistingAvd(
      { name: "Pixel_9_API_36", emulator: "emulator", adb: "adb" },
      {
        runner: fixture.runner,
        spawnEmulator: async () => {
          spawned = true;
          return ownedProcess();
        },
      },
    );

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.avd).toMatchObject({
      name: "Pixel_9_API_36",
      serial: "emulator-5554",
      ownership: "reused",
      readiness: { adb: true, boot: true, packageManager: true, unlocked: true },
    });
    expect(spawned).toBe(false);
    expect(await prepared.avd.release()).toEqual({
      attempted: false,
      stopped: false,
      forced: false,
      detail: "The emulator was already running and is not owned by this workflow.",
    });
    expect(fixture.requests.some((request) => request.args?.includes("kill"))).toBe(false);
  });

  test("starts one explicit existing AVD, waits for all readiness stages, and stops only its owner", async () => {
    let killed = false;
    const process = ownedProcess();
    const fixture = readyRunner({
      devices: "List of devices attached\n",
      onKill: () => {
        killed = true;
        process.setExited(true);
      },
    });
    const spawnRequests: Array<{ executable: string; args: string[] }> = [];
    const prepared = await prepareExistingAvd(
      { name: "Pixel_9_API_36", emulator: "emulator", adb: "adb" },
      {
        runner: fixture.runner,
        portAvailable: async () => true,
        spawnEmulator: async (request) => {
          spawnRequests.push(request);
          return process;
        },
      },
    );

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.avd).toMatchObject({
      serial: "emulator-5554",
      port: 5554,
      ownership: "owned",
      pid: 4242,
    });
    expect(spawnRequests).toEqual([
      { executable: "emulator", args: ["-avd", "Pixel_9_API_36", "-port", "5554"] },
    ]);
    expect(await prepared.avd.release()).toMatchObject({
      attempted: true,
      stopped: true,
      forced: false,
    });
    expect(killed).toBe(true);
    expect(await prepared.avd.release()).toMatchObject({ attempted: false, stopped: true });
  });

  test("selects one complete free console/ADB port pair", async () => {
    const inspected: number[] = [];
    const selected = await selectEmulatorPort(
      [{ name: "First", serial: "emulator-5554", port: 5554, state: "device" }],
      async (port) => {
        inspected.push(port);
        return port !== 5557;
      },
    );
    expect(selected).toBe(5558);
    expect(inspected).toEqual([5556, 5557, 5558, 5559]);
    const realPort = await selectEmulatorPort([]);
    expect(realPort).toBeGreaterThanOrEqual(5554);
    expect((realPort ?? 1) % 2).toBe(0);
  });

  test("fails before mutation for missing, ambiguous, and unavailable AVD inputs", async () => {
    const notFoundFixture = readyRunner();
    const notFound = await prepareExistingAvd(
      { name: "Missing", emulator: "emulator", adb: "adb" },
      { runner: notFoundFixture.runner },
    );
    expect(notFound).toMatchObject({ ok: false, failure: { code: "AVD_NOT_FOUND" } });

    const ambiguousFixture = readyRunner();
    let names = 0;
    const ambiguousRunner: ProcessRunner = async (request) => {
      if (request.args?.includes("name")) {
        names += 1;
        return result(request, "Pixel_9_API_36\nOK\n");
      }
      if (request.args?.[0] === "devices") {
        return result(
          request,
          "List of devices attached\nemulator-5554 device\nemulator-5556 device\n",
        );
      }
      return await ambiguousFixture.runner(request);
    };
    const ambiguous = await prepareExistingAvd(
      { name: "Pixel_9_API_36", emulator: "emulator", adb: "adb" },
      { runner: ambiguousRunner },
    );
    expect(names).toBe(2);
    expect(ambiguous).toMatchObject({
      ok: false,
      failure: { code: "AVD_AMBIGUOUS_RUNNING" },
    });

    const unresolvedFixture = readyRunner({
      devices: "List of devices attached\nemulator-5554 offline\n",
    });
    const unresolvedRunner: ProcessRunner = async (request) =>
      request.args?.includes("name")
        ? result(request, "", { exitCode: 1 })
        : await unresolvedFixture.runner(request);
    const unresolved = await prepareExistingAvd(
      { name: "Pixel_9_API_36", emulator: "emulator", adb: "adb" },
      { runner: unresolvedRunner },
    );
    expect(unresolved).toMatchObject({
      ok: false,
      failure: {
        code: "AVD_RUNNING_UNVERIFIED",
        detail: expect.stringContaining("emulator-5554 (offline)"),
      },
    });

    const unavailableFixture = readyRunner({ devices: "List of devices attached\n" });
    const unavailable = await prepareExistingAvd(
      { name: "Pixel_9_API_36", emulator: "emulator", adb: "adb" },
      { runner: unavailableFixture.runner, portAvailable: async () => false },
    );
    expect(unavailable).toMatchObject({
      ok: false,
      failure: { code: "AVD_PORT_UNAVAILABLE" },
    });
  });

  test("classifies emulator and ADB inventory failures before startup", async () => {
    const emulatorFailure: ProcessRunner = async (request) => result(request, "", { exitCode: 1 });
    expect(
      await prepareExistingAvd(
        { name: "Pixel", emulator: "emulator", adb: "adb" },
        { runner: emulatorFailure },
      ),
    ).toMatchObject({ ok: false, failure: { code: "AVD_LIST_FAILED" } });

    const adbFailure = readyRunner();
    const runner: ProcessRunner = async (request) =>
      request.args?.[0] === "devices"
        ? result(request, "", { exitCode: 1 })
        : await adbFailure.runner(request);
    expect(
      await prepareExistingAvd(
        { name: "Pixel_9_API_36", emulator: "emulator", adb: "adb" },
        { runner },
      ),
    ).toMatchObject({ ok: false, failure: { code: "AVD_LIST_FAILED" } });
  });

  test("cleans an owned emulator after timeout, cancellation, and early exit", async () => {
    async function failedPreparation(
      mode: "cancelled" | "exited" | "timeout",
    ): Promise<{ code?: string; stopped?: boolean }> {
      let now = 0;
      const process = ownedProcess();
      if (mode === "exited") process.setExited(true);
      const controller = new AbortController();
      if (mode === "cancelled") controller.abort();
      const fixture = readyRunner({
        devices: "List of devices attached\n",
        onKill: () => process.setExited(true),
      });
      const runner: ProcessRunner = async (request) => {
        if (request.args?.includes("get-state"))
          return result(request, "offline\n", { exitCode: 1 });
        return await fixture.runner(request);
      };
      const dependencies: AvdLifecycleDependencies = {
        runner,
        portAvailable: async () => true,
        spawnEmulator: async () => process,
        clock: () => new Date(now),
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      };
      const prepared = await prepareExistingAvd(
        {
          name: "Pixel_9_API_36",
          emulator: "emulator",
          adb: "adb",
          timeoutMs: 10,
          pollIntervalMs: 10,
          ...(mode === "cancelled" ? { signal: controller.signal } : {}),
        },
        dependencies,
      );
      if (prepared.ok) return {};
      const stopped = prepared.failure.cleanup?.stopped;
      return {
        code: prepared.failure.code,
        ...(stopped === undefined ? {} : { stopped }),
      };
    }

    expect(await failedPreparation("timeout")).toEqual({
      code: "AVD_READINESS_TIMEOUT",
      stopped: true,
    });
    expect(await failedPreparation("cancelled")).toEqual({
      code: "AVD_CANCELLED",
      stopped: true,
    });
    expect(await failedPreparation("exited")).toEqual({
      code: "AVD_EMULATOR_EXITED",
      stopped: true,
    });
  });

  test("uses the bounded production sleeper and directly terminates only an owned process when ADB cleanup fails", async () => {
    const signals: NodeJS.Signals[] = [];
    let exited = false;
    const process: SpawnedEmulator = {
      pid: 4343,
      exited: () => exited,
      kill: (signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") exited = true;
        return true;
      },
      waitForExit: async () => exited,
    };
    const fixture = readyRunner({ devices: "List of devices attached\n" });
    const runner: ProcessRunner = async (request) => {
      if (request.args?.includes("get-state")) return result(request, "offline\n", { exitCode: 1 });
      if (request.args?.includes("kill")) return result(request, "", { exitCode: 1 });
      return await fixture.runner(request);
    };
    const prepared = await prepareExistingAvd(
      {
        name: "Pixel_9_API_36",
        emulator: "emulator",
        adb: "adb",
        timeoutMs: 1,
        pollIntervalMs: 1,
      },
      {
        runner,
        portAvailable: async () => true,
        spawnEmulator: async () => process,
      },
    );

    expect(prepared).toMatchObject({
      ok: false,
      failure: {
        code: "AVD_READINESS_TIMEOUT",
        cleanup: { attempted: true, stopped: true, forced: true },
      },
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("reports spawn failure and validates lifecycle bounds", async () => {
    const fixture = readyRunner({ devices: "List of devices attached\n" });
    const failed = await prepareExistingAvd(
      { name: "Pixel_9_API_36", emulator: "emulator", adb: "adb" },
      {
        runner: fixture.runner,
        portAvailable: async () => true,
        spawnEmulator: async () => {
          throw new Error("fixture spawn failed");
        },
      },
    );
    expect(failed).toMatchObject({
      ok: false,
      failure: { code: "AVD_START_FAILED", detail: "fixture spawn failed" },
    });
    await expect(
      prepareExistingAvd({ name: "", emulator: "emulator", adb: "adb" }),
    ).rejects.toThrow();
  });

  test("production emulator spawner tracks and terminates only its child process", async () => {
    const child = await spawnEmulator({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    });
    expect(child.pid).toBeGreaterThan(0);
    expect(child.exited()).toBe(false);
    expect(await child.waitForExit(5)).toBe(false);
    expect(child.kill("SIGTERM")).toBe(true);
    expect(await child.waitForExit(2_000)).toBe(true);
    expect(child.exited()).toBe(true);
  });
});
