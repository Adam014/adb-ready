import { describe, expect, test } from "bun:test";
import automationSchema from "../../schema/automation-v1.schema.json" with { type: "json" };
import { ExitCode, SCHEMA_VERSION } from "../../src/domain/contracts.js";

describe("public automation contract", () => {
  test("keeps result and event schemas aligned with the runtime version", () => {
    expect(automationSchema.$defs.result.properties.schemaVersion.const).toBe(SCHEMA_VERSION);
    expect(automationSchema.$defs.event.properties.schemaVersion.const).toBe(SCHEMA_VERSION);
    expect(automationSchema.$defs.result.required).toEqual([
      "schemaVersion",
      "command",
      "commandId",
      "ok",
      "startedAt",
      "finishedAt",
      "durationMs",
      "data",
      "problems",
    ]);
    expect(automationSchema.$defs.event.required).toEqual([
      "schemaVersion",
      "sequence",
      "timestamp",
      "type",
      "source",
      "severity",
      "message",
      "correlation",
    ]);
  });

  test("keeps stable exit categories explicit", () => {
    expect({
      Success: ExitCode.Success,
      InvalidInput: ExitCode.InvalidInput,
      Environment: ExitCode.Environment,
      Target: ExitCode.Target,
      AdbOperation: ExitCode.AdbOperation,
      ChildProcess: ExitCode.ChildProcess,
      Internal: ExitCode.Internal,
      Interrupted: ExitCode.Interrupted,
    }).toEqual({
      Success: 0,
      InvalidInput: 2,
      Environment: 10,
      Target: 20,
      AdbOperation: 30,
      ChildProcess: 40,
      Internal: 70,
      Interrupted: 130,
    });
  });
});
