import { describe, expect, test } from "bun:test";

import {
  changedLineCoverage,
  parseAddedLines,
  parseLcovLineHits,
} from "../../scripts/lib/changed-coverage.mjs";

const lcov = [
  "TN:",
  "SF:src/covered.ts",
  "DA:1,3",
  "DA:2,0",
  "DA:3,1",
  "LF:3",
  "LH:2",
  "end_of_record",
  "SF:/workspace/project/scripts/lib/helper.mjs",
  "DA:10,1",
  "LF:1",
  "LH:1",
  "end_of_record",
].join("\n");

describe("changed-line coverage", () => {
  test("parses LCOV line hits from relative and absolute source paths", () => {
    const parsed = parseLcovLineHits(lcov);
    expect(parsed.get("src/covered.ts")).toEqual(
      new Map([
        [1, 3],
        [2, 0],
        [3, 1],
      ]),
    );
    expect(parsed.get("/workspace/project/scripts/lib/helper.mjs")?.get(10)).toBe(1);
  });

  test("parses added ranges and ignores deleted-only hunks", () => {
    const parsed = parseAddedLines(
      [
        "diff --git a/src/covered.ts b/src/covered.ts",
        "--- a/src/covered.ts",
        "+++ b/src/covered.ts",
        "@@ -1,0 +2,2 @@",
        "+line two",
        "+line three",
        "@@ -8,1 +10,0 @@",
        "-removed",
        "diff --git a/src/deleted.ts b/src/deleted.ts",
        "--- a/src/deleted.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-deleted",
      ].join("\n"),
    );

    expect(parsed.get("src/covered.ts")).toEqual(new Set([2, 3]));
    expect(parsed.has("src/deleted.ts")).toBe(false);
  });

  test("measures only instrumented changed lines and resolves absolute LCOV paths", () => {
    const result = changedLineCoverage(
      lcov,
      [
        "+++ b/src/covered.ts",
        "@@ -1,0 +1,3 @@",
        "+one",
        "+two",
        "+three",
        "+++ b/scripts/lib/helper.mjs",
        "@@ -9,0 +10 @@",
        "+ten",
        "+++ b/README.md",
        "@@ -1,0 +1 @@",
        "+docs",
      ].join("\n"),
    );

    expect(result).toEqual({
      found: 4,
      hit: 3,
      ratio: 0.75,
      files: 2,
      missingFiles: [],
    });
  });

  test("fails closed when a changed source file is missing from LCOV", () => {
    expect(
      changedLineCoverage(lcov, "+++ b/src/not-imported.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n"),
    ).toEqual({
      found: 0,
      hit: 0,
      ratio: 1,
      files: 1,
      missingFiles: ["src/not-imported.ts"],
    });
  });

  test("passes an empty or documentation-only patch", () => {
    expect(changedLineCoverage(lcov, "+++ b/README.md\n@@ -1,0 +1 @@\n+docs\n")).toEqual({
      found: 0,
      hit: 0,
      ratio: 1,
      files: 0,
      missingFiles: [],
    });
  });
});
