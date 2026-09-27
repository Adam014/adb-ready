import { describe, expect, test } from "bun:test";
import { parseUiHierarchy, type UiHierarchySnapshot } from "../../src/evidence/ui-hierarchy.js";
import { diffUiHierarchies } from "../../src/evidence/ui-hierarchy-diff.js";

const acquisition = {
  profile: "balanced" as const,
  source: "uiautomator" as const,
  idleStrategy: "platform-idle" as const,
  observedAt: "2026-09-27T10:00:00.000Z",
  freshness: "fresh" as const,
  durationMs: 10,
  attempts: 1,
  stability: "not-assessed" as const,
};

function snapshot(nodes: string, options: { interactiveOnly?: boolean } = {}): UiHierarchySnapshot {
  const parsed = parseUiHierarchy(
    `<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">${nodes}</node></hierarchy>`,
    options,
  );
  if (parsed === undefined) throw new Error("Invalid hierarchy fixture");
  return { ...parsed, acquisition };
}

describe("compact UI hierarchy diff", () => {
  test("returns only actionable semantic additions, removals, updates, and moves", () => {
    const before = snapshot(`
      <node resource-id="app:id/title" class="android.widget.TextView" text="Orders" bounds="[20,40][600,120]" />
      <node resource-id="app:id/remove" class="android.widget.TextView" text="Old" bounds="[20,130][600,200]" />
      <node resource-id="app:id/open" class="android.widget.Button" text="Open" clickable="true" enabled="true" bounds="[20,220][300,320]" />
    `);
    const after = snapshot(`
      <node resource-id="app:id/title" class="android.widget.TextView" text="Invoices" bounds="[20,40][600,120]" />
      <node resource-id="app:id/open" class="android.widget.Button" text="Open" clickable="true" enabled="true" bounds="[20,340][300,440]" />
      <node resource-id="app:id/add" class="android.widget.Button" text="Create" clickable="true" enabled="true" bounds="[320,340][600,440]" />
    `);

    expect(diffUiHierarchies(before, after)).toMatchObject({
      ok: true,
      diff: {
        changed: true,
        digestChanged: true,
        totalChanges: 4,
        returnedChanges: 4,
        truncated: false,
        added: [{ resourceId: "app:id/add", text: "Create" }],
        removed: [{ resourceId: "app:id/remove", text: "Old" }],
        updated: [
          {
            before: { resourceId: "app:id/title", text: "Orders" },
            after: { resourceId: "app:id/title", text: "Invoices" },
            fields: ["text"],
          },
        ],
        moved: [
          {
            selector: { resourceId: "app:id/open", text: "Open" },
            from: { bounds: { top: 220 } },
            to: { bounds: { top: 340 } },
          },
        ],
      },
    });
  });

  test("keeps unchanged output compact and deterministic", () => {
    const value = snapshot(
      '<node resource-id="app:id/open" class="android.widget.Button" text="Open" bounds="[20,220][300,320]" />',
    );
    expect(diffUiHierarchies(value, value)).toMatchObject({
      ok: true,
      diff: {
        changed: false,
        digestChanged: false,
        totalChanges: 0,
        returnedChanges: 0,
        added: [],
        removed: [],
        updated: [],
        moved: [],
      },
    });
  });

  test("matches controls by a stable accessibility hint when no ID or description exists", () => {
    const before = snapshot(
      '<node class="android.widget.EditText" hint="Email" text="" focusable="true" bounds="[20,220][600,320]" />',
    );
    const after = snapshot(
      '<node class="android.widget.EditText" hint="Email" text="person@example.com" focusable="true" bounds="[20,220][600,320]" />',
    );
    expect(diffUiHierarchies(before, after)).toMatchObject({
      ok: true,
      diff: { updated: [{ fields: ["text"], after: { hintText: "Email" } }] },
    });
  });

  test("rejects incompatible filters, acquisition contracts, displays, and truncation", () => {
    const base = snapshot('<node class="android.widget.TextView" text="Ready" />');
    expect(diffUiHierarchies(base, snapshot("", { interactiveOnly: true }))).toMatchObject({
      ok: false,
      code: "UI_DIFF_FILTER_MISMATCH",
    });
    expect(
      diffUiHierarchies(base, {
        ...base,
        acquisition: { ...acquisition, profile: "strict", stability: "verified" },
      }),
    ).toMatchObject({ ok: false, code: "UI_DIFF_ACQUISITION_MISMATCH" });
    const otherDisplay = parseUiHierarchy(
      '<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][720,1280]" /></hierarchy>',
    );
    expect(
      diffUiHierarchies(base, { ...(otherDisplay as UiHierarchySnapshot), acquisition }),
    ).toMatchObject({ ok: false, code: "UI_DIFF_DISPLAY_MISMATCH" });
    expect(diffUiHierarchies({ ...base, complete: false, truncated: true }, base)).toMatchObject({
      ok: false,
      code: "UI_DIFF_INCOMPLETE_SNAPSHOT",
    });
  });
});
