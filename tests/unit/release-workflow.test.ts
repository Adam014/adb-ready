import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const workflowUrl = new URL("../../.github/workflows/release.yml", import.meta.url);

describe("release workflow", () => {
  test("requires an immutable tag and draft release before creating the publish artifact", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    const immutableTagStep = workflow.indexOf(
      "- name: Require an immutable release tag for publish mode",
    );
    const draftReleaseStep = workflow.indexOf(
      "- name: Require a matching draft GitHub release for publish mode",
    );
    const artifactStep = workflow.indexOf("- name: Create the immutable npm artifact");
    const publishStep = workflow.indexOf("- name: Publish with npm trusted publishing");

    expect(immutableTagStep).toBeGreaterThan(-1);
    expect(draftReleaseStep).toBeGreaterThan(immutableTagStep);
    expect(artifactStep).toBeGreaterThan(draftReleaseStep);
    expect(publishStep).toBeGreaterThan(artifactStep);

    const draftPreflight = workflow.slice(draftReleaseStep, artifactStep);
    expect(draftPreflight).toContain("if: inputs.mode == 'publish'");
    expect(draftPreflight).toContain("GH_TOKEN: $" + "{{ github.token }}");
    expect(draftPreflight).toContain('gh release view "$RELEASE_TAG"');
    expect(draftPreflight).toContain("--json isDraft");
    expect(draftPreflight).toContain('= "true"');
  });
});
