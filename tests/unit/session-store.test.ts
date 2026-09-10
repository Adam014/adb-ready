import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
      const finished = await recorder.finish({
        status: "completed",
        finishedAt: "2026-09-10T10:02:00.000Z",
        targetIdentity: "PHONE-SECRET",
        projectName: "sample-app",
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
      const recorder = await SessionRecorder.create(
        new EventBus(),
        { sessionId: "running-1", command: "dev", startedAt: new Date().toISOString() },
        { directory },
      );
      const sessions = await listSessions({ directory });
      expect(sessions).toMatchObject({ ok: true, value: [{ status: "running" }] });
      await recorder.finish({ status: "interrupted", finishedAt: new Date().toISOString() });
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
