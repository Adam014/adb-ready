import { describe, expect, test } from "bun:test";
import { abortableDelay, type SessionHealth, watchSession } from "../../src/session/watcher.js";

const HEALTHY: SessionHealth = {
  targetReady: true,
  targetSerial: "USB-1",
  missingPorts: [],
  conflictingPorts: [],
};

describe("watchSession", () => {
  test("repairs an unhealthy session and independently verifies it", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    let observations = 0;
    const summary = await watchSession({
      signal: controller.signal,
      intervalMs: 1,
      policy: { initialDelayMs: 1, maxDelayMs: 1 },
      sleep: async () => true,
      observe: async () => {
        observations += 1;
        if (observations === 1) {
          return {
            ...HEALTHY,
            targetReady: false,
            missingPorts: [{ device: "tcp:8081", host: "tcp:8081" }],
          };
        }
        controller.abort();
        return HEALTHY;
      },
      recover: async (_health, attempt) => ({
        changedTarget: attempt === 1,
        detail: "target reconnected and mapping restored",
      }),
      onEvent: ({ type }) => events.push(type),
    });

    expect(summary).toMatchObject({
      checks: 2,
      degradations: 1,
      recoveryAttempts: 1,
      recoveries: 1,
      targetChanges: 1,
      failed: false,
    });
    expect(events).toEqual([
      "health.checked",
      "session.degraded",
      "recovery.started",
      "health.checked",
      "recovery.completed",
    ]);
  });

  test("stops after the bounded recovery budget is exhausted", async () => {
    let now = 0;
    const summary = await watchSession({
      signal: new AbortController().signal,
      intervalMs: 1,
      policy: { initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 2, totalTimeoutMs: 100 },
      clock: () => now++,
      sleep: async () => true,
      observe: async () => ({ ...HEALTHY, targetReady: false, detail: "target offline" }),
      recover: async () => ({ changedTarget: false }),
    });

    expect(summary).toMatchObject({
      checks: 3,
      degradations: 1,
      recoveryAttempts: 2,
      recoveries: 0,
      failed: true,
    });
  });

  test("does not poll after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    let observations = 0;
    const summary = await watchSession({
      signal: controller.signal,
      observe: async () => {
        observations += 1;
        return HEALTHY;
      },
      recover: async () => ({ changedTarget: false }),
    });

    expect(observations).toBe(0);
    expect(summary.failed).toBeFalse();
  });

  test("converts unexpected observer failures into a bounded watch failure", async () => {
    const events: Array<{ type: string; detail?: string }> = [];
    const summary = await watchSession({
      signal: new AbortController().signal,
      intervalMs: 1,
      sleep: async () => true,
      observe: async () => {
        throw new Error("probe crashed");
      },
      recover: async () => ({ changedTarget: false }),
      onEvent: ({ type, detail }) =>
        events.push({ type, ...(detail === undefined ? {} : { detail }) }),
    });

    expect(summary).toMatchObject({ checks: 0, failed: true });
    expect(events).toEqual([
      { type: "watch.failed", detail: "Health operation failed: probe crashed" },
    ]);
  });
});

describe("abortableDelay", () => {
  test("settles immediately when aborted and removes timer work", async () => {
    const controller = new AbortController();
    const pending = abortableDelay(10_000, controller.signal);
    controller.abort();
    expect(await pending).toBeFalse();
  });
});
