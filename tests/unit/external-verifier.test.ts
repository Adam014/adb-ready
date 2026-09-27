import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyExternalVerifier,
  collectNativeVerifierArtifacts,
  prepareExternalVerifier,
} from "../../src/automation/external-verifier.js";

describe("external verifier adapters", () => {
  test("pins Maestro to the leased target and requests native CI evidence", () => {
    const prepared = prepareExternalVerifier(
      { executable: "maestro", args: ["test", ".maestro/smoke.yaml"] },
      { cwd: "/project", serial: "emulator-5554", sessionId: "session-1" },
    );

    expect(prepared).toMatchObject({
      adapter: "maestro",
      targetArgument: "emulator-5554",
      artifactReferences: ["report.xml", "artifacts/"],
      command: {
        args: [
          "--device=emulator-5554",
          "test",
          ".maestro/smoke.yaml",
          "--format=junit",
          expect.stringContaining("--output="),
          expect.stringContaining("--test-output-dir="),
          expect.stringContaining("--debug-output="),
        ],
      },
    });
    expect(prepared.command.env?.ADB_READY_VERIFIER_OUTPUT_DIR).toBe(prepared.artifactDirectory);
  });

  test("never silently retargets an explicit Maestro device", () => {
    const prepared = prepareExternalVerifier(
      { executable: "maestro", args: ["--device", "device-B", "test", "flow.yaml"] },
      { cwd: "/project", serial: "device-A", sessionId: "session-2" },
    );

    expect(prepared).toMatchObject({
      adapter: "maestro",
      targetArgument: "device-B",
      targetMismatch: "device-B",
    });
    expect(prepared.command.args.filter((argument) => argument === "--device")).toHaveLength(1);
  });

  test("pins Android CLI journey primitives and preserves their native output", () => {
    const layout = prepareExternalVerifier(
      { executable: "android", args: ["layout", "--pretty"] },
      { cwd: "/project", serial: "device-A", sessionId: "session-3" },
    );
    expect(layout).toMatchObject({
      adapter: "android-cli",
      targetArgument: "device-A",
      artifactReferences: ["layout.json"],
    });
    expect(layout.command.args).toContain("--device=device-A");
    expect(layout.command.args).toContainEqual(expect.stringContaining("--output="));

    const screen = prepareExternalVerifier(
      { executable: "android.exe", args: ["screen", "capture", "--device=device-A"] },
      { cwd: "C:\\project", serial: "device-A", sessionId: "session-4" },
    );
    expect(screen).toMatchObject({
      adapter: "android-cli",
      artifactReferences: ["screen.png"],
      targetArgument: "device-A",
    });
  });

  test("keeps unknown verifiers generic without rewriting their arguments", () => {
    const prepared = prepareExternalVerifier(
      { executable: "custom-check", args: ["--device", "owned-by-tool"] },
      { cwd: "/project", serial: "device-A", sessionId: "session-5" },
    );
    expect(prepared).toMatchObject({
      adapter: "generic",
      targetArgument: null,
      artifactReferences: [],
      command: { args: ["--device", "owned-by-tool"] },
    });
  });

  test("classifies finite verifier outcomes without parsing human prose", () => {
    const base = {
      adapter: "generic" as const,
      passed: false,
      timedOut: false,
      aborted: false,
      unavailable: false,
      targetFailed: false,
    };
    expect(classifyExternalVerifier({ ...base, passed: true })).toBe("passed");
    expect(classifyExternalVerifier({ ...base, unavailable: true })).toBe("unavailable");
    expect(classifyExternalVerifier({ ...base, timedOut: true })).toBe("timed-out");
    expect(classifyExternalVerifier({ ...base, aborted: true })).toBe("cancelled");
    expect(classifyExternalVerifier({ ...base, targetFailed: true })).toBe("target-failed");
    expect(classifyExternalVerifier({ ...base, adapter: "maestro" })).toBe("assertion-failed");
    expect(classifyExternalVerifier(base)).toBe("tool-failed");
  });

  test("collects only bounded regular native artifacts and refuses symlink traversal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-verifier-"));
    const outside = await mkdtemp(path.join(tmpdir(), "adb-ready-verifier-outside-"));
    try {
      await mkdir(path.join(root, "nested"));
      await writeFile(path.join(root, "report.xml"), "<testsuite />");
      await writeFile(path.join(root, "nested", "screen.png"), new Uint8Array([1, 2, 3]));
      await writeFile(path.join(root, "ignored.bin"), new Uint8Array([4]));
      await writeFile(path.join(outside, "secret.txt"), "outside");
      await symlink(path.join(outside, "secret.txt"), path.join(root, "linked.txt"));

      const collected = await collectNativeVerifierArtifacts(root);
      expect(collected.artifacts.map(({ relativePath }) => relativePath)).toEqual([
        "nested/screen.png",
        "report.xml",
      ]);
      expect(collected.omitted).toBe(2);

      const bounded = await collectNativeVerifierArtifacts(root, { maxFiles: 1 });
      expect(bounded.artifacts).toHaveLength(1);
      expect(bounded.omitted).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
