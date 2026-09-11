import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const workflowUrl = new URL("../../.github/workflows/release.yml", import.meta.url);

describe("release workflow", () => {
  test("isolates draft-release access before validating a publish artifact", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    const preflightJob = workflow.indexOf("  release-preflight:");
    const validateJob = workflow.indexOf("  validate:");
    const immutableTargetStep = workflow.indexOf(
      "- name: Require an immutable release target for publish mode",
    );
    const draftReleaseStep = workflow.indexOf(
      "- name: Require a matching draft GitHub release for publish mode",
    );
    const artifactStep = workflow.indexOf("- name: Create the immutable npm artifact");
    const publishStep = workflow.indexOf("- name: Publish with npm trusted publishing");

    expect(preflightJob).toBeGreaterThan(-1);
    expect(validateJob).toBeGreaterThan(preflightJob);
    expect(immutableTargetStep).toBeGreaterThan(-1);
    expect(draftReleaseStep).toBeGreaterThan(preflightJob);
    expect(draftReleaseStep).toBeLessThan(validateJob);
    expect(artifactStep).toBeGreaterThan(immutableTargetStep);
    expect(publishStep).toBeGreaterThan(artifactStep);

    const draftPreflight = workflow.slice(preflightJob, validateJob);
    expect(draftPreflight).toContain("if: inputs.mode == 'publish'");
    expect(draftPreflight).toContain("contents: write");
    expect(draftPreflight).not.toContain("actions/checkout");
    expect(draftPreflight).toContain("GH_TOKEN: $" + "{{ github.token }}");
    expect(draftPreflight).toContain('gh release view "$RELEASE_TAG"');
    expect(draftPreflight).toContain("--json isDraft");
    expect(draftPreflight).toContain('= "true"');

    const validation = workflow.slice(validateJob, workflow.indexOf("  publish:"));
    expect(validation).toContain("needs: release-preflight");
    expect(validation).toContain(
      "if: always() && (inputs.mode == 'validate' || needs.release-preflight.result == 'success')",
    );
    expect(validation).toContain('test "$RELEASE_REF" = "$RELEASE_TAG"');
    expect(validation).toContain('"refs/heads/main"');
    expect(validation).toContain('"refs/tags/$RELEASE_TAG"');
    expect(validation).toContain('git rev-parse "$RELEASE_TAG^{commit}"');
    expect(validation).not.toContain("contents: write");
  });
});
