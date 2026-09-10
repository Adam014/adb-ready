import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectConfigDocument, runConfigReport, runInit } from "../../src/app/config-commands.js";
import { loadConfig } from "../../src/config/loader.js";

describe("project configuration commands", () => {
  test("creates a minimal detected Expo configuration that validates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-init-"));
    try {
      const execution = await runInit(
        { cwd: root },
        {
          idFactory: () => "command-1",
          clock: () => new Date("2026-09-10T10:00:00.000Z"),
          detectProject: async () => ({
            root,
            preset: "expo",
            presetEvidence: ["dependency: expo"],
            packageManager: {
              name: "pnpm",
              executable: "/bin/pnpm",
              source: "package-json",
              conflicts: [],
            },
          }),
        },
      );
      expect(execution.result.data).toMatchObject({
        status: "created",
        path: "adb-ready.config.json",
        detectedPreset: "expo",
        detectedPackageManager: "pnpm",
        document: {
          version: 1,
          dev: {
            preset: "expo",
            packageManager: "pnpm",
            reversePorts: [8081],
            logs: true,
            cleanupPorts: true,
            watch: true,
          },
        },
      });
      const loaded = await loadConfig({
        cwd: root,
        env: {},
        homeDirectory: root,
        userConfigPath: path.join(root, "missing-user.json"),
        projectConfigPath: path.join(root, "adb-ready.config.json"),
        explicitProjectConfig: true,
      });
      expect(loaded.ok).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never overwrites an existing file without explicit force", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-init-"));
    const destination = path.join(root, "adb-ready.config.json");
    try {
      await writeFile(destination, "keep me\n");
      const dependencies = {
        detectProject: async () => ({
          root,
          presetEvidence: [],
          packageManager: { conflicts: [] },
        }),
      };
      const refused = await runInit({ cwd: root }, dependencies);
      expect(refused.result.problems).toMatchObject([{ code: "CONFIG_ALREADY_EXISTS" }]);
      expect(await readFile(destination, "utf8")).toBe("keep me\n");
      const replaced = await runInit({ cwd: root, force: true }, dependencies);
      expect(replaced.result.data).toMatchObject({ status: "replaced" });
      expect(JSON.parse(await readFile(destination, "utf8"))).toMatchObject({ version: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("produces a mutation-free init plan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-init-"));
    try {
      const execution = await runInit(
        { cwd: root, preset: "react-native", packageManager: "bun", dryRun: true },
        {
          detectProject: async () => ({
            root,
            presetEvidence: [],
            packageManager: { conflicts: [] },
          }),
        },
      );
      expect(execution.result.data).toMatchObject({
        status: "planned",
        document: { dev: { preset: "react-native", packageManager: "bun" } },
      });
      expect(
        await readFile(path.join(root, "adb-ready.config.json"), "utf8").catch(() => undefined),
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("explains every resolved value with its winning source", () => {
    const report = runConfigReport("explain", {
      values: { timeoutMs: 5000, devPreset: "expo", devWatch: true },
      provenance: {
        timeoutMs: { source: "default" },
        devPreset: { source: "project", location: "/private/project/adb-ready.config.json" },
        devWatch: { source: "environment", location: "ADB_READY_DEV_WATCH" },
      },
      files: { project: "/private/project/adb-ready.config.json" },
    });
    expect(report.result.data).toMatchObject({
      action: "explain",
      valid: true,
      files: { project: "adb-ready.config.json" },
      values: [
        { key: "devPreset", value: "expo", source: "project", location: "adb-ready.config.json" },
        { key: "devWatch", value: true, source: "environment", location: "ADB_READY_DEV_WATCH" },
        { key: "timeoutMs", value: 5000, source: "default" },
      ],
    });
  });

  test("uses framework defaults only when they are relevant", () => {
    expect(projectConfigDocument({ preset: "gradle" })).toMatchObject({
      dev: { preset: "gradle" },
    });
    expect(projectConfigDocument({ preset: "gradle" })).not.toMatchObject({
      dev: { reversePorts: expect.anything() },
    });
  });
});
