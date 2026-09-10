import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RECOVERY_POLICY,
  recoveryAttemptAllowed,
  recoveryDelayMs,
  resolveRecoveryPolicy,
} from "../../src/session/recovery-policy.js";
import { SessionStateMachine } from "../../src/session/state-machine.js";

describe("SessionStateMachine", () => {
  test("records the complete healthy lifecycle without exposing mutable history", () => {
    const machine = new SessionStateMachine(() => new Date("2026-09-10T10:00:00.000Z"));
    machine.transition("acquiring-target", "resolve target");
    machine.transition("preparing-ports", "target ready");
    machine.transition("starting-child", "ports verified");
    machine.transition("ready", "child ready");
    machine.transition("stopping", "user interrupted");
    machine.transition("ended", "resources cleaned");

    expect(machine.state).toBe("ended");
    expect(machine.history.map(({ to }) => to)).toEqual([
      "acquiring-target",
      "preparing-ports",
      "starting-child",
      "ready",
      "stopping",
      "ended",
    ]);
    expect(machine.history[0]?.timestamp).toBe("2026-09-10T10:00:00.000Z");
  });

  test("supports bounded degradation and recovery cycles", () => {
    const machine = new SessionStateMachine();
    machine.transition("acquiring-target", "resolve target");
    machine.transition("preparing-ports", "target ready");
    machine.transition("attaching-child", "server already running");
    machine.transition("ready", "attached");
    machine.transition("degraded", "target disappeared");
    machine.transition("recovering", "safe recovery started");
    machine.transition("degraded", "first attempt failed");
    machine.transition("recovering", "retrying");
    machine.transition("ready", "target and ports verified");

    expect(machine.state).toBe("ready");
  });

  test("rejects impossible or unexplained transitions", () => {
    const machine = new SessionStateMachine();
    expect(() => machine.transition("ready", "skip preparation")).toThrow(
      "Invalid session transition",
    );
    expect(() => machine.transition("acquiring-target", "   ")).toThrow("requires a reason");
  });
});

describe("recovery policy", () => {
  test("uses conservative bounded defaults and capped exponential backoff", () => {
    const policy = resolveRecoveryPolicy();
    expect(policy).toEqual(DEFAULT_RECOVERY_POLICY);
    expect([1, 2, 3, 4].map((attempt) => recoveryDelayMs(policy, attempt))).toEqual([
      500, 1_000, 2_000, 4_000,
    ]);
    expect(recoveryAttemptAllowed(policy, 3, 29_999)).toBeTrue();
    expect(recoveryAttemptAllowed(policy, 4, 1_000)).toBeFalse();
    expect(recoveryAttemptAllowed(policy, 1, 30_000)).toBeFalse();
  });

  test("validates unsafe or unbounded inputs", () => {
    expect(() => resolveRecoveryPolicy({ maxAttempts: 0 })).toThrow("maxAttempts");
    expect(() => resolveRecoveryPolicy({ initialDelayMs: 2_000, maxDelayMs: 1_000 })).toThrow(
      "maxDelayMs",
    );
    expect(() => recoveryDelayMs(resolveRecoveryPolicy(), 0)).toThrow("attempt");
    expect(() => recoveryAttemptAllowed(resolveRecoveryPolicy(), 1, -1)).toThrow("elapsedMs");
  });
});
