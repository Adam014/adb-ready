import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  type DeployAndroidArtifactOptions,
  deployAndroidArtifact,
} from "../../src/automation/artifact-deployment.js";
import type { AndroidArtifact } from "../../src/automation/artifact-resolution.js";
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

function apk(overrides: Partial<AndroidArtifact> = {}): AndroidArtifact {
  return {
    kind: "apk",
    files: ["/project/app.apk"],
    applicationId: "com.example.ready",
    versionCode: 42,
    versionName: "1.0.0",
    filters: [],
    provenance: { kind: "explicit", source: "/project/app.apk" },
    ...overrides,
  };
}

function options(artifact: AndroidArtifact): DeployAndroidArtifactOptions {
  return {
    artifact,
    serial: "emulator-5554",
    adb: "/sdk/adb",
    java: "/usr/bin/java",
    bundletool: "/tools/bundletool.jar",
  };
}

function successfulRunner(requests: ProcessRequest[]): ProcessRunner {
  return async (request) => {
    requests.push(request);
    const args = request.args ?? [];
    if (args.includes("dump")) return result(request, "com.example.ready\n");
    if (args.includes("dumpsys")) {
      return result(
        request,
        "Package [com.example.ready]\n codePath=/data/app/base.apk\n versionCode=42\n versionName=1.0.0\n",
      );
    }
    if (args.includes("resolve-activity"))
      return result(request, "com.example.ready/.MainActivity\n");
    return result(request, "Success\n");
  };
}

