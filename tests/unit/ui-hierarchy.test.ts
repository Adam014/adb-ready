import { describe, expect, test } from "bun:test";
import { parseUiHierarchy } from "../../src/evidence/ui-hierarchy.js";

const XML = `UI hierchary dumped to: /dev/tty
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][1080,2400]">
    <node index="0" text="Orders &amp; invoices" resource-id="com.example.app:id/title" class="android.widget.TextView" clickable="false" enabled="true" bounds="[20,40][900,120]" />
    <node index="1" text="Open" content-desc="Open order" resource-id="com.example.app:id/open" class="android.widget.Button" clickable="true" enabled="true" focusable="true" bounds="[20,140][300,240]" />
  </node>
</hierarchy>`;

describe("UI hierarchy snapshots", () => {
  test("builds stable digest-scoped refs and preserves bounded useful fields", () => {
    const first = parseUiHierarchy(XML);
    const second = parseUiHierarchy(XML);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      sensitive: true,
      complete: true,
      totalNodes: 3,
      returnedNodes: 3,
      truncated: false,
      nodes: [
        { depth: 0, className: "android.widget.FrameLayout" },
        { depth: 1, text: "Orders & invoices", resourceId: "com.example.app:id/title" },
        {
          depth: 1,
          text: "Open",
          contentDescription: "Open order",
          clickable: true,
          bounds: { left: 20, top: 140, right: 300, bottom: 240 },
        },
      ],
    });
    expect(first?.nodes[0]?.ref).toMatch(/^ui:[a-f0-9]{12}:1$/u);
  });

  test("filters to actionable nodes without reporting intentional filtering as truncation", () => {
    const snapshot = parseUiHierarchy(XML, { interactiveOnly: true });
    expect(snapshot).toMatchObject({
      complete: true,
      totalNodes: 3,
      returnedNodes: 1,
      truncated: false,
      nodes: [{ resourceId: "com.example.app:id/open", clickable: true }],
    });
  });

  test("reports depth and node limits instead of silently dropping hierarchy data", () => {
    expect(parseUiHierarchy(XML, { maxDepth: 0 })).toMatchObject({
      complete: false,
      returnedNodes: 1,
      truncated: true,
    });
    expect(parseUiHierarchy(XML, { maxNodes: 2 })).toMatchObject({
      complete: false,
      returnedNodes: 2,
      truncated: true,
    });
    expect(parseUiHierarchy("secure window returned no hierarchy")).toBeUndefined();
  });
});
