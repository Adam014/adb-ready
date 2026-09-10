import { describe, expect, test } from "bun:test";
import { renderChildStreamLine, renderLogStreamLine } from "../../src/ui/stream-renderer.js";
import type { TerminalCapabilities } from "../../src/ui/terminal.js";

const color: TerminalCapabilities = {
  interactive: true,
  color: true,
  unicode: true,
  animation: true,
  columns: 120,
};
const plain: TerminalCapabilities = { ...color, color: false };

describe("stream renderer", () => {
  test("colors logcat by its parsed Android priority", () => {
    const warning = "09-10 10:00:00.000  321  322 W Demo: warning";
    const error = "09-10 10:00:01.000  321  322 E Demo: failed";
    const info = "09-10 10:00:02.000  321  322 I Demo: ready";

    expect(renderLogStreamLine(warning, color)).toStartWith("\u001b[33m");
    expect(renderLogStreamLine(error, color)).toStartWith("\u001b[31m");
    expect(renderLogStreamLine(info, color)).toStartWith("\u001b[36m");
  });

  test("uses message semantics instead of treating all stderr as errors", () => {
    const neutral = renderChildStreamLine("stderr", "Metro is listening", color);
    const warning = renderChildStreamLine("stdout", "warning: cache is empty", color);
    const error = renderChildStreamLine("stdout", "error: build failed", color);
    const success = renderChildStreamLine("stdout", "Bundled 6812 modules", color);

    expect(neutral).not.toContain("\u001b[31m");
    expect(warning).toContain("\u001b[33m");
    expect(error).toContain("\u001b[31m");
    expect(success).toContain("\u001b[32m");
  });

  test("sanitizes untrusted controls and stays ANSI-free without color", () => {
    const rendered = renderChildStreamLine("stderr", "warn:\u001b[31m spoofed\rline", plain);

    expect(rendered).toBe("│ warn: spoofed line");
    expect(rendered).not.toContain("\u001b");
  });
});
