import { describe, expect, test } from "bun:test";
import { type ReadinessAssertionResult, waitForReadiness } from "../../src/automation/readiness.js";

describe("waitForReadiness", () => {
  test("polls failed assertions until every assertion passes", async () => {
    let now = 0;
    let calls = 0;
    const result = await waitForReadiness(
      [{ kind: "boot" }, { kind: "host-port", port: 8081 }],
      async (assertion): Promise<ReadinessAssertionResult> => {
        calls += 1;
        const passed = calls > 2;
        return {
          assertion,
          status: passed ? "passed" : "failed",
          detail: passed ? "ready" : "waiting",
          durationMs: 1,
        };
      },
      {
        timeoutMs: 2_000,
        pollIntervalMs: 100,
        clock: () => new Date(now),
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      },
    );

    expect(result).toMatchObject({ ready: true, attempts: 2, timedOut: false });
    expect(result.assertions.every(({ status }) => status === "passed")).toBeTrue();
  });

  test("fails immediately and honestly when a required probe is unsupported", async () => {
    const result = await waitForReadiness([{ kind: "unlocked" }], async (assertion) => ({
      assertion,
      status: "unsupported",
      detail: "not exposed",
      durationMs: 1,
    }));

    expect(result).toMatchObject({ ready: false, attempts: 1, timedOut: false });
  });

  test("returns an immediately ready result for an explicit empty contract", async () => {
    const result = await waitForReadiness([], async () => {
      throw new Error("probe should not run");
    });
    expect(result).toEqual({
      ready: true,
      attempts: 0,
      durationMs: 0,
      timedOut: false,
      assertions: [],
    });
  });
});
