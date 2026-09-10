import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type CliDependencies, type CliInput, type CliIo, runCli } from "../../src/cli/main.js";
import { EventBus } from "../../src/core/event-bus.js";
import { ExitCode } from "../../src/domain/contracts.js";
import type { ProcessRequest, ProcessResult } from "../../src/platform/process-runner.js";
import { SessionRecorder } from "../../src/state/session-store.js";
import type { TextSink } from "../../src/ui/spinner.js";

class MemoryOutput implements TextSink {
  value = "";
  isTTY = false;
  columns = 100;

  write(chunk: string): void {
    this.value += chunk;
  }
}

class FakeInput implements CliInput {
  isTTY = false;
  isRaw = false;
  readonly #listeners = new Set<(chunk: Uint8Array | string) => void>();
  autoInput?: string;
  autoInputs?: string[];

  setRawMode(enabled: boolean): void {
    this.isRaw = enabled;
  }

  resume(): void {}

  pause(): void {}

  on(_event: "data", listener: (chunk: Uint8Array | string) => void): void {
    this.#listeners.add(listener);
    const value = this.autoInputs?.shift() ?? this.autoInput;
    if (value !== undefined) {
      queueMicrotask(() => listener(value));
    }
  }

  off(_event: "data", listener: (chunk: Uint8Array | string) => void): void {
    this.#listeners.delete(listener);
  }
}

interface TestIo extends CliIo {
  input: FakeInput;
  output: MemoryOutput;
  error: MemoryOutput;
}

function io(
  overrides: { inputTTY?: boolean; outputTTY?: boolean; errorTTY?: boolean } = {},
): TestIo {
  const input = new FakeInput();
  input.isTTY = overrides.inputTTY ?? false;
  const output = new MemoryOutput();
  output.isTTY = overrides.outputTTY ?? false;
  const error = new MemoryOutput();
  error.isTTY = overrides.errorTTY ?? false;
  return { input, output, error, cwd: "/project", env: { LANG: "en_US.UTF-8" } };
}

function result(request: ProcessRequest, stdout: string): ProcessResult {
  return {
    executable: request.executable,
    args: [...(request.args ?? [])],
    startedAt: "2026-09-09T10:00:00.000Z",
    finishedAt: "2026-09-09T10:00:00.010Z",
    durationMs: 10,
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
  };
}

function dependencies(devices = "List of devices attached\n"): CliDependencies {
  let id = 0;
  return {
    loadConfig: async (options) => ({
      ok: true,
      config: {
        values: { timeoutMs: 5_000, ...options?.cli },
        provenance: {
          adbPath: undefined,
          adbHost: undefined,
          adbPort: undefined,
          timeoutMs: { source: "default" },
          color: undefined,
          unicode: undefined,
          animation: undefined,
          interactive: undefined,
        },
        files: {},
      },
    }),
    locateAdb: async () => "/sdk/platform-tools/adb",
    detectProject: async () => ({
      root: "/project",
      presetEvidence: [],
      packageManager: { conflicts: [] },
    }),
    readTargetState: async () => ({
      ok: true,
      path: "/state.json",
      document: { version: 1, targets: {} },
    }),
    writeRememberedTarget: async () => ({ ok: true, path: "/state.json" }),
    sessionStore: false,
    runner: async (request) => {
      const args = request.args ?? [];
      if (args.includes("version")) {
        return result(request, "Android Debug Bridge version 1.0.41\nVersion 37.0.0\n");
      }
      if (args.includes("host-features")) {
        return result(request, "shell_v2,server_status\n");
      }
      if (args.includes("server-status")) {
        return result(request, "USB backend: libusb\n");
      }
      return result(request, devices);
    },
    idFactory: () => `id-${String(++id)}`,
    clock: () => new Date("2026-09-09T10:00:00.000Z"),
  };
}

