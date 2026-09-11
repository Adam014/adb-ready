import { describe, expect, test } from "bun:test";

import { summarizeLcov } from "../../scripts/lib/lcov-summary.mjs";

describe("LCOV summary", () => {
  test("aggregates line and function coverage across source records", () => {
    expect(
      summarizeLcov(
        [
          "TN:",
          "SF:first.ts",
          "FNF:4",
          "FNH:3",
          "LF:10",
          "LH:9",
          "end_of_record",
          "SF:second.ts",
          "FNF:6",
          "FNH:6",
          "LF:10",
          "LH:8",
          "end_of_record",
        ].join("\n"),
      ),
    ).toEqual({
      lines: { found: 20, hit: 17, ratio: 0.85 },
      functions: { found: 10, hit: 9, ratio: 0.9 },
    });
  });

  test("rejects empty and internally inconsistent reports", () => {
    expect(() => summarizeLcov("TN:\nend_of_record\n")).toThrow(
      "LCOV report contains no measurable lines or functions",
    );
    expect(() => summarizeLcov("LF:1\nLH:2\nFNF:1\nFNH:1\n")).toThrow(
      "LCOV hit counts exceed measurable totals",
    );
  });
});
