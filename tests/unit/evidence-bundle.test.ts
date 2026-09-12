import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
        readiness: {
          ready: false,
          attempts: 1,
          durationMs: 10,
          timedOut: true,
          assertions: [
            {
              assertion: { kind: "ui", selector: "text=Ready" },
              status: "failed",
              detail: "Ready was not visible.",
              durationMs: 5,
            },
          ],
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
            {
              schemaVersion: 1,
              sequence: 2,
              timestamp: "2026-09-11T10:00:00.600Z",
              type: "logcat.line",
              source: "logcat",
              severity: "warning",
              message: "Android warning",
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

  test("classifies every automation outcome and writes a bounded GitHub summary", async () => {
    const cases = [
      { code: "OPERATION_INTERRUPTED", severity: "error", expected: "cancelled" },
      { code: "READINESS_FAILED", severity: "error", expected: "product-not-ready" },
      { code: "ADB_NOT_FOUND", severity: "error", expected: "infrastructure-failure" },
      { code: "NOTICE", severity: "warning", expected: "success" },
    ] as const;

    for (const [index, item] of cases.entries()) {
      const root = await mkdtemp(path.join(tmpdir(), "adb-ready-evidence-outcome-"));
      try {
        const current = execution();
        const sourceProblem = current.result.problems[0];
        if (sourceProblem === undefined) throw new Error("Missing problem fixture");
        current.result.problems = [
          {
            ...sourceProblem,
            code: item.code,
            severity: item.severity,
            summary: "A <problem> & its details.",
          },
        ];
        current.result.data = null;
        current.result.ok = item.expected === "success";
        const summary = path.join(root, "summary.md");
        if (index === 3) await mkdir(summary);
        else await writeFile(summary, "Existing summary\n");

        const written = await writeEvidenceBundle(current, {
          cwd: root,
          idFactory: () => `outcome-${String(index)}`,
          maxContextCharacters: 160,
          githubStepSummaryPath: summary,
        });

        expect(written.execution.result.data?.outcome).toBe(item.expected);
        if (index !== 3) {
          expect(await readFile(summary, "utf8")).toContain(`Outcome | **${item.expected}**`);
        }
        expect(await readFile(path.join(written.artifactPath, "context.md"), "utf8")).toContain(
          "[context truncated]",
        );
        expect(await readFile(path.join(written.artifactPath, "junit.xml"), "utf8")).toContain(
          item.expected === "success" ? 'failures="0"' : 'failures="1"',
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("cleans an incomplete temporary bundle when atomic publication fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-evidence-collision-"));
    const collision = path.join(root, ".adb-ready", "artifacts", "run-collision");
    try {
      await mkdir(collision, { recursive: true });
      await writeFile(path.join(collision, "owned.txt"), "existing artifact");

      await expect(
        writeEvidenceBundle(execution(), {
          cwd: root,
          idFactory: () => "run-collision",
        }),
      ).rejects.toThrow();
      expect(await readFile(path.join(collision, "owned.txt"), "utf8")).toBe("existing artifact");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
