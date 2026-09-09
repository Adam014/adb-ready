import { describe, expect, test } from "bun:test";
import { EventBus } from "../../src/core/event-bus.js";

describe("EventBus", () => {
  test("emits versioned events with deterministic sequence and time", () => {
    const clockValues = [
      new Date("2026-09-09T10:00:00.000Z"),
      new Date("2026-09-09T10:00:01.000Z"),
    ];
    const fallback = new Date("2026-09-09T10:00:01.000Z");
    let clockIndex = 0;
    const bus = new EventBus(() => clockValues[clockIndex++] ?? fallback);
    const received: unknown[] = [];
    bus.subscribe((event) => received.push(event));

    const first = bus.emit({
      type: "operation.started",
      source: "test",
      severity: "info",
      message: "Started",
      correlation: { commandId: "command-1", operationId: "operation-1" },
    });
    const second = bus.emit({
      type: "operation.completed",
      source: "test",
      severity: "info",
      message: "Finished",
      correlation: { commandId: "command-1", operationId: "operation-1" },
      data: { durationMs: 1000 },
    });

    expect(first.schemaVersion).toBe(1);
    expect(first.sequence).toBe(1);
    expect(first.timestamp).toBe("2026-09-09T10:00:00.000Z");
    expect(second.sequence).toBe(2);
    expect(second.timestamp).toBe("2026-09-09T10:00:01.000Z");
    expect(received).toEqual([first, second]);
  });

  test("unsubscribe stops future delivery", () => {
    const bus = new EventBus(() => new Date("2026-09-09T10:00:00.000Z"));
    const messages: string[] = [];
    const unsubscribe = bus.subscribe((event) => messages.push(event.message));

    bus.emit({
      type: "test",
      source: "test",
      severity: "info",
      message: "before",
      correlation: { commandId: "command-1" },
    });
    unsubscribe();
    bus.emit({
      type: "test",
      source: "test",
      severity: "info",
      message: "after",
      correlation: { commandId: "command-1" },
    });

    expect(messages).toEqual(["before"]);
  });
});
