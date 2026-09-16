import { describe, expect, test } from "bun:test";
import {
  type AutonomousRunPlanInput,
  buildAutonomousRunPlan,
} from "../../src/automation/autonomous-plan.js";
import type {
  AndroidCapabilities,
  AndroidToolCapability,
  AndroidToolId,
} from "../../src/automation/capabilities.js";

const ids: AndroidToolId[] = [
  "emulator",
  "avdmanager",
  "bundletool",
  "java",
  "gradle",
  "android-cli",
  "external-verifier",
];

function capabilities(overrides: Partial<Record<AndroidToolId, AndroidToolCapability>> = {}) {
  return {
    sdk: { status: "supported", root: "/sdk", candidates: ["/sdk"], detail: "ready" },
    tools: ids.map(
      (id): AndroidToolCapability =>
        overrides[id] ?? {
          id,
          status: "supported",
          path: `/bin/${id}`,
          detail: `${id} ready`,
        },
    ),
  } satisfies AndroidCapabilities;
}

function input(overrides: Partial<AutonomousRunPlanInput> = {}): AutonomousRunPlanInput {
  return {
    avd: "Pixel_9_API_36",
    artifact: "app/build/outputs/apk/debug/app-debug.apk",
    capabilities: capabilities(),
    projectCommand: { executable: "bun", args: ["run", "start"] },
    verifier: { executable: "maestro", args: ["test", "flow.yaml"] },
    ...overrides,
  };
}

describe("autonomous run plan", () => {
  test("is deterministic and orders every mutating boundary before cleanup", () => {
    const first = buildAutonomousRunPlan(input());
    const second = buildAutonomousRunPlan(input());

    expect(first).toEqual(second);
    expect(first.blockers).toEqual([]);
    expect(first.plan.steps.map(({ id }) => id)).toEqual([
      "resolve-avd",
      "start-avd-if-needed",
      "wait-for-avd-readiness",
      "resolve-artifact",
      "deploy-artifact",
      "verify-deployment",
      "start-project",
      "wait-for-project-readiness",
      "run-verifier",
      "retain-evidence",
      "cleanup-owned-resources",
    ]);
  });

  test("requires bundletool and Java only for bundle artifacts", () => {
    const unavailable = capabilities({
      bundletool: {
        id: "bundletool",
        status: "unavailable",
        detail: "bundletool was not found.",
        next: "Provide bundletool.",
      },
      java: {
        id: "java",
        status: "incompatible",
        version: "7",
        detail: "Java is too old.",
        next: "Install Java 8 or newer.",
      },
    });

    expect(buildAutonomousRunPlan(input({ capabilities: unavailable })).blockers).toEqual([]);
    expect(
      buildAutonomousRunPlan(input({ artifact: "release.aab", capabilities: unavailable }))
        .blockers,
    ).toEqual([
      {
        capability: "bundletool",
        summary: "bundletool was not found.",
        next: "Provide bundletool.",
      },
      {
        capability: "java",
        summary: "Java is too old.",
        next: "Install Java 8 or newer.",
      },
    ]);
  });

  test("rejects unknown explicit artifact types without guessing", () => {
    const planned = buildAutonomousRunPlan(input({ artifact: "download/latest.zip" }));

    expect(planned.blockers).toEqual([
      {
        capability: "artifact",
        summary: "The explicit artifact type is unsupported.",
        next: "Provide an .apk, .apks, or .aab artifact.",
      },
    ]);
  });

  test("uses target acquisition instead of emulator lifecycle when no AVD is requested", () => {
    const { avd: _avd, ...withoutAvd } = input();
    const planned = buildAutonomousRunPlan(withoutAvd);

    expect(planned.plan.steps[0]?.id).toBe("acquire-target");
    expect(planned.plan.steps.some(({ id }) => id === "start-avd-if-needed")).toBe(false);
  });
});
