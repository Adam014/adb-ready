import path from "node:path";
import type { OperationPlan, OperationPlanStep } from "../domain/contracts.js";
import { SCHEMA_VERSION } from "../domain/contracts.js";
import { type AndroidCapabilities, type AndroidToolId, capability } from "./capabilities.js";

export interface AutonomousRunPlanInput {
  avd?: string;
  artifact?: string;
  capabilities: AndroidCapabilities;
  projectCommand: { executable: string; args: readonly string[] };
  verifier: { executable: string; args: readonly string[] };
}

export interface PlanBlocker {
  capability: AndroidToolId | "artifact" | "avd";
  summary: string;
  next: string;
}

export interface AutonomousRunPlan {
  plan: OperationPlan;
  blockers: PlanBlocker[];
}

function requirementBlocker(
  capabilities: AndroidCapabilities,
  id: AndroidToolId,
): PlanBlocker | undefined {
  const required = capability(capabilities, id);
  return required.status === "supported"
    ? undefined
    : {
        capability: id,
        summary: required.detail,
        next: required.next ?? `Provide a supported ${id} installation.`,
      };
}

function artifactKind(value: string): "aab" | "apk" | "apks" | "unknown" {
  const extension = path.extname(value).toLowerCase();
  if (extension === ".apk") return "apk";
  if (extension === ".apks") return "apks";
  if (extension === ".aab") return "aab";
  return "unknown";
}

export function buildAutonomousRunPlan(input: AutonomousRunPlanInput): AutonomousRunPlan {
  const blockers: PlanBlocker[] = [];
  const steps: OperationPlanStep[] = [];
  if (input.avd !== undefined) {
    const emulatorBlocker = requirementBlocker(input.capabilities, "emulator");
    if (emulatorBlocker !== undefined) blockers.push(emulatorBlocker);
    steps.push(
      {
        id: "resolve-avd",
        title: `Resolve existing AVD ${input.avd}`,
        risk: "read-only",
      },
      {
        id: "start-avd-if-needed",
        title: `Start ${input.avd} only when no matching emulator is already running`,
        risk: "local-additive",
      },
      {
        id: "wait-for-avd-readiness",
        title: "Wait for ADB, boot, package manager, and unlock readiness",
        risk: "read-only",
      },
    );
  } else {
    steps.push({
      id: "acquire-target",
      title: "Select and exclusively lease one ready Android target",
      risk: "device-reversible",
    });
  }

  if (input.artifact !== undefined) {
    const kind = artifactKind(input.artifact);
    if (kind === "unknown") {
      blockers.push({
        capability: "artifact",
        summary: "The explicit artifact type is unsupported.",
        next: "Provide an .apk, .apks, or .aab artifact.",
      });
    }
    if (kind === "aab" || kind === "apks") {
      for (const id of ["java", "bundletool"] as const) {
        const blocker = requirementBlocker(input.capabilities, id);
        if (blocker !== undefined) blockers.push(blocker);
      }
    }
    steps.push(
      {
        id: "resolve-artifact",
        title: `Validate the explicit ${kind.toUpperCase()} artifact and its application identity`,
        risk: "read-only",
      },
      {
        id: "deploy-artifact",
        title: "Deploy the resolved artifact to the selected target",
        risk: "device-reversible",
      },
      {
        id: "verify-deployment",
        title: "Verify installed package identity, version, ABI, and launchability",
        risk: "read-only",
      },
    );
  }

  steps.push(
    {
      id: "start-project",
      title: "Start the project command on the selected target",
      risk: "open-world",
      executable: input.projectCommand.executable,
      args: [...input.projectCommand.args],
    },
    {
      id: "wait-for-project-readiness",
      title: "Satisfy the configured project readiness contract",
      risk: "read-only",
    },
    {
      id: "run-verifier",
      title: "Run one bounded external verifier on the same target",
      risk: "open-world",
      executable: input.verifier.executable,
      args: [...input.verifier.args],
    },
    {
      id: "retain-evidence",
      title: "Retain redacted normalized evidence and native verifier outputs",
      risk: "local-additive",
    },
    {
      id: "cleanup-owned-resources",
      title: "Stop only emulator and session resources owned by this workflow",
      risk: "device-reversible",
    },
  );

  return {
    plan: { schemaVersion: SCHEMA_VERSION, dryRun: true, steps },
    blockers: blockers.sort((left, right) => left.capability.localeCompare(right.capability)),
  };
}
