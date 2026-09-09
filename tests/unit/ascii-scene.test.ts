import { describe, expect, test } from "bun:test";
import { renderTorusFrame } from "../../src/ui/ascii-scene.js";

describe("ASCII 3D scene", () => {
  test("renders a bounded, non-empty frame without terminal controls", () => {
    const frame = renderTorusFrame({ angleX: 0.7, angleZ: 0.2, width: 36, height: 14 });
    const visible = frame.join("").replaceAll(" ", "");

    expect(frame).toHaveLength(14);
    expect(frame.every((line) => line.length <= 36)).toBe(true);
    expect(visible.length).toBeGreaterThan(40);
    expect(visible).toMatch(/[$#@!*]/u);
    expect(frame.join("\n")).not.toContain("\u001B");
  });

  test("changes geometry across rotation frames", () => {
    const first = renderTorusFrame({ angleX: 0.2, angleZ: 0.1 });
    const second = renderTorusFrame({ angleX: 1.1, angleZ: 0.8 });

    expect(second).not.toEqual(first);
  });

  test("enforces a readable minimum viewport", () => {
    const frame = renderTorusFrame({ angleX: 0, angleZ: 0, width: 2, height: 2 });

    expect(frame).toHaveLength(10);
    expect(frame.every((line) => line.length <= 20)).toBe(true);
  });
});
