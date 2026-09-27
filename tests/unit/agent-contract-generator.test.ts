import { describe, expect, test } from "bun:test";
import { stringifyAgentContract } from "../../scripts/lib/generate-agent-contract.mjs";

describe("agent contract generator", () => {
  test("compacts primitive arrays only when the indented line stays within the formatter width", () => {
    const output = stringifyAgentContract({
      short: ["one", "two"],
      nested: {
        decision: [
          "allow",
          "allow-always",
          "allow-once",
          "allow-while-using",
          "deny",
          "deny-and-dont-ask-again",
        ],
      },
    });
    expect(output).toContain('"short": ["one", "two"]');
    expect(output).toContain('"decision": [\n');
    expect(Math.max(...output.split("\n").map((line) => line.length))).toBeLessThanOrEqual(100);
    expect(JSON.parse(output)).toEqual({
      short: ["one", "two"],
      nested: {
        decision: [
          "allow",
          "allow-always",
          "allow-once",
          "allow-while-using",
          "deny",
          "deny-and-dont-ask-again",
        ],
      },
    });
  });
});
