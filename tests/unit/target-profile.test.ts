import { describe, expect, test } from "bun:test";
import {
  type InspectTargetProfileOptions,
  inspectAndroidTargetProfile,
} from "../../src/automation/target-profile.js";
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

const options: InspectTargetProfileOptions = {
  adb: "/sdk/adb",
  serial: "emulator-5554",
};

describe("Android target profile", () => {
  test("reads ABI preference, effective density, and full plus language locales from one target", async () => {
    const commands: string[] = [];
    const runner: ProcessRunner = async (request) => {
      commands.push([request.executable, ...(request.args ?? [])].join(" "));
      const property = request.args?.at(-1);
      if (property === "ro.product.cpu.abilist") return result(request, "arm64-v8a,armeabi-v7a\n");
      if (property === "persist.sys.locale") return result(request, "cs-CZ\n");
      if (request.args?.includes("density"))
        return result(request, "Physical density: 420\nOverride density: 480\n");
      throw new Error(`Unexpected profile probe: ${String(property)}`);
    };

    expect(await inspectAndroidTargetProfile(options, runner)).toEqual({
      ok: true,
      profile: {
        serial: "emulator-5554",
        abis: ["arm64-v8a", "armeabi-v7a"],
        density: "480",
        locales: ["cs-CZ", "cs"],
      },
    });
    expect(commands).toHaveLength(3);
    expect(commands.every((command) => command.includes("-s emulator-5554"))).toBe(true);
  });

  test("falls back to legacy ABI and product locale without inventing optional density", async () => {
    const runner: ProcessRunner = async (request) => {
      const property = request.args?.at(-1);
      if (property === "ro.product.cpu.abilist") return result(request, "\n");
      if (property === "ro.product.cpu.abi") return result(request, "x86_64\n");
      if (property === "persist.sys.locale") return result(request, "\n");
      if (property === "ro.product.locale") return result(request, "en_US\n");
      if (request.args?.includes("density")) return result(request, "unavailable\n");
      throw new Error("Unexpected profile probe");
    };
    expect(await inspectAndroidTargetProfile(options, runner)).toEqual({
      ok: true,
      profile: {
        serial: "emulator-5554",
        abis: ["x86_64"],
        locales: ["en-US", "en"],
      },
    });
  });

  test("fails closed for invalid input, failed ABI probes, and empty ABI evidence", async () => {
    const unused: ProcessRunner = async () => {
      throw new Error("runner must not be called");
    };
    expect(
      await inspectAndroidTargetProfile({ ...options, serial: "bad serial" }, unused),
    ).toMatchObject({ ok: false, failure: { code: "TARGET_PROFILE_INVALID_INPUT" } });

    const failed: ProcessRunner = async (request) =>
      result(request, "", { exitCode: 1, stderr: "device offline" });
    expect(await inspectAndroidTargetProfile(options, failed)).toMatchObject({
      ok: false,
      failure: { code: "TARGET_PROFILE_UNAVAILABLE", detail: "device offline" },
    });

    const empty: ProcessRunner = async (request) => result(request, "\n");
    expect(await inspectAndroidTargetProfile(options, empty)).toMatchObject({
      ok: false,
      failure: { code: "TARGET_PROFILE_UNAVAILABLE", summary: expect.stringContaining("ABI") },
    });
  });
});
