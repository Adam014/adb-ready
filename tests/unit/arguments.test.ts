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
      "--profile",
      "android-dev",
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
        profileName: "android-dev",
        adbPath: "/path with spaces/adb",
        select: true,
        pairingCodeStdin: false,
        remembered: false,
        dryRun: false,
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

  test("parses exact serial, alias, and transport selectors", () => {
    expect(parseArguments(["devices", "-s", "desk-phone", "--json"])).toMatchObject({
      ok: true,
      options: { command: "devices", device: "desk-phone", format: "json" },
    });
    expect(parseArguments(["devices", "--transport-id=42"])).toMatchObject({
      ok: true,
      options: { command: "devices", transportId: "42" },
    });
    expect(parseArguments(["devices", "--last", "--json"])).toMatchObject({
      ok: true,
      options: { command: "devices", remembered: true },
    });
  });

  test("parses wireless endpoints and secure pairing-code input mode", () => {
    expect(parseArguments(["connect", "192.168.1.20:37123", "--json"])).toMatchObject({
      ok: true,
      options: { command: "connect", endpoint: "192.168.1.20:37123" },
    });
    expect(
      parseArguments(["pair", "[fd00::20]:41234", "--pairing-code-stdin", "--non-interactive"]),
    ).toMatchObject({
      ok: true,
      options: { command: "pair", endpoint: "[fd00::20]:41234", pairingCodeStdin: true },
    });
    expect(parseArguments(["pair", "192.168.1.20:41234", "--dry-run", "--json"])).toMatchObject({
      ok: true,
      options: { command: "pair", dryRun: true },
    });
  });

  test("parses explicit reverse and forward port workflows", () => {
    expect(parseArguments(["ports", "reverse", "list", "--device", "pixel"])).toMatchObject({
      ok: true,
      options: {
        command: "ports",
        portDirection: "reverse",
        portAction: "list",
        device: "pixel",
      },
    });
    expect(parseArguments(["ports", "reverse", "add", "8081", "3000", "--dry-run"])).toMatchObject({
      ok: true,
      options: {
        command: "ports",
        portDirection: "reverse",
        portAction: "add",
        primaryPort: "8081",
        secondaryPort: "3000",
        dryRun: true,
      },
    });
    expect(parseArguments(["ports", "forward", "remove", "9229", "--last"])).toMatchObject({
      ok: true,
      options: {
        command: "ports",
        portDirection: "forward",
        portAction: "remove",
        primaryPort: "9229",
        remembered: true,
      },
    });
    expect(parseArguments(["ports", "--help"])).toMatchObject({
      ok: true,
      options: { command: "help", helpTarget: "ports" },
    });
  });

  test("parses zero-config and fully custom development sessions", () => {
    expect(parseArguments(["dev"])).toMatchObject({
      ok: true,
      options: { command: "dev" },
    });
    expect(
      parseArguments([
        "dev",
        "--preset",
        "expo",
        "--package-manager",
        "bun",
        "--port",
        "8081",
        "--port=8000",
        "--no-logs",
        "--no-cleanup-ports",
        "--dry-run",
        "--",
        "node",
        "scripts/dev.mjs",
        "--literal=value",
      ]),
    ).toMatchObject({
      ok: true,
      options: {
        command: "dev",
        preset: "expo",
        packageManager: "bun",
        reversePorts: ["8081", "8000"],
        logs: false,
        cleanupPorts: false,
        dryRun: true,
        customCommand: {
          executable: "node",
          args: ["scripts/dev.mjs", "--literal=value"],
        },
      },
    });
    expect(parseArguments(["dev", "--help"])).toMatchObject({
      ok: true,
      options: { command: "help", helpTarget: "dev" },
    });
  });

  test("rejects invalid or misplaced development options", () => {
    expect(parseArguments(["dev", "--preset", "flutter"])).toMatchObject({
      ok: false,
      code: "CLI_INVALID_VALUE",
    });
    expect(parseArguments(["dev", "--port", "0"])).toMatchObject({
      ok: false,
      code: "CLI_INVALID_VALUE",
    });
    expect(parseArguments(["doctor", "--no-logs"])).toMatchObject({
      ok: false,
      code: "CLI_USAGE",
    });
    expect(parseArguments(["dev", "--"])).toMatchObject({
      ok: false,
      code: "CLI_USAGE",
    });
  });

  test("rejects incomplete and over-specified port workflows", () => {
    expect(parseArguments(["ports"])).toMatchObject({ ok: false, code: "CLI_USAGE" });
    expect(parseArguments(["ports", "sideways", "list"])).toMatchObject({
      ok: false,
      code: "CLI_USAGE",
    });
    expect(parseArguments(["ports", "reverse", "add"])).toMatchObject({
      ok: false,
      code: "CLI_USAGE",
    });
    expect(parseArguments(["ports", "forward", "remove", "8081", "3000"])).toMatchObject({
      ok: false,
      code: "CLI_USAGE",
    });
  });

  test("rejects unknown commands and options", () => {
    expect(parseArguments(["launch"])).toMatchObject({ ok: false, code: "CLI_USAGE" });
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
    expect(parseArguments(["doctor", "--profile=bad/name"])).toMatchObject({
      ok: false,
      code: "CLI_INVALID_VALUE",
      option: "--profile",
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
    expect(parseArguments(["devices", "--select", "--non-interactive"])).toMatchObject({
      ok: false,
      code: "CLI_USAGE",
      option: "--select",
    });
    expect(parseArguments(["devices", "--select", "--json"])).toMatchObject({
      ok: false,
      code: "CLI_USAGE",
      option: "--select",
    });
    expect(parseArguments(["devices", "--select", "--device", "usb-1"])).toMatchObject({
      ok: false,
      code: "CLI_USAGE",
    });
    expect(parseArguments(["devices", "--device", "usb-1", "--transport-id", "1"])).toMatchObject({
      ok: false,
      code: "CLI_USAGE",
    });
    expect(parseArguments(["devices", "--last", "--select"])).toMatchObject({
      ok: false,
      code: "CLI_USAGE",
    });
    expect(parseArguments(["devices", "--dry-run"])).toMatchObject({
      ok: false,
      option: "--dry-run",
    });
  });
});
