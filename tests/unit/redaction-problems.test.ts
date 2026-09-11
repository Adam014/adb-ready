import { describe, expect, test } from "bun:test";
import { redactText } from "../../src/core/redaction.js";
import {
  adbProcessProblem,
  multipleTargetsProblem,
  noTargetsProblem,
  ProblemCode,
  problemsForDevices,
  problemsForServerStatus,
  targetInventoryProblems,
  targetSelectionProblem,
} from "../../src/domain/problems.js";
import type { ProcessResult } from "../../src/platform/process-runner.js";
import type { AndroidTarget } from "../../src/target/model.js";

function failedProcess(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    executable: "adb",
    args: ["devices", "-l"],
    startedAt: "2026-09-09T10:00:00.000Z",
    finishedAt: "2026-09-09T10:00:01.000Z",
    durationMs: 1_000,
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "adb failed",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    stoppedAfterIdle: false,
    killEscalated: false,
    ...overrides,
  };
}

describe("redactText", () => {
  test("redacts common credentials, pairing codes, URL secrets, and home paths", () => {
    const input =
      "Authorization: Bearer abc.def pairing code=123456 " +
      "api_key='top-secret' https://example.test/?token=query-secret " +
      "/Users/example/project";
    const result = redactText(input, { homeDirectory: "/Users/example" });

    expect(result.value).not.toContain("abc.def");
    expect(result.value).not.toContain("123456");
    expect(result.value).not.toContain("top-secret");
    expect(result.value).not.toContain("query-secret");
    expect(result.value).toContain("~/project");
    expect(result.replacements).toBe(5);
  });

  test("does not redact unrelated six-digit values", () => {
    expect(redactText("build 149108 and port 8081", { homeDirectory: "/none" }).value).toBe(
      "build 149108 and port 8081",
    );
  });
});

