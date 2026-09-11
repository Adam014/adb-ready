import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandExecution, DevData } from "../../src/app/commands.js";
import { writeEvidenceBundle } from "../../src/automation/evidence-bundle.js";

function execution(): CommandExecution<DevData> {
  return {
    exitCode: 9,
    result: {
      schemaVersion: 1,
      command: "run",
      commandId: "command-1",
      ok: false,
      startedAt: "2026-09-11T10:00:00.000Z",
      finishedAt: "2026-09-11T10:00:01.000Z",
      durationMs: 1_000,
      data: {
        sessionId: "session-1",
        status: "failed",
        adbPath: "/sdk/adb",
        selected: {
          target: {
            id: "target-secret",
            serial: "serial-secret",
            name: "Pixel",
            hardwareSerial: "hardware-secret",
            state: "device",
            transports: [],
          },
          transport: { serial: "serial-secret", state: "device", kind: "usb", stable: true },
          reason: "only-ready",
        },
        project: { root: "~/project", name: "app" },
        preset: "custom",
        ports: { requested: [], created: [], reused: [], cleaned: true },
        command: { executable: "dev", args: [], cwd: "~/project", envKeys: [] },
        verification: {
          command: { executable: "test", args: [], cwd: "~/project", envKeys: [] },
          passed: false,
          exitCode: 9,
          signal: null,
          durationMs: 10,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        },
        journal: {
          dropped: 0,
          bytes: 10,
          events: [
            {
              schemaVersion: 1,
              sequence: 1,
              timestamp: "2026-09-11T10:00:00.500Z",
              type: "verification.stderr",
              source: "verification.stderr",
              severity: "error",
              message: "failed on serial-secret token=very-secret",
              correlation: { commandId: "command-1", sessionId: "session-1" },
            },
          ],
        },
        hooks: { completed: 0, failed: 0 },
        recovery: {
          checks: 0,
          degradations: 0,
          recoveryAttempts: 0,
          recoveries: 0,
          targetChanges: 0,
          failed: false,
        },
      },
      problems: [
        {
          code: "VERIFICATION_FAILED",
          category: "verification.exit",
          severity: "error",
          summary: "Verification failed.",
          detail: "token=very-secret",
          retryable: true,
          evidence: [],
          actions: [],
          correlation: { commandId: "command-1" },
        },
      ],
    },
  };
}

describe("writeEvidenceBundle", () => {
  test("writes one redacted, checksummed, CI-readable run bundle atomically", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-evidence-"));
    try {
      const written = await writeEvidenceBundle(execution(), {
        cwd: root,
        idFactory: () => "run-1",
      });
      expect(written.execution.exitCode).toBe(9);
      expect(written.execution.result.data).toMatchObject({
        outcome: "verification-failure",
        evidence: { path: path.join(".adb-ready", "artifacts", "run-1") },
      });
      const manifest = JSON.parse(
        await readFile(path.join(written.artifactPath, "manifest.json"), "utf8"),
      );
      expect(manifest.files.map(({ path: name }: { path: string }) => name).sort()).toEqual([
        "context.md",
        "events.ndjson",
        "github-summary.md",
        "junit.xml",
        "logcat.txt",
        "problems.json",
        "result.json",
      ]);
      for (const file of manifest.files) {
        const content = await readFile(path.join(written.artifactPath, file.path));
        expect(content.byteLength).toBe(file.bytes);
        expect(createHash("sha256").update(content).digest("hex")).toBe(file.sha256);
      }
      const serialized = await readFile(path.join(written.artifactPath, "result.json"), "utf8");
      expect(serialized).not.toContain("serial-secret");
      expect(serialized).not.toContain("hardware-secret");
      expect(serialized).not.toContain("very-secret");
      expect(serialized).toContain("[REDACTED]");
      expect(await readFile(path.join(written.artifactPath, "junit.xml"), "utf8")).toContain(
        'failures="1"',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
