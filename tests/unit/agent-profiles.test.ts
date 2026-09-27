import { describe, expect, test } from "bun:test";
import { parseMcpProfile } from "../../src/agent/profiles.js";

describe("MCP profiles", () => {
  test("accepts only the four public profile names", () => {
    expect(["debug", "full", "session", "ui"].map(parseMcpProfile)).toEqual([
      "debug",
      "full",
      "session",
      "ui",
    ]);
    expect(parseMcpProfile(undefined)).toBeUndefined();
    expect(parseMcpProfile("unsafe")).toBeUndefined();
  });
});