describe("problem classification", () => {
  const target = (overrides: Partial<AndroidTarget> = {}): AndroidTarget => ({
    id: "target-1",
    serial: "USB-1",
    state: "device",
    name: "Pixel 9",
    transports: [{ serial: "USB-1", state: "device", kind: "usb", stable: true }],
    ...overrides,
  });

  test("classifies a timeout from structured process state", () => {
    const problem = adbProcessProblem(
      "devices",
      failedProcess({ timedOut: true, signal: "SIGTERM" }),
      { commandId: "command-1", operationId: "operation-1" },
    );
    expect(problem.code).toBe(ProblemCode.AdbTimeout);
    expect(problem.evidence).toContainEqual({
      source: "process",
      field: "timedOut",
      value: true,
    });
  });

  test("classifies an interrupted process before generic ADB failures", () => {
    const problem = adbProcessProblem(
      "devices",
      failedProcess({ aborted: true, signal: "SIGTERM" }),
      { commandId: "command-1", operationId: "operation-1" },
    );

    expect(problem.code).toBe(ProblemCode.OperationInterrupted);
    expect(problem.category).toBe("process.interrupted");
  });

  test("classifies a daemon failure without treating every stderr line as a category", () => {
    const daemon = adbProcessProblem(
      "devices",
      failedProcess({ stderr: "cannot connect to daemon at tcp:5037" }),
      { commandId: "command-1" },
    );
    const generic = adbProcessProblem("devices", failedProcess({ stderr: "a future failure" }), {
      commandId: "command-1",
    });

    expect(daemon.code).toBe(ProblemCode.AdbServerUnavailable);
    expect(generic.code).toBe(ProblemCode.AdbCommandFailed);
  });

  test("classifies a command missing from an older ADB build", () => {
    const problem = adbProcessProblem(
      "pair",
      failedProcess({ stderr: "adb: unknown command pair" }),
      { commandId: "command-1" },
    );

    expect(problem).toMatchObject({
      code: ProblemCode.AdbFeatureUnavailable,
      category: "environment.compatibility",
      severity: "error",
    });
    expect(problem.actions[0]).toMatchObject({
      id: "update_platform_tools",
      automatic: false,
    });
  });

  test("diagnoses disabled mDNS and a mismatched running ADB server", () => {
    const problems = problemsForServerStatus(
      { mdns_enabled: "false", version: '"36.0.0"' },
      "37.0.0-14910828",
      { commandId: "command-1", operationId: "operation-1" },
    );

    expect(problems.map(({ code }) => code)).toEqual([
      ProblemCode.AdbMdnsDisabled,
      ProblemCode.AdbVersionMismatch,
    ]);
    expect(problems.every(({ severity }) => severity === "warning")).toBe(true);
    expect(problems.every(({ actions }) => actions[0]?.risk === "shared-global")).toBe(true);
  });

  test("does not warn for a healthy matching ADB server", () => {
    expect(
      problemsForServerStatus({ mdns_enabled: "true", version: '"37.0.0"' }, "37.0.0-14910828", {
        commandId: "command-1",
      }),
    ).toEqual([]);
  });

  test("redacts process evidence before attaching it to a problem", () => {
    const problem = adbProcessProblem(
      "devices",
      failedProcess({ stderr: "Authorization=secret-value" }),
      { commandId: "command-1" },
    );
    const stderr = problem.evidence.find(({ field }) => field === "stderr");

    expect(stderr?.value).toBe("Authorization=[REDACTED]");
    expect(stderr?.redacted).toBe(true);
  });

  test("creates explicit problems for unsafe target states", () => {
    const problems = problemsForDevices(
      [
        { serial: "usb-1", state: "unauthorized", properties: {}, unparsed: [] },
        { serial: "wifi-1", state: "offline", properties: {}, unparsed: [] },
        { serial: "future-1", state: "unknown", properties: {}, unparsed: [] },
      ],
      { commandId: "command-1" },
    );

    expect(problems.map(({ code }) => code)).toEqual([
      ProblemCode.TargetUnauthorized,
      ProblemCode.TargetOffline,
      ProblemCode.TargetUnknownState,
    ]);
  });

  test("recommends pairing rather than connecting a pairing-only service", () => {
    const problem = noTargetsProblem({ commandId: "command-1" }, [
      {
        instance: "adb-PHONE-1-x",
        rawServiceType: "_adb-tls-pairing._tcp",
        serviceType: "pairing",
        endpoint: {
          host: "192.168.1.20",
          port: 41234,
          serial: "192.168.1.20:41234",
          version: 4,
        },
      },
    ]);

    expect(problem.detail).toContain("adb-ready pair 192.168.1.20:41234");
    expect(problem.actions[0]).toMatchObject({
      id: "pair_discovered_target",
      risk: "device-reversible",
      automatic: false,
    });
  });

  test("turns every unsafe selection outcome into deterministic guidance", () => {
    const ready = target();
    const offline = target({
      state: "offline",
      transports: [{ serial: "USB-1", state: "offline", kind: "usb", stable: true }],
    });
    const duplicate = target({
      transports: [
        { serial: "USB-1", state: "device", kind: "usb", stable: true, transportId: "1" },
        { serial: "USB-1", state: "device", kind: "usb", stable: true, transportId: "2" },
      ],
    });
    const correlation = { commandId: "command-1" };
    const problems = [
      targetSelectionProblem({ kind: "ambiguous", candidates: [ready] }, correlation),
      targetSelectionProblem(
        { kind: "duplicate", target: duplicate, transports: duplicate.transports },
        correlation,
      ),
      targetSelectionProblem({ kind: "not-found", selector: "missing" }, correlation),
      targetSelectionProblem({ kind: "unavailable", target: offline }, correlation),
      targetSelectionProblem({ kind: "none" }, correlation),
    ];
    expect(problems.map(({ code }) => code)).toEqual([
      ProblemCode.MultipleTargets,
      ProblemCode.DuplicateTargetTransport,
      ProblemCode.TargetNotFound,
      ProblemCode.NoSelectableTarget,
      ProblemCode.NoSelectableTarget,
    ]);
    expect(problems.every(({ correlation: value }) => value === correlation)).toBeTrue();
  });

  test("detects unstable and duplicate target transports from inventory evidence", () => {
    const unstable = target({
      id: "unstable",
      serial: "service._adb-tls-connect._tcp",
      transports: [
        {
          serial: "service._adb-tls-connect._tcp",
          state: "device",
          kind: "unknown",
          stable: false,
        },
      ],
    });
    const duplicate = target({
      id: "duplicate",
      transports: [
        { serial: "USB-1", state: "device", kind: "usb", stable: true, transportId: "1" },
        { serial: "USB-1", state: "device", kind: "usb", stable: true, transportId: "2" },
      ],
    });
    const problems = targetInventoryProblems([unstable, duplicate], { commandId: "command-1" });
    expect(problems.map(({ code }) => code)).toEqual([
      ProblemCode.UnstableTargetSerial,
      ProblemCode.DuplicateTargetTransport,
    ]);
    expect(problems.every(({ severity }) => severity === "warning")).toBeTrue();
  });

  test("classifies host permission failures and exposes explicit multi-target selection", () => {
    const devices = [
      { serial: "usb-1", state: "no-permissions" as const, properties: {}, unparsed: [] },
      { serial: "usb-2", state: "device" as const, properties: {}, unparsed: [] },
    ];
    const permission = problemsForDevices(devices, { commandId: "command-1" }, "warning");
    expect(permission).toMatchObject([
      {
        code: ProblemCode.TargetNoPermissions,
        severity: "warning",
        actions: [{ id: "review_usb_permissions", kind: "documentation" }],
      },
    ]);
    expect(multipleTargetsProblem(devices, { commandId: "command-1" })).toMatchObject({
      code: ProblemCode.MultipleTargets,
      evidence: [{ value: ["usb-1", "usb-2"] }],
      actions: [{ id: "select_target" }],
    });
  });

  test("maps a missing ADB executable to setup guidance", () => {
    const problem = adbProcessProblem(
      "devices",
      failedProcess({ spawnError: { code: "ENOENT", message: "not found" } }),
      { commandId: "command-1" },
    );
    expect(problem).toMatchObject({
      code: ProblemCode.AdbNotFound,
      evidence: [{ source: "configuration", field: "adb.path", value: "adb" }],
      actions: [{ id: "configure_adb_path" }],
    });
  });
});
