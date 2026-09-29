import { describe, expect, test } from "bun:test";
import { COMPLETION_SHELLS, generateCompletion } from "../../src/cli/completion.js";

const PUBLIC_COMMANDS = [
  "agent",
  "app",
  "apps",
  "capture",
  "completion",
  "config",
  "connect",
  "context",
  "dev",
  "devices",
  "doctor",
  "help",
  "init",
  "inspect",
  "logs",
  "mcp",
  "open",
  "pair",
  "ports",
  "problems",
  "run",
  "sessions",
  "test",
  "ui",
  "version",
] as const;

describe("generateCompletion", () => {
  test("generates deterministic text for every supported shell", () => {
    for (const shell of COMPLETION_SHELLS) {
      const first = generateCompletion(shell);
      expect(first).toBe(generateCompletion(shell));
      expect(first.endsWith("\n")).toBe(true);
      expect(first).not.toContain("\u001b");
      expect(first).toContain("adb-ready");
      expect(first).toContain("adbr");
      for (const command of PUBLIC_COMMANDS) expect(first).toContain(command);
    }
  });

  test("keeps zsh command descriptions as separate array entries", () => {
    const script = generateCompletion("zsh");
    expect(script).toContain("'agent:Configure a project-local AI agent bridge'\n");
    expect(script).not.toContain("'\\\n    '");
  });

  test("preserves ordinary fish file completion outside command positions", () => {
    const script = generateCompletion("fish");
    expect(script).not.toContain("complete -c adb-ready -f\n");
    expect(script).toContain("complete -c adb-ready -f -n '__fish_use_subcommand'");
  });
});
