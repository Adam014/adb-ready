import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventBus } from "../../src/core/event-bus.js";
import {
  defaultSessionStoreDirectory,
  listSessions,
  readSession,
  readSessionEvents,
  SessionRecorder,
} from "../../src/state/session-store.js";

async function waitForEventCount(directory: string, sessionId: string, count: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const events = await readSessionEvents(sessionId, { directory });
    if (events.ok && events.value.length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Session ${sessionId} did not persist ${String(count)} events in time.`);
}

describe("session storage paths", () => {
  test("uses platform-native per-user state locations", () => {
    expect(defaultSessionStoreDirectory("linux", {}, "/home/dev")).toBe(
      "/home/dev/.local/state/adb-ready/sessions",
    );
    expect(defaultSessionStoreDirectory("darwin", {}, "/Users/dev")).toBe(
      "/Users/dev/Library/Application Support/adb-ready/sessions",
    );
    expect(
      defaultSessionStoreDirectory(
        "win32",
        { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
        "C:\\Users\\dev",
      ),
    ).toBe("C:\\Users\\dev\\AppData\\Local\\adb-ready\\sessions");
    expect(defaultSessionStoreDirectory("linux", { XDG_STATE_HOME: "/state" }, "/home/dev")).toBe(
      "/state/adb-ready/sessions",
    );
  });
});

describe("SessionRecorder", () => {
  test("persists ordered redacted events and a finalized manifest", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-sessions-"));
    try {
      const bus = new EventBus(() => new Date("2026-09-10T10:00:00.000Z"));
      const recorder = await SessionRecorder.create(
        bus,
        {
          sessionId: "session-1",
          command: "dev",
          startedAt: "2026-09-10T10:00:00.000Z",
          projectRoot: "/workspace/sample-app",
        },
        { directory, redaction: { additionalLiterals: ["private-marker"] } },
      );
      bus.emit({
        type: "target.selected",
        source: "target",
        severity: "info",
        message: "Selected USB-SERIAL-SECRET",
        correlation: {
          commandId: "command-1",
          sessionId: "session-1",
          targetId: "hardware:PHONE-SECRET",
        },
        data: { serial: "USB-SERIAL-SECRET" },
      });
      bus.emit({
        type: "child.stdout",
        source: "child.stdout",
        severity: "info",
        message: "token=very-secret-value private-marker",
        correlation: { commandId: "command-1", sessionId: "session-1" },
      });
      bus.emit({
        type: "health.checked",
        source: "recovery",
        severity: "debug",
        message: "Routine health check",
        correlation: { commandId: "command-1", sessionId: "session-1" },
        data: { presentation: "background", retention: "transient" },
      });
      const finished = await recorder.finish({
        status: "completed",
        finishedAt: "2026-09-10T10:02:00.000Z",
        targetIdentity: "PHONE-SECRET",
        preset: "expo",
      });

      expect(finished).toMatchObject({
        ok: true,
        value: {
          status: "completed",
          eventCount: 2,
          projectFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/u),
          preset: "expo",
        },
      });
      const manifest = await readSession("session-1", { directory });
      expect(manifest).toMatchObject({ ok: true, value: { eventCount: 2 } });
      const events = await readSessionEvents("session-1", { directory });
      expect(events.ok).toBeTrue();
      if (!events.ok) return;
      expect(events.value.map(({ sequence }) => sequence)).toEqual([1, 2]);
      const serialized = JSON.stringify(events.value);
      expect(serialized).not.toContain("USB-SERIAL-SECRET");
      expect(serialized).not.toContain("PHONE-SECRET");
      expect(serialized).not.toContain("very-secret-value");
      expect(serialized).not.toContain("private-marker");
      expect(serialized).toContain("[REDACTED]");
      if (process.platform !== "win32") {
        expect((await stat(path.join(directory, "session-1.ndjson"))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps a readable running manifest before finalization", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-sessions-"));
    try {
      const timestamps = ["2026-09-10T10:00:01.000Z", "2026-09-10T10:00:02.000Z"];
      const bus = new EventBus(() => new Date(timestamps.shift() ?? "2026-09-10T10:00:02.000Z"));
      const recorder = await SessionRecorder.create(
        bus,
        {
          sessionId: "running-1",
          command: "dev",
          startedAt: "2026-09-10T10:00:00.000Z",
        },
        { directory },
      );
      bus.emit({
        type: "session.configured",
        source: "session",
        severity: "info",
        message: "Development session configured for expo",
        correlation: { commandId: "command-1", sessionId: "running-1" },
        data: { preset: "expo" },
      });
      bus.emit({
        type: "child.started",
        source: "child",
        severity: "info",
        message: "Development command started",
        correlation: { commandId: "command-1", sessionId: "running-1" },
      });
      await waitForEventCount(directory, "running-1", 2);
      await appendFile(path.join(directory, "running-1.ndjson"), '{"partial":', "utf8");

      const sessions = await listSessions({ directory });
      expect(sessions).toMatchObject({
        ok: true,
        value: [
          {
            status: "running",
            eventCount: 2,
            preset: "expo",
            updatedAt: "2026-09-10T10:00:02.000Z",
          },
        ],
      });
      const session = await readSession("running-1", { directory });
      expect(session).toMatchObject({
        ok: true,
        value: { eventCount: 2, preset: "expo", updatedAt: "2026-09-10T10:00:02.000Z" },
      });
      const events = await readSessionEvents("running-1", { directory });
      expect(events).toMatchObject({ ok: true, value: [{ sequence: 1 }, { sequence: 2 }] });
      await recorder.finish({ status: "interrupted", finishedAt: new Date().toISOString() });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("preserves unrelated diagnostic identifiers after observing a short transport ID", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-sessions-redaction-"));
    try {
      const bus = new EventBus(() => new Date("2026-09-13T10:00:00.000Z"));
      const recorder = await SessionRecorder.create(
        bus,
        {
          sessionId: "af644c67-3270-4c89",
          command: "dev",
          startedAt: "2026-09-13T10:00:00.000Z",
        },
        { directory },
      );
      bus.emit({
        type: "adb.operation.started",
        source: "adb",
        severity: "debug",
        message: "Running target-scoped ADB operation",
        correlation: { commandId: "command-1", sessionId: "af644c67-3270-4c89" },
        data: { args: ["-t", "32", "shell", "getprop", "ro.serialno"] },
      });
      bus.emit({
        type: "hook.completed",
        source: "hook",
        severity: "info",
        message: "Hook completed for session af644c67-3270-4c89",
        correlation: { commandId: "command-1", sessionId: "af644c67-3270-4c89" },
      });
      await recorder.finish({
        status: "completed",
        finishedAt: "2026-09-13T10:01:00.000Z",
      });

      const events = await readSessionEvents("af644c67-3270-4c89", { directory });
      expect(events.ok).toBeTrue();
      if (!events.ok) return;
      expect(events.value[0]?.data?.args).toEqual(["-t", "32", "shell", "getprop", "ro.serialno"]);
      expect(events.value[1]?.message).toContain("af644c67-3270-4c89");
      expect(events.value[1]?.message).not.toContain("[REDACTED]");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports an event persistence failure instead of claiming a complete session", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-sessions-failure-"));
    try {
      const bus = new EventBus();
      const recorder = await SessionRecorder.create(
        bus,
        {
          sessionId: "session-write-failure",
          command: "dev",
          startedAt: "2026-09-10T10:00:00.000Z",
        },
        { directory },
      );
      const events = path.join(directory, "session-write-failure.ndjson");
      await rm(events);
      await mkdir(events);
      bus.emit({
        type: "target.selected",
        source: "target",
        severity: "info",
        message: "Connected endpoint-secret",
        correlation: { commandId: "command-1", targetId: "target-secret" },
        data: { args: ["connect", "endpoint-secret"] },
      });

      await expect(
        recorder.finish({ status: "completed", finishedAt: "2026-09-10T10:01:00.000Z" }),
      ).resolves.toMatchObject({ ok: false, code: "SESSION_UNWRITABLE" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("prunes only finalized sessions beyond the configured count", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-sessions-"));
    try {
      for (const [index, timestamp] of [
        "2026-09-10T10:00:00.000Z",
        "2026-09-10T10:01:00.000Z",
      ].entries()) {
        const recorder = await SessionRecorder.create(
          new EventBus(),
          {
            sessionId: `retained-${String(index)}`,
            command: "dev",
            startedAt: timestamp,
          },
          { directory, maxSessions: 1, maxAgeDays: 3650 },
        );
        await recorder.finish({ status: "completed", finishedAt: timestamp });
      }
      const sessions = await listSessions({ directory });
      expect(sessions).toMatchObject({
        ok: true,
        value: [{ sessionId: "retained-1" }],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("scopes listing and direct reads to the canonical project", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-sessions-"));
    try {
      for (const projectRoot of ["/workspace/alpha", "/workspace/beta"]) {
        const recorder = await SessionRecorder.create(
          new EventBus(),
          {
            sessionId: path.basename(projectRoot),
            command: "dev",
            startedAt: "2026-09-10T10:00:00.000Z",
            projectRoot,
          },
          { directory },
        );
        await recorder.finish({
          status: "completed",
          finishedAt: "2026-09-10T10:01:00.000Z",
        });
      }
      expect(await listSessions({ directory, projectRoot: "/workspace/alpha" })).toMatchObject({
        ok: true,
        value: [{ sessionId: "alpha" }],
      });
      expect(
        await readSession("beta", { directory, projectRoot: "/workspace/alpha" }),
      ).toMatchObject({
        ok: false,
        code: "SESSION_UNREADABLE",
      });
      expect(await listSessions({ directory, allProjects: true })).toMatchObject({
        ok: true,
        value: [{ sessionId: "alpha" }, { sessionId: "beta" }],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects traversal-like session identifiers", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-sessions-"));
    try {
      expect(
        SessionRecorder.create(
          new EventBus(),
          { sessionId: "../escape", command: "dev", startedAt: new Date().toISOString() },
          { directory },
        ),
      ).rejects.toBeInstanceOf(RangeError);
      expect(await readSession("../escape", { directory })).toMatchObject({
        ok: false,
        code: "SESSION_INVALID",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
