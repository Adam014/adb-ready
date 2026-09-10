import { describe, expect, test } from "bun:test";

import { readNpmPackEntry } from "../../scripts/lib/npm-pack-report.mjs";

const entry = {
  filename: "adb-ready-0.1.0.tgz",
  files: [{ path: "package.json" }],
  name: "adb-ready",
};

describe("readNpmPackEntry", () => {
  test("reads the npm 10 array report", () => {
    expect(readNpmPackEntry([entry], "adb-ready")).toEqual(entry);
  });

  test("reads the npm 12 package-keyed report", () => {
    expect(readNpmPackEntry({ "adb-ready": entry }, "adb-ready")).toEqual(entry);
  });

  test("rejects a report without the requested package", () => {
    expect(() => readNpmPackEntry({ other: entry }, "adb-ready")).toThrow(
      "npm pack did not return a report for adb-ready",
    );
  });
});
