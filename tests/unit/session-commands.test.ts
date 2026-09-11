import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runContextCommand,
  runProblemsCommand,
  runSessionCommand,
} from "../../src/app/session-commands.js";
import { EventBus } from "../../src/core/event-bus.js";
import type { Problem } from "../../src/domain/contracts.js";
import { SessionRecorder } from "../../src/state/session-store.js";

const problem: Problem = {
  code: "TARGET_OFFLINE",
  category: "target.state",
  severity: "error",
  summary: "Target went offline.",
  detail: "Reconnect the selected target.",
  retryable: true,
  evidence: [],
  actions: [],
  correlation: { commandId: "command-1" },
};

describe("session history commands", () => {
  test("lists, resolves latest, reads events, and exposes structured problems", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-session-command-"));
    try {
      for (const [index, timestamp] of [
        "2026-09-10T10:00:00.000Z",
        "2026-09-10T10:01:00.000Z",
      ].entries()) {
        const bus = new EventBus(() => new Date(timestamp));
        const recorder = await SessionRecorder.create(
          bus,
          { sessionId: `session-${String(index)}`, command: "dev", startedAt: timestamp },
          { directory, maxAgeDays: 3650, projectRoot: "/workspace/current" },
        );
        bus.emit({
          type: "session.started",
          source: "session",
          severity: "info",
          message: "Development session started",
          correlation: { commandId: "command-1", sessionId: `session-${String(index)}` },
        });
        await recorder.finish({
          status: index === 0 ? "completed" : "failed",
          finishedAt: timestamp,
          problems: index === 0 ? [] : [problem],
        });
      }

      const dependencies = {
        idFactory: () => "result-1",
        clock: () => new Date("2026-09-10T11:00:00.000Z"),
      };
      const store = { directory, projectRoot: "/workspace/current" };
      const listed = await runSessionCommand("list", undefined, store, dependencies);
      expect(listed.result.data).toMatchObject({
        action: "list",
        sessions: [{ sessionId: "session-1" }, { sessionId: "session-0" }],
      });
      const filtered = await runSessionCommand("list", undefined, store, dependencies, {
        status: "failed",
        sinceMs: 3_600_000,
        limit: 1,
      });
      expect(filtered.result.data).toMatchObject({
        sessions: [{ sessionId: "session-1", status: "failed" }],
      });
      const shown = await runSessionCommand("show", undefined, store, dependencies);
      expect(shown.result.data).toMatchObject({
        action: "show",
        session: { sessionId: "session-1", status: "failed" },
      });
      const events = await runSessionCommand("events", "session-0", store, dependencies);
      expect(events.result.data).toMatchObject({
        action: "events",
        session: { sessionId: "session-0" },
        events: [{ type: "session.started" }],
      });
      const problems = await runProblemsCommand(undefined, store, dependencies);
      expect(problems.result.data).toMatchObject({
        sessionId: "session-1",
        status: "failed",
        problems: [{ code: "TARGET_OFFLINE", retryable: true }],
      });
      const context = await runContextCommand(undefined, 2_000, store, dependencies);
      expect(context.result.data).toMatchObject({
        sessionId: "session-1",
        status: "failed",
        characterBudget: 2_000,
        includedEvents: 1,
      });
      expect(context.result.data?.markdown).toContain("# ADB Ready diagnostic context");
      expect(context.result.data?.markdown).toContain("TARGET_OFFLINE");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("returns a structured error when no saved session exists", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-session-command-"));
    try {
      const result = await runSessionCommand("show", undefined, { directory });
      expect(result.exitCode).toBe(10);
      expect(result.result).toMatchObject({
        ok: false,
        data: null,
        problems: [{ code: "SESSION_NOT_FOUND" }],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
