import { describe, expect, test } from "bun:test";
import { parseArguments } from "../../src/cli/arguments.js";

describe("parseArguments", () => {
  test("defaults to help", () => {
    expect(parseArguments([])).toMatchObject({ ok: true, options: { command: "help" } });
  });

  test("accepts global flags before and after a command", () => {
    const result = parseArguments([
      "--verbose",
      "devices",
      "--select",
      "--adb=/path with spaces/adb",
      "--timeout",
      "1.5s",
      "--no-animation",
    ]);

    expect(result).toEqual({
      ok: true,
      options: {
        command: "devices",
        format: "human",
        quiet: false,
        verbose: true,
        nonInteractive: false,
        animation: false,
        timeoutMs: 1_500,
        adbPath: "/path with spaces/adb",
        select: true,
      },
    });
  });

  test("supports help for a command in both common forms", () => {
    expect(parseArguments(["devices", "--help"])).toMatchObject({
      ok: true,
      options: { command: "help", helpTarget: "devices" },
    });
    expect(parseArguments(["help", "doctor"])).toMatchObject({
      ok: true,
      options: { command: "help", helpTarget: "doctor" },
    });
  });

  test("uses the last explicit presentation preference", () => {
    expect(
      parseArguments(["doctor", "--no-color", "--color", "--unicode", "--no-unicode"]),
    ).toMatchObject({
      ok: true,
      options: { color: true, unicode: false },
    });
  });

  test("parses machine formats and remote ADB configuration", () => {
    expect(
      parseArguments([
        "doctor",
        "--format=ndjson",
        "--non-interactive",
        "--adb-host",
        "127.0.0.1",
        "--adb-port=5038",
      ]),
    ).toMatchObject({
      ok: true,
      options: {
        command: "doctor",
        format: "ndjson",
        nonInteractive: true,
        adbHost: "127.0.0.1",
        adbPort: 5038,
      },
    });
  });

  test("rejects unknown commands and options", () => {
    expect(parseArguments(["pair"])).toMatchObject({ ok: false, code: "CLI_USAGE" });
    expect(parseArguments(["doctor", "--magical"])).toEqual({
      ok: false,
      code: "CLI_INVALID_OPTION",
      message: "Unknown option: --magical",
      option: "--magical",
    });
    expect(parseArguments(["doctor", "--json=false"])).toMatchObject({
      ok: false,
      code: "CLI_INVALID_OPTION",
      option: "--json",
    });
  });

  test("rejects missing and invalid values", () => {
    expect(parseArguments(["doctor", "--timeout"])).toMatchObject({
      ok: false,
      code: "CLI_INVALID_VALUE",
      option: "--timeout",
    });
    expect(parseArguments(["doctor", "--timeout=0"])).toMatchObject({
      ok: false,
      code: "CLI_INVALID_VALUE",
    });
    expect(parseArguments(["doctor", "--adb-port=65536"])).toMatchObject({
      ok: false,
      code: "CLI_INVALID_VALUE",
    });
  });

  test("rejects semantic conflicts", () => {
    expect(parseArguments(["doctor", "--quiet", "--verbose"])).toMatchObject({
      ok: false,
      code: "CLI_USAGE",
    });
    expect(parseArguments(["doctor", "--select"])).toMatchObject({
      ok: false,
      code: "CLI_USAGE",
      option: "--select",
    });
  });
});
