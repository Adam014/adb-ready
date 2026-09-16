import { describe, expect, test } from "bun:test";
import path from "node:path";
import { capability, detectAndroidCapabilities } from "../../src/automation/capabilities.js";
import type { ProcessRequest, ProcessResult } from "../../src/platform/process-runner.js";

function fixture(options: {
  directories?: readonly string[];
  files?: Readonly<Record<string, string>>;
  executables?: Readonly<Record<string, string>>;
}) {
  const directories = new Set(options.directories ?? []);
  const files = options.files ?? {};
  return {
    directoryAvailable: async (candidate: string) => directories.has(candidate),
    fileAvailable: async (candidate: string) => Object.hasOwn(files, candidate),
    readText: async (candidate: string) => files[candidate] ?? "",
    locate: async (name: string) => options.executables?.[name],
  };
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
  const executable = path.posix.basename(request.executable.replaceAll("\\", "/")).toLowerCase();
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
    const home = "/Users/fixture";
    const sdk = path.posix.join(home, "Library", "Android", "sdk");
    const bin = path.posix.join(home, "bin");
    const files = Object.fromEntries(
      [
        path.posix.join(sdk, "emulator", "emulator"),
        path.posix.join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"),
        path.posix.join(bin, "android"),
        path.posix.join(bin, "bundletool"),
        path.posix.join(bin, "java"),
        path.posix.join(bin, "maestro"),
      ].map((candidate) => [candidate, ""]),
    );

    const detected = await detectAndroidCapabilities({
      cwd: home,
      env: { PATH: bin },
      homeDirectory: home,
      platform: "darwin",
      verifier: { executable: "maestro", args: ["test", "flow.yaml"] },
      runner: versionRunner,
      ...fixture({
        directories: [sdk],
        files,
        executables: {
          android: path.posix.join(bin, "android"),
          bundletool: path.posix.join(bin, "bundletool"),
          java: path.posix.join(bin, "java"),
          maestro: path.posix.join(bin, "maestro"),
        },
      }),
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
    const home = "/home/fixture";
    const sdk = path.posix.join(home, "Android", "Sdk");
    const detected = await detectAndroidCapabilities({
      cwd: home,
      env: { PATH: "" },
      homeDirectory: home,
      platform: "linux",
      runner: versionRunner,
      ...fixture({ directories: [sdk] }),
    });

    expect(detected.sdk).toMatchObject({ status: "supported", root: sdk });
    expect(capability(detected, "emulator").status).toBe("unavailable");
    expect(capability(detected, "external-verifier").status).toBe("unverified");
  });

  test("models Windows SDK paths without requiring POSIX executable bits", async () => {
    const localAppData = path.win32.join("C:\\Users\\fixture", "AppData", "Local");
    const sdk = path.win32.join(localAppData, "Android", "Sdk");
    const detected = await detectAndroidCapabilities({
      cwd: "C:\\workspace",
      env: { LOCALAPPDATA: localAppData, PATH: "" },
      homeDirectory: "C:\\Users\\fixture",
      platform: "win32",
      runner: versionRunner,
      ...fixture({}),
    });

    expect(detected.sdk).toMatchObject({
      status: "unavailable",
      candidates: [sdk],
    });
    expect(capability(detected, "emulator").status).toBe("unavailable");
  });

  test("fails closed when Android SDK environment roots conflict", async () => {
    const root = "/workspace";
    const first = "/workspace/sdk-a";
    const second = "/workspace/sdk-b";

    const detected = await detectAndroidCapabilities({
      cwd: root,
      env: { ANDROID_HOME: first, ANDROID_SDK_ROOT: second, PATH: "" },
      homeDirectory: root,
      platform: "linux",
      runner: versionRunner,
      ...fixture({ directories: [first, second] }),
    });

    expect(detected.sdk).toMatchObject({
      status: "incompatible",
      candidates: [first, second, path.posix.join(root, "Android", "Sdk")],
    });
    expect(detected.sdk.next).toContain("canonical Android SDK root");
  });

  test("distinguishes incompatible and unverified tool versions", async () => {
    const root = "/workspace";
    const android = "/tools/android";
    const java = "/tools/java";
    const detected = await detectAndroidCapabilities({
      cwd: root,
      env: { PATH: "/tools" },
      homeDirectory: root,
      platform: "linux",
      runner: async (request) =>
        path.posix.basename(request.executable.replaceAll("\\", "/")) === "android"
          ? result(request, "Android CLI 0.9.0\n")
          : result(request, "Java runtime without a parseable version\n"),
      ...fixture({
        files: { [android]: "", [java]: "" },
        executables: { android, java },
      }),
    });

    expect(capability(detected, "android-cli")).toMatchObject({
      status: "incompatible",
      version: "0.9.0",
    });
    expect(capability(detected, "java").status).toBe("unverified");
  });

  test("accepts Java's legacy 1.8 version notation as Java 8", async () => {
    const root = "/workspace";
    const java = "/tools/java";

    const detected = await detectAndroidCapabilities({
      cwd: root,
      env: { PATH: "" },
      homeDirectory: root,
      platform: "linux",
      explicit: { java },
      runner: async (request) => result(request, "", 'java version "1.8.0_442"\n'),
      ...fixture({ files: { [java]: "" } }),
    });

    expect(capability(detected, "java")).toMatchObject({
      status: "supported",
      version: "1.8.0",
    });
  });

  test("reads Gradle wrapper metadata without executing the wrapper", async () => {
    const root = "/workspace";
    const wrapper = path.posix.join(root, "gradlew");
    const properties = path.posix.join(root, "gradle", "wrapper", "gradle-wrapper.properties");
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
      ...fixture({
        files: {
          [wrapper]: "",
          [properties]:
            "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.7.1-bin.zip\n",
        },
      }),
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