describe("verified Android artifact deployment", () => {
  test("installs one APK on one serial and independently verifies package, version, and activity", async () => {
    const requests: ProcessRequest[] = [];
    const deployed = await deployAndroidArtifact(options(apk()), {
      runner: successfulRunner(requests),
    });

    expect(deployed).toEqual({
      ok: true,
      deployment: {
        artifactKind: "apk",
        applicationId: "com.example.ready",
        serial: "emulator-5554",
        installed: true,
        launchable: true,
        activity: ".MainActivity",
        versionCode: 42,
        versionName: "1.0.0",
        temporaryApkSetCreated: false,
        temporaryApkSetCleaned: false,
      },
    });
    expect(requests.map(command)).toEqual([
      "/sdk/adb -s emulator-5554 install -r /project/app.apk",
      "/sdk/adb -s emulator-5554 shell dumpsys package com.example.ready",
      "/sdk/adb -s emulator-5554 shell cmd package resolve-activity --brief com.example.ready",
    ]);
  });

  test("installs one explicit split set with caller-selected replacement and permission policy", async () => {
    const requests: ProcessRequest[] = [];
    const artifact = apk({
      kind: "split-apks",
      files: ["/project/base.apk", "/project/config.apk"],
    });
    delete artifact.versionCode;
    delete artifact.versionName;
    const deployed = await deployAndroidArtifact(
      { ...options(artifact), replace: false, grantRuntimePermissions: true },
      { runner: successfulRunner(requests) },
    );
    expect(deployed).toMatchObject({ ok: true, deployment: { artifactKind: "split-apks" } });
    expect(command(requests[0] as ProcessRequest)).toBe(
      "/sdk/adb -s emulator-5554 install-multiple -g /project/base.apk /project/config.apk",
    );
  });

  test("inspects an AAB before mutation, builds for the exact target, installs it, and cleans owned output", async () => {
    const requests: ProcessRequest[] = [];
    const removed: string[] = [];
    const artifact = apk({
      kind: "aab",
      files: ["/project/app.aab"],
    });
    delete artifact.applicationId;
    const deployed = await deployAndroidArtifact(options(artifact), {
      runner: successfulRunner(requests),
      makeTemporaryDirectory: async () => "/tmp/owned-bundle",
      removeTemporaryDirectory: async (directory) => {
        removed.push(directory);
      },
    });

    expect(deployed).toMatchObject({
      ok: true,
      deployment: {
        applicationId: "com.example.ready",
        temporaryApkSetCreated: true,
        temporaryApkSetCleaned: true,
      },
    });
    expect(requests.map(command)).toEqual([
      "/usr/bin/java -jar /tools/bundletool.jar dump manifest --bundle=/project/app.aab --module=base --xpath=/manifest/@package",
      `/usr/bin/java -jar /tools/bundletool.jar build-apks --bundle=/project/app.aab --output=${path.join("/tmp/owned-bundle", "device.apks")} --connected-device --device-id=emulator-5554 --adb=/sdk/adb`,
      `/usr/bin/java -jar /tools/bundletool.jar install-apks --apks=${path.join("/tmp/owned-bundle", "device.apks")} --device-id=emulator-5554 --adb=/sdk/adb`,
      "/sdk/adb -s emulator-5554 shell dumpsys package com.example.ready",
      "/sdk/adb -s emulator-5554 shell cmd package resolve-activity --brief com.example.ready",
    ]);
    expect(removed).toEqual(["/tmp/owned-bundle"]);
  });

  test("installs an existing APK Set without creating or deleting temporary files", async () => {
    const requests: ProcessRequest[] = [];
    let removed = false;
    const artifact = apk({
      kind: "apks",
      files: ["/project/device.apks"],
    });
    delete artifact.versionCode;
    delete artifact.versionName;
    const deployed = await deployAndroidArtifact(options(artifact), {
      runner: successfulRunner(requests),
      removeTemporaryDirectory: async () => {
        removed = true;
      },
    });
    expect(deployed).toMatchObject({
      ok: true,
      deployment: { temporaryApkSetCreated: false, temporaryApkSetCleaned: false },
    });
    expect(command(requests[0] as ProcessRequest)).toContain("install-apks");
    expect(removed).toBe(false);
  });

  test("fails before mutation when identity, tool, permissions, or input evidence is missing", async () => {
    const requests: ProcessRequest[] = [];
    const runner = successfulRunner(requests);
    const noIdentity = apk({
      kind: "apks",
      files: ["/project/app.apks"],
    });
    delete noIdentity.applicationId;
    expect(await deployAndroidArtifact(options(noIdentity), { runner })).toMatchObject({
      ok: false,
      failure: { code: "DEPLOYMENT_IDENTITY_REQUIRED", stage: "identity" },
    });
    const aab = apk({ kind: "aab", files: ["/project/app.aab"] });
    delete aab.applicationId;
    const { java: _java, ...withoutJava } = options(aab);
    expect(await deployAndroidArtifact(withoutJava, { runner })).toMatchObject({
      ok: false,
      failure: { code: "DEPLOYMENT_TOOL_REQUIRED" },
    });
    const withIdentity = options(noIdentity);
    const { bundletool: _bundletool, ...withoutBundletool } = withIdentity;
    expect(
      await deployAndroidArtifact(
        { ...withoutBundletool, applicationId: "com.example.ready" },
        { runner },
      ),
    ).toMatchObject({ ok: false, failure: { code: "DEPLOYMENT_TOOL_REQUIRED" } });
    expect(
      await deployAndroidArtifact(
        {
          ...options({ ...noIdentity, applicationId: "com.example.ready" }),
          grantRuntimePermissions: true,
        },
        { runner },
      ),
    ).toMatchObject({ ok: false, failure: { code: "DEPLOYMENT_INVALID_INPUT" } });
    expect(
      await deployAndroidArtifact({ ...options(apk()), serial: " bad\nserial" }, { runner }),
    ).toMatchObject({ ok: false, failure: { code: "DEPLOYMENT_INVALID_INPUT" } });
    expect(requests).toHaveLength(0);
  });

  test("rejects conflicting identities, malformed artifact sets, and invalid bundle tools before mutation", async () => {
    const requests: ProcessRequest[] = [];
    const runner = successfulRunner(requests);

    expect(
      await deployAndroidArtifact(
        { ...options(apk()), applicationId: "com.example.other" },
        { runner },
      ),
    ).toMatchObject({
      ok: false,
      failure: { code: "DEPLOYMENT_IDENTITY_CONFLICT", stage: "identity" },
    });
    expect(
      await deployAndroidArtifact(
        options(apk({ kind: "split-apks", files: ["/project/base.apk"] })),
        { runner },
      ),
    ).toMatchObject({ ok: false, failure: { code: "DEPLOYMENT_INVALID_INPUT" } });
    expect(
      await deployAndroidArtifact(options(apk({ kind: "apk", files: ["/project/app.aab"] })), {
        runner,
      }),
    ).toMatchObject({ ok: false, failure: { code: "DEPLOYMENT_INVALID_INPUT" } });
    expect(
      await deployAndroidArtifact(
        {
          ...options(apk({ kind: "apks", files: ["/project/device.apks"] })),
          java: "bad\njava",
        },
        { runner },
      ),
    ).toMatchObject({ ok: false, failure: { code: "DEPLOYMENT_INVALID_INPUT" } });
    expect(
      await deployAndroidArtifact(
        {
          ...options(apk({ kind: "apks", files: ["/project/device.apks"] })),
          replace: false,
        },
        { runner },
      ),
    ).toMatchObject({ ok: false, failure: { code: "DEPLOYMENT_INVALID_INPUT" } });
    expect(requests).toHaveLength(0);
  });

  test("rejects unreadable or conflicting AAB identity before build and install", async () => {
    const artifact = apk({ kind: "aab", files: ["/project/app.aab"] });
    const unreadable: ProcessRunner = async (request) => result(request, "", { exitCode: 1 });
    expect(await deployAndroidArtifact(options(artifact), { runner: unreadable })).toMatchObject({
      ok: false,
      failure: { code: "DEPLOYMENT_BUILD_FAILED", stage: "identity" },
    });
    const conflicting: ProcessRunner = async (request) => result(request, "com.other.app\n");
    expect(await deployAndroidArtifact(options(artifact), { runner: conflicting })).toMatchObject({
      ok: false,
      failure: { code: "DEPLOYMENT_IDENTITY_CONFLICT" },
    });
  });

  test("accepts bundletool XML manifest output and keeps runner exceptions structured", async () => {
    const requests: ProcessRequest[] = [];
    const artifact = apk({ kind: "aab", files: ["/project/app.aab"] });
    delete artifact.applicationId;
    const xmlRunner: ProcessRunner = async (request) => {
      requests.push(request);
      if (request.args?.includes("dump"))
        return result(request, '<manifest package="com.example.ready" />\n');
      return successfulRunner([])(request);
    };
    expect(
      await deployAndroidArtifact(options(artifact), {
        runner: xmlRunner,
        makeTemporaryDirectory: async () => "/tmp/xml-manifest",
        removeTemporaryDirectory: async () => undefined,
      }),
    ).toMatchObject({ ok: true, deployment: { applicationId: "com.example.ready" } });

    const throwing: ProcessRunner = async () => {
      throw new Error("fixture spawn denied");
    };
    expect(await deployAndroidArtifact(options(apk()), { runner: throwing })).toMatchObject({
      ok: false,
      failure: { code: "DEPLOYMENT_INSTALL_FAILED", detail: "fixture spawn denied" },
    });
  });

  test("classifies direct and bundle installation failures without claiming verification", async () => {
    const direct: ProcessRunner = async (request) =>
      result(request, "", { exitCode: 1, stderr: "INSTALL_FAILED_VERSION_DOWNGRADE" });
    expect(await deployAndroidArtifact(options(apk()), { runner: direct })).toMatchObject({
      ok: false,
      failure: { code: "DEPLOYMENT_INSTALL_FAILED", detail: "INSTALL_FAILED_VERSION_DOWNGRADE" },
    });

    const requests: ProcessRequest[] = [];
    const bundle: ProcessRunner = async (request) => {
      requests.push(request);
      if (request.args?.includes("dump")) return result(request, "com.example.ready\n");
      if (request.args?.includes("build-apks"))
        return result(request, "", { exitCode: 1, timedOut: true });
      throw new Error("Install must not run after a failed build");
    };
    const aab = apk({ kind: "aab", files: ["/project/app.aab"] });
    expect(
      await deployAndroidArtifact(options(aab), {
        runner: bundle,
        makeTemporaryDirectory: async () => "/tmp/owned-failure",
        removeTemporaryDirectory: async () => undefined,
      }),
    ).toMatchObject({
      ok: false,
      failure: {
        code: "DEPLOYMENT_BUILD_FAILED",
        detail: "The operation exceeded its bounded timeout.",
      },
    });
    expect(requests.some((request) => request.args?.includes("install-apks"))).toBe(false);
  });

  test("rejects package, version, and launchability postcondition failures", async () => {
    const fixtures: Array<{ stdout: string; activity?: string; expected: string }> = [
      { stdout: "", expected: "package" },
      {
        stdout:
          "Package [com.example.ready]\n codePath=/data/app/base.apk\n versionCode=41\n versionName=1.0.0\n",
        expected: "version code",
      },
      {
        stdout:
          "Package [com.example.ready]\n codePath=/data/app/base.apk\n versionCode=42\n versionName=0.9.0\n",
        expected: "version name",
      },
      {
        stdout:
          "Package [com.example.ready]\n codePath=/data/app/base.apk\n versionCode=42\n versionName=1.0.0\n",
        activity: "com.other.app/.Main\n",
        expected: "launch activity",
      },
    ];
    for (const fixture of fixtures) {
      const runner: ProcessRunner = async (request) => {
        const args = request.args ?? [];
        if (args.includes("dumpsys")) return result(request, fixture.stdout);
        if (args.includes("resolve-activity")) return result(request, fixture.activity ?? "");
        return result(request, "Success\n");
      };
      const deployed = await deployAndroidArtifact(options(apk()), { runner });
      expect(deployed).toMatchObject({
        ok: false,
        failure: { code: "DEPLOYMENT_VERIFICATION_FAILED" },
      });
      if (!deployed.ok) expect(deployed.failure.summary.toLowerCase()).toContain(fixture.expected);
    }
  });

  test("reports owned temporary cleanup failures even after a successful bundle install", async () => {
    const artifact = apk({ kind: "aab", files: ["/project/app.aab"] });
    const deployed = await deployAndroidArtifact(options(artifact), {
      runner: successfulRunner([]),
      makeTemporaryDirectory: async () => "/tmp/owned-cleanup",
      removeTemporaryDirectory: async () => {
        throw new Error("fixture cleanup denied");
      },
    });
    expect(deployed).toMatchObject({
      ok: false,
      failure: { code: "DEPLOYMENT_CLEANUP_FAILED", stage: "cleanup" },
    });
  });
});
