import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { capability, detectAndroidCapabilities } from "../../src/automation/capabilities.js";
import type { ProcessRequest, ProcessResult } from "../../src/platform/process-runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-capabilities-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function file(name: string, executable = true): Promise<void> {
  await mkdir(path.dirname(name), { recursive: true });
  await writeFile(name, "fixture\n");
  if (executable && process.platform !== "win32") await chmod(name, 0o755);
}

function result(request: ProcessRequest, stdout: string, stderr = ""): ProcessResult {
  return {
    executable: request.executable,
    args: [...(request.args ?? [])],
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.001Z",
    durationMs: 1,
    exitCode: 0,
    signal: null,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    stoppedAfterIdle: false,
    killEscalated: false,
  };
}

function versionRunner(request: ProcessRequest): Promise<ProcessResult> {
  const executable = path.basename(request.executable).toLowerCase();
  if (executable.startsWith("emulator")) {
    return Promise.resolve(result(request, "Android emulator version 36.4.10.0\n"));
  }
  if (executable.startsWith("android")) {
    return Promise.resolve(result(request, "Android CLI 1.0.16261425\n"));
  }
  if (executable.startsWith("java")) {
    return Promise.resolve(result(request, "", 'openjdk version "17.0.18"\n'));
  }
  if (executable.startsWith("gradle")) {
    return Promise.resolve(result(request, "Gradle 9.7.1\n"));
  }
  if (executable.startsWith("bundletool")) {
    return Promise.resolve(result(request, "1.18.3\n"));
  }
  throw new Error(`Unexpected probe: ${request.executable}`);
}

describe("Android capability detection", () => {
  test("resolves the canonical macOS SDK and optional tools deterministically", async () => {
    const home = await temporaryDirectory();
    const sdk = path.join(home, "Library", "Android", "sdk");
    const bin = path.join(home, "bin");
    await Promise.all([
      file(path.join(sdk, "emulator", "emulator")),
      file(path.join(sdk, "cmdline-tools", "latest", "bin", "avdmanager")),
      file(path.join(bin, "android")),
      file(path.join(bin, "bundletool")),
      file(path.join(bin, "java")),
      file(path.join(bin, "maestro")),
    ]);

    const detected = await detectAndroidCapabilities({
      cwd: home,
      env: { PATH: bin },
      homeDirectory: home,
      platform: "darwin",
      verifier: { executable: "maestro", args: ["test", "flow.yaml"] },
      runner: versionRunner,
    });

    expect(detected.sdk).toMatchObject({ status: "supported", root: sdk });
    expect(capability(detected, "emulator")).toMatchObject({
      status: "supported",
      source: "sdk",
      version: "36.4.10.0",
    });
    expect(capability(detected, "android-cli")).toMatchObject({
      status: "supported",
      version: "1.0.16261425",
    });
    expect(capability(detected, "external-verifier")).toMatchObject({
      status: "supported",
      invocation: { argsPrefix: ["test", "flow.yaml"] },
    });
  });

  test("uses the canonical Linux fallback without inventing a missing SDK", async () => {
    const home = await temporaryDirectory();
    const sdk = path.join(home, "Android", "Sdk");
    await mkdir(sdk, { recursive: true });
    const detected = await detectAndroidCapabilities({
      cwd: home,
      env: { PATH: "" },
      homeDirectory: home,
      platform: "linux",
      runner: versionRunner,
    });

    expect(detected.sdk).toMatchObject({ status: "supported", root: sdk });
    expect(capability(detected, "emulator").status).toBe("unavailable");
    expect(capability(detected, "external-verifier").status).toBe("unverified");
  });

  test("models Windows SDK paths without requiring POSIX executable bits", async () => {
    const root = await temporaryDirectory();
    const localAppData = path.win32.join("C:\\Users\\fixture", "AppData", "Local");
    const sdk = path.win32.join(localAppData, "Android", "Sdk");
    const detected = await detectAndroidCapabilities({
      cwd: root,
      env: { LOCALAPPDATA: localAppData, PATH: "" },
      homeDirectory: "C:\\Users\\fixture",
      platform: "win32",
      runner: versionRunner,
    });

    expect(detected.sdk).toMatchObject({
      status: "unavailable",
      candidates: [sdk],
    });
    expect(capability(detected, "emulator").status).toBe("unavailable");
  });

  test("fails closed when Android SDK environment roots conflict", async () => {
    const root = await temporaryDirectory();
    const first = path.join(root, "sdk-a");
    const second = path.join(root, "sdk-b");
    await Promise.all([mkdir(first), mkdir(second)]);

    const detected = await detectAndroidCapabilities({
      cwd: root,
      env: { ANDROID_HOME: first, ANDROID_SDK_ROOT: second, PATH: "" },
      homeDirectory: root,
      platform: "linux",
      runner: versionRunner,
    });

    expect(detected.sdk).toMatchObject({
      status: "incompatible",
      candidates: [first, second, path.join(root, "Android", "Sdk")],
    });
    expect(detected.sdk.next).toContain("canonical Android SDK root");
  });

  test("distinguishes incompatible and unverified tool versions", async () => {
    const root = await temporaryDirectory();
    const bin = path.join(root, "bin");
    await Promise.all([file(path.join(bin, "android")), file(path.join(bin, "java"))]);
    const detected = await detectAndroidCapabilities({
      cwd: root,
      env: { PATH: bin },
      homeDirectory: root,
      platform: "linux",
      runner: async (request) =>
        path.basename(request.executable) === "android"
          ? result(request, "Android CLI 0.9.0\n")
          : result(request, "Java runtime without a parseable version\n"),
    });

    expect(capability(detected, "android-cli")).toMatchObject({
      status: "incompatible",
      version: "0.9.0",
    });
    expect(capability(detected, "java").status).toBe("unverified");
  });

  test("accepts Java's legacy 1.8 version notation as Java 8", async () => {
    const root = await temporaryDirectory();
    const java = path.join(root, "java");
    await file(java);

    const detected = await detectAndroidCapabilities({
      cwd: root,
      env: { PATH: "" },
      homeDirectory: root,
      platform: "linux",
      explicit: { java },
      runner: async (request) => result(request, "", 'java version "1.8.0_442"\n'),
    });

    expect(capability(detected, "java")).toMatchObject({
      status: "supported",
      version: "1.8.0",
    });
  });

  test("reads Gradle wrapper metadata without executing the wrapper", async () => {
    const root = await temporaryDirectory();
    const wrapper = path.join(root, "gradlew");
    await Promise.all([
      file(wrapper),
      file(path.join(root, "gradle", "wrapper", "gradle-wrapper.properties"), false),
    ]);
    await writeFile(
      path.join(root, "gradle", "wrapper", "gradle-wrapper.properties"),
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.7.1-bin.zip\n",
    );
    let probes = 0;
    const detected = await detectAndroidCapabilities({
      cwd: root,
      env: { PATH: "" },
      homeDirectory: root,
      platform: "linux",
      runner: async (request) => {
        probes += 1;
        return result(request, "");
      },
    });

    expect(capability(detected, "gradle")).toMatchObject({
      status: "supported",
      source: "project",
      version: "9.7.1",
      path: wrapper,
    });
    expect(probes).toBe(0);
  });
});
