import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type FirebaseTestLabOptions,
  parseFirebaseCatalog,
  parseFirebaseDevice,
  runFirebaseTestLab,
} from "../../src/automation/firebase-test-lab.js";
import type { ProcessRequest, ProcessResult } from "../../src/platform/process-runner.js";

function result(request: ProcessRequest, overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    executable: request.executable,
    args: [...(request.args ?? [])],
    startedAt: "2026-09-27T10:00:00.000Z",
    finishedAt: "2026-09-27T10:00:01.000Z",
    durationMs: 1_000,
    exitCode: 0,
    signal: null,
    stdout: "",
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

const models = JSON.stringify([
  {
    id: "Pixel2.arm",
    name: "Pixel 2",
    form: "VIRTUAL",
    formFactor: "PHONE",
    supportedVersionIds: ["35"],
    perVersionInfo: [{ versionId: "35", deviceCapacity: "DEVICE_CAPACITY_HIGH" }],
  },
  {
    id: "oldPhone",
    name: "Old phone",
    form: "PHYSICAL",
    supportedVersionIds: ["28"],
    tags: ["deprecated"],
    perVersionInfo: [{ versionId: "28", deviceCapacity: "DEVICE_CAPACITY_LOW" }],
  },
]);
const versions = JSON.stringify([
  { id: "35", tags: ["default"] },
  { id: "28", tags: [] },
]);

async function fixture(): Promise<{ root: string; options: FirebaseTestLabOptions }> {
  const root = await mkdtemp(path.join(tmpdir(), "adb-ready-ftl-"));
  await writeFile(path.join(root, "app.apk"), "app");
  await writeFile(path.join(root, "test.apk"), "test");
  return {
    root,
    options: {
      cwd: root,
      action: "instrumentation",
      app: "app.apk",
      test: "test.apk",
      project: "demo-project",
      devices: [{ model: "Pixel2.arm", version: "35", locale: "en", orientation: "portrait" }],
    },
  };
}

function catalogRunner(run: Partial<ProcessResult> = {}) {
  return async (request: ProcessRequest): Promise<ProcessResult> => {
    if (request.args?.includes("models")) return result(request, { stdout: models });
    if (request.args?.includes("versions")) return result(request, { stdout: versions });
    return result(request, run);
  };
}

describe("Firebase Test Lab", () => {
  test("parses exact device dimensions and rejects ambiguous values", () => {
    expect(parseFirebaseDevice("model=Pixel2.arm,version=35")).toEqual({
      model: "Pixel2.arm",
      version: "35",
      locale: "en",
      orientation: "portrait",
    });
    expect(
      parseFirebaseDevice("model=Pixel2.arm,version=35,locale=cs_CZ,orientation=landscape"),
    ).toMatchObject({ locale: "cs_CZ", orientation: "landscape" });
    expect(parseFirebaseDevice("model=Pixel2.arm")).toBeUndefined();
    expect(parseFirebaseDevice("model=x,version=35,unknown=y")).toBeUndefined();
    expect(parseFirebaseDevice("model=x,model=y,version=35")).toBeUndefined();
  });

  test("joins the live model and version catalog into explicit device choices", () => {
    expect(parseFirebaseCatalog(models, versions)).toEqual([
      {
        model: "oldPhone",
        version: "28",
        locale: "en",
        orientation: "portrait",
        name: "Old phone",
        form: "PHYSICAL",
        capacity: "low",
        tags: ["deprecated"],
      },
      {
        model: "Pixel2.arm",
        version: "35",
        locale: "en",
        orientation: "portrait",
        name: "Pixel 2",
        form: "VIRTUAL",
        formFactor: "PHONE",
        capacity: "high",
        tags: ["default"],
      },
    ]);
    expect(parseFirebaseCatalog("not-json", versions)).toBeUndefined();
  });

  test("lists the authenticated live catalog without creating a matrix", async () => {
    const execution = await runFirebaseTestLab(
      { cwd: "/project", action: "devices", project: "demo-project" },
      { runner: catalogRunner(), idFactory: () => "catalog" },
    );
    expect(execution.exitCode).toBe(0);
    expect(execution.result.data).toMatchObject({
      status: "catalogued",
      devices: [{ model: "oldPhone", capacity: "low" }, { model: "Pixel2.arm" }],
    });
  });

  test("builds a deterministic instrumentation plan after live device validation", async () => {
    const { root, options } = await fixture();
    try {
      const execution = await runFirebaseTestLab(
        {
          ...options,
          resultsBucket: "gs://demo-results",
          resultsDir: "ci/run-42",
          testTimeout: "10m",
          dryRun: true,
        },
        { runner: catalogRunner(), idFactory: () => "plan" },
      );
      expect(execution.exitCode).toBe(0);
      expect(execution.result.data).toMatchObject({
        status: "planned",
        command: {
          executable: "gcloud",
          args: expect.arrayContaining([
            "--type=instrumentation",
            `--app=${path.join(root, "app.apk")}`,
            `--test=${path.join(root, "test.apk")}`,
            "--device",
            "model=Pixel2.arm,version=35,locale=en,orientation=portrait",
            "--results-bucket=gs://demo-results",
            "--results-dir=ci/run-42",
            "--timeout=10m",
            "--format=json",
            "--quiet",
            "--project=demo-project",
          ]),
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unavailable, deprecated, unstable, no-capacity, and low-capacity devices", async () => {
    const { root, options } = await fixture();
    const scenarios = [
      { model: "missing", version: "35", detail: "unavailable" },
      { model: "oldPhone", version: "28", detail: "deprecated" },
    ];
    try {
      for (const scenario of scenarios) {
        const execution = await runFirebaseTestLab(
          {
            ...options,
            devices: [{ ...scenario, locale: "en", orientation: "portrait" as const }],
            dryRun: true,
          },
          { runner: catalogRunner() },
        );
        expect(execution.exitCode).toBe(2);
        expect(execution.result.problems[0]?.code).toBe("FTL_DEVICE_POLICY_REJECTED");
        expect(execution.result.problems[0]?.detail).toContain(scenario.detail);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("normalizes official gcloud result codes and retains provider identity", async () => {
    const scenarios = [
      { exitCode: 0, outcome: "passed", providerOutcome: "Passed", code: undefined },
      { exitCode: 0, outcome: "flaky", providerOutcome: "Flaky", code: undefined },
      { exitCode: 10, outcome: "assertion-failed", code: "FTL_ASSERTION_FAILED" },
      { exitCode: 15, outcome: "inconclusive", code: "FTL_INCONCLUSIVE" },
      { exitCode: 18, outcome: "unsupported", code: "FTL_UNSUPPORTED" },
      { exitCode: 19, outcome: "cancelled", code: "FTL_CANCELLED" },
      { exitCode: 20, outcome: "infrastructure-failed", code: "FTL_INFRASTRUCTURE_FAILED" },
    ];
    for (const scenario of scenarios) {
      const { root, options } = await fixture();
      try {
        const execution = await runFirebaseTestLab(options, {
          idFactory: () => `run-${String(scenario.exitCode)}`,
          runner: catalogRunner({
            exitCode: scenario.exitCode,
            stdout: JSON.stringify([
              {
                outcome: scenario.providerOutcome ?? "Failed",
                axis_value: "Pixel2.arm-35-en-portrait",
                test_details: "",
              },
            ]),
            stderr:
              "Test [matrix-123] has been created in the Google Cloud.\nMore details are available at [ https://console.firebase.google.com/project/demo/testlab/histories/h/matrices/e ].",
          }),
        });
        expect(execution.result.data).toMatchObject({
          outcome: scenario.outcome,
          matrixId: "matrix-123",
          consoleUrl:
            "https://console.firebase.google.com/project/demo/testlab/histories/h/matrices/e",
          evidence: { providerFiles: 0 },
        });
        expect(execution.result.problems[0]?.code).toBe(scenario.code);
        expect(
          await readFile(
            path.join(
              root,
              ".adb-ready",
              "artifacts",
              `firebase-run-${String(scenario.exitCode)}`,
              "result.json",
            ),
            "utf8",
          ),
        ).toContain("matrix-123");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("collects only bounded native provider artifacts from the configured result prefix", async () => {
    const { root, options } = await fixture();
    try {
      const execution = await runFirebaseTestLab(
        {
          ...options,
          resultsBucket: "gs://demo-results",
          resultsDir: "ci/run-42",
        },
        {
          idFactory: () => "provider",
          runner: async (request) => {
            if (request.args?.includes("models")) return result(request, { stdout: models });
            if (request.args?.includes("versions")) return result(request, { stdout: versions });
            if (request.args?.includes("ls")) {
              return result(request, {
                stdout: JSON.stringify([
                  {
                    url: "gs://demo-results/ci/run-42/matrix/device/test_result_1.xml",
                    type: "cloud_object",
                    metadata: { size: "4" },
                  },
                  {
                    url: "gs://demo-results/ci/run-42/matrix/device/video.mp4",
                    type: "cloud_object",
                    metadata: { size: String(21 * 1024 * 1024) },
                  },
                  {
                    url: "gs://demo-results/ci/run-42/private.bin",
                    type: "cloud_object",
                    metadata: { size: "2" },
                  },
                ]),
              });
            }
            if (request.args?.includes("cp")) {
              await writeFile(request.args[3] ?? "", "data");
              return result(request);
            }
            return result(request, {
              stdout: JSON.stringify([
                { outcome: "Passed", axis_value: "Pixel2.arm-35-en-portrait" },
              ]),
              stderr: "Test [matrix-provider] has been created in the Google Cloud.",
            });
          },
        },
      );
      expect(execution.exitCode).toBe(0);
      expect(execution.result.data?.evidence).toEqual({
        path: ".adb-ready/artifacts/firebase-provider",
        providerFiles: 1,
        omittedFiles: 2,
        collection: "complete",
        remotePrefix: "gs://demo-results/ci/run-42",
      });
      expect(
        await readFile(
          path.join(root, ".adb-ready", "artifacts", "firebase-provider", "provider-files.json"),
          "utf8",
        ),
      ).toContain("test_result_1.xml");
      expect(JSON.stringify(execution.result)).not.toContain("private.bin");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts private GCS artifacts without treating them as local files", async () => {
    const { root, options } = await fixture();
    try {
      const execution = await runFirebaseTestLab(
        {
          ...options,
          app: "gs://demo-artifacts/app.apk",
          test: "gs://demo-artifacts/test.apk",
          dryRun: true,
        },
        { runner: catalogRunner(), idFactory: () => "gcs-plan" },
      );
      expect(execution.exitCode).toBe(0);
      expect(execution.result.data?.command?.args).toContain("--app=gs://demo-artifacts/app.apk");
      expect(execution.result.data?.command?.args).toContain("--test=gs://demo-artifacts/test.apk");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stops local observation without cancelling an identified remote matrix", async () => {
    const { root, options } = await fixture();
    try {
      const calls: Array<readonly string[]> = [];
      const execution = await runFirebaseTestLab(
        { ...options, resultsBucket: "gs://demo-results", resultsDir: "ci/timeout" },
        {
          idFactory: () => "timeout",
          runner: async (request) => {
            calls.push(request.args ?? []);
            return catalogRunner({
              exitCode: null,
              timedOut: true,
              signal: "SIGKILL",
              stderr: "Test [matrix-live] has been created in the Google Cloud.",
            })(request);
          },
        },
      );
      expect(execution.result.data).toMatchObject({
        outcome: "observation-timed-out",
        matrixId: "matrix-live",
        remoteContinues: true,
        evidence: {
          collection: "remote-running",
          remotePrefix: "gs://demo-results/ci/timeout",
        },
      });
      expect(execution.result.problems[0]?.detail).toContain("without cancelling");
      expect(calls.some((args) => args.includes("storage"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cancels only one explicit matrix without retaining the access token", async () => {
    const requests: string[] = [];
    const execution = await runFirebaseTestLab(
      {
        cwd: "/project",
        action: "cancel",
        project: "demo-project",
        matrixId: "matrix-123",
      },
      {
        runner: async (request) => result(request, { stdout: "secret-access-token\n" }),
        fetch: (async (input, init) => {
          requests.push(String(input));
          expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(
            "Bearer secret-access-token",
          );
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
      },
    );
    expect(execution.exitCode).toBe(0);
    expect(requests).toEqual([
      "https://testing.googleapis.com/v1/projects/demo-project/testMatrices/matrix-123:cancel",
    ]);
    expect(JSON.stringify(execution.result)).not.toContain("secret-access-token");
  });

  test("keeps catalog, artifact, evidence, and cancellation failures structured", async () => {
    const catalogFailure = await runFirebaseTestLab(
      { cwd: "/project", action: "devices", project: "demo-project" },
      {
        runner: async (request) =>
          result(request, { exitCode: 1, stderr: "No active account is selected." }),
      },
    );
    expect(catalogFailure.exitCode).toBe(10);
    expect(catalogFailure.result.problems[0]?.code).toBe("FTL_AUTH_FAILED");

    const malformedCatalog = await runFirebaseTestLab(
      { cwd: "/project", action: "devices", project: "demo-project" },
      {
        runner: async (request) =>
          result(request, { stdout: request.args?.includes("models") ? "{" : versions }),
      },
    );
    expect(malformedCatalog.result.problems[0]?.code).toBe("FTL_CATALOG_FAILED");

    const { root, options } = await fixture();
    try {
      await rm(path.join(root, "app.apk"));
      const missing = await runFirebaseTestLab(options, { runner: catalogRunner() });
      expect(missing.exitCode).toBe(2);
      expect(missing.result.problems[0]?.code).toBe("FTL_ARTIFACT_NOT_FOUND");
      await writeFile(path.join(root, "app.apk"), "app");

      const evidenceFailure = await runFirebaseTestLab(
        {
          ...options,
          resultsBucket: "gs://demo-results",
          resultsDir: "ci/evidence-failure",
        },
        {
          idFactory: () => "evidence-failure",
          runner: async (request) => {
            if (request.args?.includes("models")) return result(request, { stdout: models });
            if (request.args?.includes("versions")) return result(request, { stdout: versions });
            if (request.args?.includes("ls")) {
              return result(request, { exitCode: 1, stderr: "storage temporarily unavailable" });
            }
            return result(request, {
              stderr: "Test [matrix-evidence] has been created in the Google Cloud.",
              stdout: "[]",
            });
          },
        },
      );
      expect(evidenceFailure.exitCode).toBe(0);
      expect(evidenceFailure.result.data?.evidence?.collection).toBe("unavailable");
      expect(evidenceFailure.result.problems[0]).toMatchObject({
        code: "FTL_EVIDENCE_COLLECTION_FAILED",
        severity: "warning",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    const cancellationFailure = await runFirebaseTestLab(
      {
        cwd: "/project",
        action: "cancel",
        project: "demo-project",
        matrixId: "matrix-123",
      },
      {
        runner: async (request) => result(request, { stdout: "ephemeral-token\n" }),
        fetch: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
      },
    );
    expect(cancellationFailure.result.problems[0]?.code).toBe("FTL_CANCEL_FAILED");
    expect(JSON.stringify(cancellationFailure.result)).not.toContain("ephemeral-token");
  });

  test("plans cancellation and rejects incomplete direct adapter calls", async () => {
    const invalidCancel = await runFirebaseTestLab({ cwd: "/project", action: "cancel" });
    expect(invalidCancel.exitCode).toBe(2);
    expect(invalidCancel.result.problems[0]?.code).toBe("FTL_CANCEL_INPUT_INVALID");

    const plan = await runFirebaseTestLab({
      cwd: "/project",
      action: "cancel",
      project: "demo-project",
      matrixId: "matrix-plan",
      dryRun: true,
    });
    expect(plan.exitCode).toBe(0);
    expect(plan.result.data).toMatchObject({
      status: "planned",
      matrixId: "matrix-plan",
      plan: { steps: [{ risk: "destructive", executable: "Firebase Testing API" }] },
    });

    const invalidRun = await runFirebaseTestLab({
      cwd: "/project",
      action: "instrumentation",
    });
    expect(invalidRun.exitCode).toBe(2);
    expect(invalidRun.result.problems[0]?.code).toBe("FTL_RUN_INPUT_INVALID");
  });

  test("classifies stopped observation and run preflight authentication independently", async () => {
    const { root, options } = await fixture();
    try {
      const stopped = await runFirebaseTestLab(options, {
        runner: catalogRunner({
          exitCode: null,
          aborted: true,
          signal: "SIGKILL",
          stderr: "Test [matrix-stopped] has been created in the Google Cloud.",
        }),
      });
      expect(stopped.result.data).toMatchObject({
        outcome: "observation-stopped",
        remoteContinues: true,
      });

      const auth = await runFirebaseTestLab(options, {
        runner: async (request) =>
          result(request, { exitCode: 1, stderr: "No active account is selected." }),
      });
      expect(auth.exitCode).toBe(10);
      expect(auth.result.problems[0]?.code).toBe("FTL_AUTH_FAILED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports every bounded provider evidence failure without changing a passing test", async () => {
    const { root, options } = await fixture();
    try {
      const scenarios = [
        { id: "malformed", listing: "not-json", expected: "unreadable" },
        { id: "primitive", listing: "true", expected: "unreadable" },
        {
          id: "copy-failure",
          listing: JSON.stringify([
            {
              url: "gs://demo-results/ci/copy-failure/result.xml",
              type: "cloud_object",
              metadata: { size: "4" },
            },
          ]),
          copyFailure: true,
          expected: "copy failed",
        },
        {
          id: "size-failure",
          listing: JSON.stringify([
            {
              url: "gs://demo-results/ci/size-failure/result.xml",
              type: "cloud_object",
              metadata: { size: "4" },
            },
          ]),
          wrongSize: true,
          expected: "size verification",
        },
      ];
      for (const scenario of scenarios) {
        const execution = await runFirebaseTestLab(
          {
            ...options,
            resultsBucket: "gs://demo-results",
            resultsDir: `ci/${scenario.id}`,
          },
          {
            idFactory: () => scenario.id,
            runner: async (request) => {
              if (request.args?.includes("models")) return result(request, { stdout: models });
              if (request.args?.includes("versions")) return result(request, { stdout: versions });
              if (request.args?.includes("ls"))
                return result(request, { stdout: scenario.listing });
              if (request.args?.includes("cp")) {
                if (scenario.copyFailure === true)
                  return result(request, { exitCode: 1, stderr: "copy failed" });
                await writeFile(request.args[3] ?? "", scenario.wrongSize === true ? "x" : "data");
                return result(request);
              }
              return result(request, {
                stdout: "[]",
                stderr: `Test [matrix-${scenario.id}] has been created in the Google Cloud.`,
              });
            },
          },
        );
        expect(execution.exitCode).toBe(0);
        expect(execution.result.data?.evidence?.collection).toBe("unavailable");
        expect(execution.result.problems[0]?.detail).toContain(scenario.expected);
      }

      const ndjson = [
        JSON.stringify({
          url: "gs://demo-results/ci/ndjson/first.xml",
          type: "cloud_object",
          metadata: { size: "4" },
        }),
        JSON.stringify({
          url: "gs://demo-results/ci/ndjson/second.log",
          type: "cloud_object",
          metadata: { size: "4" },
        }),
      ].join("\n");
      const parsed = await runFirebaseTestLab(
        { ...options, resultsBucket: "gs://demo-results", resultsDir: "ci/ndjson" },
        {
          idFactory: () => "ndjson",
          runner: async (request) => {
            if (request.args?.includes("models")) return result(request, { stdout: models });
            if (request.args?.includes("versions")) return result(request, { stdout: versions });
            if (request.args?.includes("ls")) return result(request, { stdout: ndjson });
            if (request.args?.includes("cp")) {
              await writeFile(request.args[3] ?? "", "data");
              return result(request);
            }
            return result(request, { stdout: "[]" });
          },
        },
      );
      expect(parsed.result.data?.evidence).toMatchObject({
        collection: "complete",
        providerFiles: 2,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("distinguishes token and HTTP authorization failures during explicit cancellation", async () => {
    const base = {
      cwd: "/project",
      action: "cancel" as const,
      project: "demo-project",
      matrixId: "matrix-123",
    };
    const noToken = await runFirebaseTestLab(base, {
      runner: async (request) => result(request, { exitCode: 1, stderr: "login required" }),
    });
    expect(noToken.result.problems[0]?.code).toBe("FTL_AUTH_FAILED");

    const forbidden = await runFirebaseTestLab(base, {
      runner: async (request) => result(request, { stdout: "ephemeral-token\n" }),
      fetch: (async () =>
        new Response("permission denied", { status: 403 })) as unknown as typeof fetch,
    });
    expect(forbidden.result.problems[0]).toMatchObject({
      code: "FTL_AUTH_FAILED",
      detail: "permission denied",
    });
    expect(JSON.stringify(forbidden.result)).not.toContain("ephemeral-token");
  });
});
