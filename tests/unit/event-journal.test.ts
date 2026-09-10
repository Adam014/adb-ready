import { describe, expect, test } from "bun:test";
import { EventBus } from "../../src/core/event-bus.js";
import { EventJournal } from "../../src/core/event-journal.js";

describe("EventJournal", () => {
  test("keeps a bounded, ordered, defensively redacted timeline", () => {
    const bus = new EventBus(() => new Date("2026-09-10T10:00:00.000Z"));
    const journal = new EventJournal(bus, { maxEntries: 2, maxBytes: 8_000 });
    for (const [index, message] of ["old", "authorization=secret-token", "new"].entries()) {
      bus.emit({
        type: "child.stdout",
        source: "child.stdout",
        severity: "info",
        message,
        correlation: { commandId: "command", sessionId: "session" },
        data: { index, nested: { password: "password=hunter2" } },
      });
    }

    const snapshot = journal.close();
    expect(snapshot.events.map(({ sequence }) => sequence)).toEqual([2, 3]);
    expect(snapshot.dropped).toBe(1);
    expect(JSON.stringify(snapshot.events)).not.toContain("secret-token");
    expect(JSON.stringify(snapshot.events)).not.toContain("hunter2");
    expect(snapshot.bytes).toBeLessThanOrEqual(8_000);
  });

  test("applies source and minimum-severity filters before retention", () => {
    const bus = new EventBus();
    const journal = new EventJournal(bus, {
      sources: ["child.stderr"],
      minimumSeverity: "warning",
    });
    for (const [source, severity] of [
      ["child.stdout", "error"],
      ["child.stderr", "info"],
      ["child.stderr", "error"],
    ] as const) {
      bus.emit({
        type: source,
        source,
        severity,
        message: source,
        correlation: { commandId: "command" },
      });
    }
    expect(journal.close().events).toHaveLength(1);
  });

  test("redacts project-specific literal values before journal retention", () => {
    const bus = new EventBus();
    const journal = new EventJournal(bus, {
      redaction: { additionalLiterals: ["private-project-value"] },
    });
    bus.emit({
      type: "child.stdout",
      source: "child.stdout",
      severity: "info",
      message: "value=private-project-value",
      correlation: { commandId: "command" },
      data: { raw: "private-project-value" },
    });
    const serialized = JSON.stringify(journal.close());
    expect(serialized).not.toContain("private-project-value");
    expect(serialized).toContain("[REDACTED]");
  });

  test("rejects unbounded or invalid retention settings", () => {
    const bus = new EventBus();
    expect(() => new EventJournal(bus, { maxEntries: 0 })).toThrow();
    expect(() => new EventJournal(bus, { maxBytes: 0 })).toThrow();
  });
});