describe("runCli", () => {
  test("keeps bare non-TTY invocation script-safe by showing help without ANSI", async () => {
    const streams = io();
    const exitCode = await runCli([], streams, dependencies());

    expect(exitCode).toBe(ExitCode.Success);
    expect(streams.output.value).toContain("adb-ready [command]");
    expect(streams.output.value).not.toContain("\u001B");
    expect(streams.error.value).toBe("");
  });

  test("keeps a bare interactive session open and returns to a compact menu", async () => {
    const streams = io({ inputTTY: true, outputTTY: true, errorTTY: true });
    streams.env.ADB_READY_REDUCED_MOTION = "1";
    streams.input.autoInputs = ["2\r", "\u001B"];
    const exitCode = await runCli([], streams, dependencies());

    expect(exitCode).toBe(ExitCode.Success);
    expect(streams.error.value).toStartWith("\u001B[2J\u001B[H");
    expect(streams.error.value).toContain("ADB READY");
    expect(streams.error.value).toContain("· doctor");
    expect(streams.error.value).toContain("####");
    expect(streams.error.value).toContain("ACTIONS");
    expect(streams.error.value).toContain("Android setup. No guesswork.");
    expect(streams.input.isRaw).toBe(false);
  });

  test("renders help without loading configuration or ADB", async () => {
    const streams = io();
    const exitCode = await runCli(["--help"], streams, {
      loadConfig: async () => {
        throw new Error("must not load");
      },
    });

    expect(exitCode).toBe(ExitCode.Success);
    expect(streams.output.value).toContain("adb-ready [command]");
    expect(streams.error.value).toBe("");
  });

  test("reads local session history without loading project configuration or ADB", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-cli-session-"));
    try {
      const bus = new EventBus(() => new Date("2026-09-10T10:00:00.000Z"));
      const recorder = await SessionRecorder.create(
        bus,
        {
          sessionId: "session-cli-1",
          command: "dev",
          startedAt: "2026-09-10T10:00:00.000Z",
        },
        { directory, maxAgeDays: 3650 },
      );
      bus.emit({
        type: "session.started",
        source: "session",
        severity: "info",
        message: "Development session started",
        correlation: { commandId: "command-1", sessionId: "session-cli-1" },
      });
      await recorder.finish({
        status: "completed",
        finishedAt: "2026-09-10T10:01:00.000Z",
      });
      const streams = io();
      const fixture: CliDependencies = {
        sessionStore: { directory },
        loadConfig: async () => {
          throw new Error("session history must not load project configuration");
        },
        locateAdb: async () => {
          throw new Error("session history must not locate ADB");
        },
        idFactory: () => "result-1",
        clock: () => new Date("2026-09-10T11:00:00.000Z"),
      };

      const exitCode = await runCli(["sessions", "events", "--json"], streams, fixture);
      const payload = JSON.parse(streams.output.value);
      expect(exitCode).toBe(ExitCode.Success);
      expect(payload.data).toMatchObject({
        action: "events",
        session: { sessionId: "session-cli-1" },
        events: [{ type: "session.started" }],
      });
      expect(streams.error.value).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps JSON stdout to one complete result and stderr empty", async () => {
    const streams = io();
    const exitCode = await runCli(["devices", "--json"], streams, dependencies());

    expect(exitCode).toBe(ExitCode.Success);
    const parsed = JSON.parse(streams.output.value);
    expect(parsed).toMatchObject({ command: "devices", ok: true, data: { devices: [] } });
    expect(streams.output.value.trim().split("\n")).toHaveLength(1);
    expect(streams.output.value).not.toContain("\u001b");
    expect(streams.error.value).toBe("");
  });

  test("sends human progress and the final report to stderr", async () => {
    const streams = io();
    const exitCode = await runCli(["devices", "--no-unicode"], streams, dependencies());

    expect(exitCode).toBe(ExitCode.Success);
    expect(streams.output.value).toBe("");
    expect(streams.error.value).toContain("ADB was found");
    expect(streams.error.value).toContain("ADB Ready · devices");
    expect(streams.error.value).not.toContain("\u001b");
  });

  test("does not change remembered state for a passive device listing", async () => {
    const streams = io();
    const fixture = dependencies("List of devices attached\nUSB-1 device model:Pixel_9\n");
    let writes = 0;
    fixture.writeRememberedTarget = async () => {
      writes += 1;
      return { ok: true, path: "/state.json" };
    };

    const exitCode = await runCli(["devices", "--json", "--non-interactive"], streams, fixture);

    expect(exitCode).toBe(ExitCode.Success);
    expect(writes).toBe(0);
  });

  test("returns parse failures as the same envelope in JSON mode", async () => {
    const streams = io();
    const exitCode = await runCli(["unknown", "--json"], streams, dependencies());
    const parsed = JSON.parse(streams.output.value);

    expect(exitCode).toBe(ExitCode.InvalidInput);
    expect(parsed).toMatchObject({ command: "cli", ok: false });
    expect(parsed.problems[0]).toMatchObject({ code: "CLI_USAGE" });
    expect(parsed.problems[0].correlation.commandId).toBe(parsed.commandId);
    expect(streams.error.value).toBe("");
  });

  test("streams command events followed by one final NDJSON result", async () => {
    const streams = io();
    const exitCode = await runCli(["devices", "--format", "ndjson"], streams, dependencies());
    const records: Array<Record<string, unknown>> = streams.output.value
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line) as Record<string, unknown>);

    expect(exitCode).toBe(ExitCode.Success);
    expect(records.at(-1)).toMatchObject({ kind: "result", command: "devices" });
    expect(records.slice(0, -1).every((record) => record.kind === "event")).toBe(true);
    expect(streams.output.value).not.toContain("\u001b");
  });

  test("uses the interactive picker and records the selected ready target", async () => {
    const streams = io({ inputTTY: true, outputTTY: true, errorTTY: true });
    const input = streams.input;
    input.autoInput = "\r";
    const devices =
      "List of devices attached\n" +
      "usb-1 device model:Pixel_9 transport_id:1\n" +
      "wifi-1 offline model:Pixel_8 transport_id:2\n";
    const fixture = dependencies(devices);
    let remembered: { serial: string; hardwareSerial?: string } | undefined;
    fixture.writeRememberedTarget = async (target) => {
      remembered = target;
      return { ok: true, path: "/state.json" };
    };
    const exitCode = await runCli(
      ["devices", "--select", "--no-animation", "--no-color"],
      streams,
      fixture,
    );

    expect(exitCode).toBe(ExitCode.Success);
    expect(streams.error.value).toContain("Select an Android target");
    expect(streams.error.value).toContain("Pixel 8  · unavailable");
    expect(streams.error.value).toContain("Selected Pixel 9 · usb-1 · device");
    expect(remembered).toMatchObject({ serial: "usb-1" });
    expect(input.isRaw).toBe(false);
  });

  test("classifies unexpected adapter failures without exposing a stack", async () => {
    const streams = io();
    const broken = dependencies();
    broken.runner = async () => {
      throw new Error("adapter exploded");
    };
    const exitCode = await runCli(["devices", "--json"], streams, broken);
    const parsed = JSON.parse(streams.output.value);

    expect(exitCode).toBe(ExitCode.Internal);
    expect(parsed.problems[0]).toMatchObject({
      code: "INTERNAL_ERROR",
      evidence: [{ value: "adapter exploded" }],
    });
    expect(streams.output.value).not.toContain("at runCli");
  });

  test("fails explicit selection before probing ADB in machine mode", async () => {
    const streams = io();
    const exitCode = await runCli(["devices", "--select", "--json"], streams, dependencies());
    const parsed = JSON.parse(streams.output.value);

    expect(exitCode).toBe(ExitCode.InvalidInput);
    expect(parsed.problems[0]?.code).toBe("CLI_USAGE");
  });

  test("returns a target error when selection has no ready device", async () => {
    const streams = io({ inputTTY: true, errorTTY: true });
    const exitCode = await runCli(
      ["devices", "--select", "--no-animation", "--no-color"],
      streams,
      dependencies("List of devices attached\nusb-1 unauthorized model:Pixel_9\n"),
    );

    expect(exitCode).toBe(ExitCode.Target);
    expect(streams.error.value).toContain("has not authorized this computer");
    expect(streams.error.value).toContain("No ready Android target can be selected.");
  });

  test("requires secure stdin for non-interactive pairing before probing ADB", async () => {
    const streams = io();
    const broken = dependencies();
    broken.locateAdb = async () => {
      throw new Error("must not probe ADB");
    };
    const exitCode = await runCli(
      ["pair", "192.168.1.20:41234", "--json", "--non-interactive"],
      streams,
      broken,
    );

    expect(exitCode).toBe(ExitCode.InvalidInput);
    expect(JSON.parse(streams.output.value).problems[0]?.code).toBe("INVALID_PAIRING_CODE");
  });

  test("pairs from stdin without leaking the code to machine output", async () => {
    const streams = io();
    streams.input.autoInput = "123456\n";
    const fixture = dependencies();
    fixture.runner = async (request) => {
      if (request.args?.includes("pair")) {
        expect(request.input).toBe("123456\n");
        return result(request, "Successfully paired to 192.168.1.20:41234\n");
      }
      return result(request, "");
    };
    const exitCode = await runCli(
      ["pair", "192.168.1.20:41234", "--pairing-code-stdin", "--non-interactive", "--json"],
      streams,
      fixture,
    );

    expect(exitCode).toBe(ExitCode.Success);
    expect(JSON.parse(streams.output.value)).toMatchObject({
      command: "pair",
      data: { endpoint: "192.168.1.20:41234", paired: true },
    });
    expect(streams.output.value).not.toContain("123456");
    expect(streams.error.value).toBe("");
  });

  test("remembers only a successfully verified connected serial", async () => {
    const streams = io();
    const fixture = dependencies();
    fixture.runner = async (request) => {
      if (request.args?.includes("connect")) {
        return result(request, "connected to 192.168.1.20:37123\n");
      }
      if (request.args?.includes("get-state")) {
        return result(request, "device\n");
      }
      if (request.args?.includes("ro.serialno")) {
        return result(request, "PHONE-1\n");
      }
      return result(request, "");
    };
    let remembered: { serial: string; hardwareSerial?: string } | undefined;
    fixture.writeRememberedTarget = async (target) => {
      remembered = target;
      return { ok: true, path: "/state.json" };
    };

    const exitCode = await runCli(
      ["connect", "192.168.1.20:37123", "--json", "--non-interactive"],
      streams,
      fixture,
    );

    expect(exitCode).toBe(ExitCode.Success);
    expect(remembered).toMatchObject({
      serial: "192.168.1.20:37123",
      hardwareSerial: "PHONE-1",
    });
  });

  test("resolves --last without falling back to list order", async () => {
    const streams = io();
    const fixture = dependencies(
      "List of devices attached\nUSB-1 device model:Pixel_8\nUSB-2 device model:Pixel_9\n",
    );
    fixture.readTargetState = async () => ({
      ok: true,
      path: "/state.json",
      document: {
        version: 1,
        targets: {
          "local:5037": { serial: "USB-2", updatedAt: "2026-09-09T10:00:00.000Z" },
        },
      },
    });

    const exitCode = await runCli(
      ["devices", "--last", "--json", "--non-interactive"],
      streams,
      fixture,
    );
    const payload = JSON.parse(streams.output.value);

    expect(exitCode).toBe(ExitCode.Success);
    expect(payload.data.selected).toMatchObject({
      reason: "remembered",
      transport: { serial: "USB-2" },
    });
  });

  test("resolves --last by verified hardware identity after a wireless port rotation", async () => {
    const streams = io();
    const fixture = dependencies(
      "List of devices attached\n192.168.1.20:44191 device model:Pixel_9 transport_id:9\n",
    );
    const fallbackRunner = fixture.runner;
    if (fallbackRunner === undefined) {
      throw new Error("fixture runner is required");
    }
    fixture.runner = async (request) =>
      request.args?.includes("ro.serialno")
        ? result(request, "PHONE-1\n")
        : await fallbackRunner(request);
    fixture.readTargetState = async () => ({
      ok: true,
      path: "/state.json",
      document: {
        version: 1,
        targets: {
          "local:5037": {
            serial: "192.168.1.20:37123",
            hardwareSerial: "PHONE-1",
            updatedAt: "2026-09-09T10:00:00.000Z",
          },
        },
      },
    });
    let remembered: { serial: string; hardwareSerial?: string } | undefined;
    fixture.writeRememberedTarget = async (target) => {
      remembered = target;
      return { ok: true, path: "/state.json" };
    };

    const exitCode = await runCli(
      ["devices", "--last", "--json", "--non-interactive"],
      streams,
      fixture,
    );
    const payload = JSON.parse(streams.output.value);

    expect(exitCode).toBe(ExitCode.Success);
    expect(payload.data.selected).toMatchObject({
      reason: "remembered-identity",
      transport: { serial: "192.168.1.20:44191" },
    });
    expect(remembered).toMatchObject({
      serial: "192.168.1.20:44191",
      hardwareSerial: "PHONE-1",
    });
  });

  test("dry-runs pairing without prompting, pairing, or storing state", async () => {
    const streams = io();
    const fixture = dependencies();
    fixture.runner = async () => {
      throw new Error("dry-run must not invoke ADB for an explicit endpoint");
    };
    fixture.writeRememberedTarget = async () => {
      throw new Error("pairing plans must not update remembered state");
    };

    const exitCode = await runCli(
      ["pair", "192.168.1.20:41234", "--dry-run", "--json", "--non-interactive"],
      streams,
      fixture,
    );
    const payload = JSON.parse(streams.output.value);

    expect(exitCode).toBe(ExitCode.Success);
    expect(payload.data.plan).toMatchObject({ dryRun: true, steps: [{ id: "pair" }] });
    expect(streams.error.value).toBe("");
  });

  test("runs a custom dev command with clean JSON and remembers its one target", async () => {
    const streams = io();
    const fixture = dependencies(
      "List of devices attached\nUSB-1 device model:Pixel_9 transport_id:7\n",
    );
    let remembered: { serial: string; hardwareSerial?: string } | undefined;
    fixture.writeRememberedTarget = async (target) => {
      remembered = target;
      return { ok: true, path: "/state.json" };
    };
    fixture.runner = async (request) => {
      const args = request.args ?? [];
      if (args.includes("devices")) {
        return result(
          request,
          "List of devices attached\nUSB-1 device model:Pixel_9 transport_id:7\n",
        );
      }
      if (args.includes("ro.serialno")) return result(request, "PHONE-1\n");
      if (args.includes("host-features")) return result(request, "shell_v2\n");
      if (args.includes("mdns")) {
        return result(request, "List of discovered mdns services\n");
      }
      if (args.includes("--list")) return result(request, "");
      if (request.executable === "node") {
        request.onStdoutChunk?.(new TextEncoder().encode("server ready\n"));
        expect(request.env?.ANDROID_SERIAL).toBe("USB-1");
        return result(request, "server ready\n");
      }
      return result(request, "");
    };

    const exitCode = await runCli(
      ["dev", "--no-logs", "--json", "--non-interactive", "--", "node", "server.mjs"],
      streams,
      fixture,
    );
    const payload = JSON.parse(streams.output.value);

    expect(exitCode).toBe(ExitCode.Success);
    expect(payload).toMatchObject({
      command: "dev",
      ok: true,
      data: {
        preset: "custom",
        selected: { transport: { serial: "USB-1" } },
        command: { executable: "node", args: ["server.mjs"] },
        child: { exitCode: 0 },
      },
    });
    expect(streams.output.value.trim().split("\n")).toHaveLength(1);
    expect(streams.error.value).toBe("");
    expect(remembered).toMatchObject({ serial: "USB-1", hardwareSerial: "PHONE-1" });
  });

  test("dumps package-filtered logs as clean structured JSON", async () => {
    const streams = io();
    const fixture = dependencies(
      "List of devices attached\nUSB-1 device model:Pixel_9 transport_id:7\n",
    );
    const requests: ProcessRequest[] = [];
    fixture.runner = async (request) => {
      requests.push(request);
      const args = request.args ?? [];
      if (args.includes("devices")) {
        return result(
          request,
          "List of devices attached\nUSB-1 device model:Pixel_9 transport_id:7\n",
        );
      }
      if (args.includes("ro.serialno")) return result(request, "PHONE-1\n");
      if (args.includes("host-features")) return result(request, "shell_v2\n");
      if (args.includes("mdns")) return result(request, "List of discovered mdns services\n");
      if (args.includes("pidof")) return result(request, "321\n");
      if (args.includes("logcat")) {
        const output = "09-10 10:00:00.000  321  322 E DemoTag: crash\n";
        request.onStdoutChunk?.(new TextEncoder().encode(output));
        return result(request, output);
      }
      return result(request, "");
    };

    const exitCode = await runCli(
      [
        "logs",
        "--package",
        "com.example.demo",
        "--tag",
        "DemoTag",
        "--level",
        "E",
        "--dump",
        "--json",
        "--non-interactive",
      ],
      streams,
      fixture,
    );
    const payload = JSON.parse(streams.output.value);
    expect(exitCode).toBe(ExitCode.Success);
    expect(payload.data).toMatchObject({
      packageName: "com.example.demo",
      pid: 321,
      filters: ["DemoTag:E", "*:S"],
      records: [{ tag: "DemoTag", priority: "E", message: "crash" }],
    });
    expect(requests.find(({ args }) => args?.includes("logcat"))?.args).toContain("--pid=321");
    expect(streams.error.value).toBe("");
  });

  test("acquires one unambiguous wireless target before starting dev", async () => {
    const streams = io();
    const fixture = dependencies();
    let connected = false;
    const requests: ProcessRequest[] = [];
    fixture.runner = async (request) => {
      requests.push(request);
      const args = request.args ?? [];
      if (args.includes("devices")) {
        return result(
          request,
          connected
            ? "List of devices attached\n192.168.1.20:42000 device model:Pixel_9 transport_id:9\n"
            : "List of devices attached\n",
        );
      }
      if (args.includes("host-features")) return result(request, "shell_v2\n");
      if (args.includes("mdns")) {
        return result(
          request,
          "List of discovered mdns services\nadb-phone _adb-tls-connect._tcp 192.168.1.20:42000\n",
        );
      }
      if (args.includes("connect")) {
        connected = true;
        return result(request, "connected to 192.168.1.20:42000\n");
      }
      if (args.includes("get-state")) return result(request, "device\n");
      if (args.includes("ro.serialno")) return result(request, "PHONE-1\n");
      if (args.includes("--list")) return result(request, "");
      if (request.executable === "node") {
        expect(request.env?.ANDROID_SERIAL).toBe("192.168.1.20:42000");
        return result(request, "ready\n");
      }
      return result(request, "");
    };

    const exitCode = await runCli(
      ["dev", "--no-logs", "--json", "--non-interactive", "--", "node", "server.mjs"],
      streams,
      fixture,
    );
    const payload = JSON.parse(streams.output.value);

    expect(exitCode).toBe(ExitCode.Success);
    expect(payload.data.selected.transport.serial).toBe("192.168.1.20:42000");
    expect(requests.some(({ args }) => args?.includes("connect"))).toBeTrue();
    expect(streams.error.value).toBe("");
  });

  test("automatically uses one discovered endpoint in an interactive connect flow", async () => {
    const streams = io({ inputTTY: true, errorTTY: true });
    const fixture = dependencies();
    fixture.runner = async (request) => {
      if (request.args?.includes("mdns")) {
        return result(
          request,
          "List of discovered mdns services\n" +
            "adb-PHONE-x _adb-tls-connect._tcp 192.168.1.20:37123\n",
        );
      }
      if (request.args?.includes("connect")) {
        return result(request, "connected to 192.168.1.20:37123\n");
      }
      if (request.args?.includes("get-state")) {
        return result(request, "device\n");
      }
      if (request.args?.includes("ro.serialno")) {
        return result(request, "PHONE-1\n");
      }
      return result(request, "");
    };
    fixture.writeRememberedTarget = async () => ({ ok: true, path: "/state.json" });

    const exitCode = await runCli(["connect", "--no-animation", "--no-color"], streams, fixture);

    expect(exitCode).toBe(ExitCode.Success);
    expect(streams.error.value).toContain("Connected 192.168.1.20:37123");
    expect(streams.error.value).toContain("Verified  192.168.1.20:37123 · device");
  });
});
