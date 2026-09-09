import { describe, expect, test } from "bun:test";
import { renderLinkCoreFrame } from "../../src/ui/ascii-scene.js";

describe("ASCII 3D scene", () => {
  test("renders a bounded, non-empty split-link core without terminal controls", () => {
    const frame = renderLinkCoreFrame({ angleX: 0.42, angleY: 0.7, width: 36, height: 14 });
    const visible = frame.join("").replaceAll(" ", "");

    expect(frame).toHaveLength(14);
    expect(frame.every((line) => line.length <= 36)).toBe(true);
    expect(visible.length).toBeGreaterThan(28);
    expect(visible).toMatch(/[#@*]/u);
    expect(frame.join("\n")).not.toContain("\u001B");
  });

  test("changes geometry across rotation frames", () => {
    const first = renderLinkCoreFrame({ angleX: 0.4, angleY: 0.1 });
    const second = renderLinkCoreFrame({ angleX: 0.5, angleY: 1.2 });

    expect(second).not.toEqual(first);
  });

  test("enforces a readable minimum viewport", () => {
    const frame = renderLinkCoreFrame({ angleX: 0, angleY: 0, width: 2, height: 2 });

    expect(frame).toHaveLength(10);
    expect(frame.every((line) => line.length <= 20)).toBe(true);
  });
});
