import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultUserConfigPath, findProjectConfig, loadConfig } from "../../src/config/loader.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

describe("loadConfig", () => {
  test("merges fields with default, user, project, environment, and CLI precedence", async () => {
    const directory = await temporaryDirectory();
    const userFile = path.join(directory, "user.json");
    const projectFile = path.join(directory, "project.json");
    await writeJson(userFile, {
      version: 1,
      timeoutMs: 1_000,
      adb: { host: "user-host", port: 5037 },
      output: { color: false, unicode: false },
    });
    await writeJson(projectFile, {
      version: 1,
      timeoutMs: 2_000,
      adb: { host: "project-host" },
      output: { unicode: true },
      targets: { aliases: { desk: "USB-123" } },
    });

    const result = await loadConfig({
      cwd: directory,
      env: {
        ADB_READY_ADB_HOST: "environment-host",
        ADB_READY_TIMEOUT_MS: "3000",
        ADB_READY_COLOR: "off",
      },
      homeDirectory: directory,
      userConfigPath: userFile,
      projectConfigPath: projectFile,
      explicitProjectConfig: true,
      cli: { adbHost: "cli-host", animation: false },
    });

    expect(result).toMatchObject({
      ok: true,
      config: {
        values: {
          adbHost: "cli-host",
          adbPort: 5037,
          timeoutMs: 3_000,
          color: false,
          unicode: true,
          animation: false,
          targetAliases: { desk: "USB-123" },
        },
        provenance: {
          adbHost: { source: "cli" },
          adbPort: { source: "user", location: userFile },
          timeoutMs: { source: "environment" },
          unicode: { source: "project", location: projectFile },
        },
      },
    });
  });

  test("validates target aliases instead of accepting ambiguous config", async () => {
    const directory = await temporaryDirectory();
    const projectFile = path.join(directory, "aliases.json");
    await writeJson(projectFile, {
      version: 1,
      targets: { aliases: { "bad alias": "", desk: "USB-123" } },
    });

    const result = await loadConfig({
      cwd: directory,
      env: {},
      homeDirectory: directory,
      userConfigPath: path.join(directory, "missing-user.json"),
      projectConfigPath: projectFile,
      explicitProjectConfig: true,
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors.map(({ path: errorPath }) => errorPath)).toEqual([
        "targets.aliases.bad alias",
      ]);
    }
  });

  test("returns every validation error instead of stopping at the first", async () => {
    const directory = await temporaryDirectory();
    const projectFile = path.join(directory, "invalid.json");
    await writeJson(projectFile, {
      version: 2,
      $schema: 42,
      unknown: true,
      timeoutMs: 0,
      adb: { path: "", port: 70_000, typo: true },
      output: { color: "yes", typo: false },
    });

    const result = await loadConfig({
      cwd: directory,
      env: { ADB_READY_ADB_PORT: "not-a-port", ADB_READY_ANIMATION: "sometimes" },
      homeDirectory: directory,
      userConfigPath: path.join(directory, "missing-user.json"),
      projectConfigPath: projectFile,
      explicitProjectConfig: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map(({ path: errorPath }) => errorPath)).toEqual([
        "unknown",
        "$schema",
        "version",
        "timeoutMs",
        "adb.typo",
        "adb.path",
        "adb.port",
        "output.typo",
        "output.color",
        "ADB_READY_ADB_PORT",
        "ADB_READY_ANIMATION",
      ]);
    }
  });

  test("reports invalid JSON and a missing explicit config", async () => {
    const directory = await temporaryDirectory();
    const invalid = path.join(directory, "invalid.json");
    await writeFile(invalid, "{ invalid");
    const invalidResult = await loadConfig({
      cwd: directory,
      env: {},
      homeDirectory: directory,
      userConfigPath: path.join(directory, "missing-user.json"),
      projectConfigPath: invalid,
      explicitProjectConfig: true,
    });
    const missingResult = await loadConfig({
      cwd: directory,
      env: {},
      homeDirectory: directory,
      userConfigPath: path.join(directory, "missing-user.json"),
      projectConfigPath: path.join(directory, "missing-project.json"),
      explicitProjectConfig: true,
    });

    expect(invalidResult).toMatchObject({
      ok: false,
      errors: [{ code: "CONFIG_INVALID_JSON", source: "project" }],
    });
    expect(missingResult).toMatchObject({
      ok: false,
      errors: [{ code: "CONFIG_NOT_FOUND", source: "project" }],
    });
  });

  test("uses defaults when optional files and environment values are absent", async () => {
    const directory = await temporaryDirectory();
    const result = await loadConfig({
      cwd: directory,
      env: {},
      homeDirectory: directory,
      userConfigPath: path.join(directory, "missing-user.json"),
    });

    expect(result).toMatchObject({
      ok: true,
      config: {
        values: { timeoutMs: 5_000 },
        provenance: { timeoutMs: { source: "default" } },
        files: {},
      },
    });
  });

  test("validates and merges declarative dev session configuration", async () => {
    const directory = await temporaryDirectory();
    const projectFile = path.join(directory, "dev.json");
    await writeJson(projectFile, {
      version: 1,
      dev: {
        preset: "expo",
        packageManager: "pnpm",
        command: { executable: "pnpm", args: ["run", "start"], cwd: "mobile" },
        reversePorts: [8081, { device: 8000, host: 8001 }],
        logs: true,
        cleanupPorts: true,
        watch: true,
        recovery: {
          maxAttempts: 4,
          initialDelayMs: 250,
          maxDelayMs: 2000,
          totalTimeoutMs: 15000,
        },
        session: { persist: true, maxSessions: 20, maxAgeDays: 7, maxBytes: 10000000 },
        journal: {
          maxEntries: 500,
          maxBytes: 100000,
          sources: ["child.stdout", "logcat"],
          minimumSeverity: "info",
          redactEnvironment: ["PRIVATE_TOKEN", "API_SECRET"],
        },
        hooks: {
          onReady: [
            {
              run: ["node", "scripts/ready.mjs", "literal;$(argument)"],
              timeoutMs: 2500,
              failure: "warn",
              cwd: "mobile",
              envAllowlist: ["CI"],
            },
          ],
          finally: [{ run: ["node", "scripts/cleanup.mjs"] }],
        },
      },
    });
    const loaded = await loadConfig({
      cwd: directory,
      env: {
        ADB_READY_PRESET: "react-native",
        ADB_READY_REVERSE_PORTS: "3000,8081",
        ADB_READY_DEV_LOGS: "false",
        ADB_READY_JOURNAL_REDACT_ENVIRONMENT: "CI_TOKEN,PRIVATE_TOKEN",
      },
      homeDirectory: directory,
      userConfigPath: path.join(directory, "missing-user.json"),
      projectConfigPath: projectFile,
      explicitProjectConfig: true,
      cli: { packageManager: "bun", devCleanupPorts: false },
    });

    expect(loaded).toMatchObject({
      ok: true,
      config: {
        values: {
          devPreset: "react-native",
          packageManager: "bun",
          devCommand: { executable: "pnpm", args: ["run", "start"], cwd: "mobile" },
          devReversePorts: [{ device: 3000 }, { device: 8081 }],
          devLogs: false,
          devCleanupPorts: false,
          devWatch: true,
          recoveryMaxAttempts: 4,
          recoveryInitialDelayMs: 250,
          recoveryMaxDelayMs: 2000,
          recoveryTotalTimeoutMs: 15000,
          sessionPersist: true,
          sessionMaxSessions: 20,
          sessionMaxAgeDays: 7,
          sessionMaxBytes: 10000000,
          journalMaxEntries: 500,
          journalMaxBytes: 100000,
          journalSources: ["child.stdout", "logcat"],
          journalMinimumSeverity: "info",
          journalRedactEnvironment: ["CI_TOKEN", "PRIVATE_TOKEN"],
          devHooks: {
            onReady: [
              {
                run: ["node", "scripts/ready.mjs", "literal;$(argument)"],
                timeoutMs: 2500,
                failure: "warn",
                cwd: "mobile",
                envAllowlist: ["CI"],
              },
            ],
            finally: [{ run: ["node", "scripts/cleanup.mjs"] }],
          },
        },
        provenance: {
          devPreset: { source: "environment" },
          packageManager: { source: "cli" },
          devReversePorts: { source: "environment" },
          devCleanupPorts: { source: "cli" },
          journalRedactEnvironment: { source: "environment" },
        },
      },
    });
  });

  test("rejects unsafe recovery and retention configuration", async () => {
    const directory = await temporaryDirectory();
    const projectFile = path.join(directory, "invalid-recovery.json");
    await writeJson(projectFile, {
      version: 1,
      dev: {
        watch: "yes",
        recovery: { initialDelayMs: 5000, maxDelayMs: 1000, maxAttempts: 0, typo: true },
        session: { persist: "yes", maxSessions: 0, typo: true },
      },
    });

    const loaded = await loadConfig({
      cwd: directory,
      env: {},
      homeDirectory: directory,
      userConfigPath: path.join(directory, "missing-user.json"),
      projectConfigPath: projectFile,
      explicitProjectConfig: true,
    });
    expect(loaded.ok).toBeFalse();
    if (!loaded.ok) {
      expect(loaded.errors.map(({ path: errorPath }) => errorPath)).toEqual([
        "dev.watch",
        "dev.recovery.typo",
        "dev.recovery.maxAttempts",
        "dev.session.typo",
        "dev.session.persist",
        "dev.session.maxSessions",
        "dev.recovery.maxDelayMs",
      ]);
    }
  });

  test("returns all invalid dev fields", async () => {
    const directory = await temporaryDirectory();
    const projectFile = path.join(directory, "bad-dev.json");
    await writeJson(projectFile, {
      version: 1,
      dev: {
        preset: "magic",
        packageManager: "other",
        command: { executable: "", args: "start", shell: true },
        reversePorts: [0, { device: 8081, host: 70000, extra: true }],
        logs: "yes",
        journal: {
          maxEntries: 0,
          minimumSeverity: "fatal",
          redactEnvironment: ["NOT-VALID"],
          extra: true,
        },
        hooks: {
          unknown: [],
          onReady: [{ run: [], timeoutMs: 0, failure: "maybe", envAllowlist: ["NOT-VALID"] }],
        },
        extra: true,
      },
    });
    const loaded = await loadConfig({
      cwd: directory,
      env: {},
      homeDirectory: directory,
      userConfigPath: path.join(directory, "missing-user.json"),
      projectConfigPath: projectFile,
      explicitProjectConfig: true,
    });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      const paths = loaded.errors.map(({ path: errorPath }) => errorPath);
      expect(paths).toContain("dev.extra");
      expect(paths).toContain("dev.command.shell");
      expect(paths).toContain("dev.reversePorts.0.device");
      expect(paths).toContain("dev.reversePorts.1.host");
      expect(paths).toContain("dev.journal.minimumSeverity");
      expect(paths).toContain("dev.journal.redactEnvironment");
      expect(paths).toContain("dev.hooks.unknown");
      expect(paths).toContain("dev.hooks.onReady.0.run");
      expect(paths).toContain("dev.hooks.onReady.0.timeoutMs");
      expect(paths).toContain("dev.hooks.onReady.0.failure");
      expect(paths).toContain("dev.hooks.onReady.0.envAllowlist");
    }
  });

  test("loads an environment-selected project file as required", async () => {
    const directory = await temporaryDirectory();
    const selected = path.join(directory, "selected.json");
    await writeJson(selected, { version: 1, output: { interactive: false } });

    const result = await loadConfig({
      cwd: directory,
      env: { ADB_READY_CONFIG: "selected.json" },
      homeDirectory: directory,
      userConfigPath: path.join(directory, "missing-user.json"),
    });

    expect(result).toMatchObject({
      ok: true,
      config: {
        values: { interactive: false },
        provenance: { interactive: { source: "project", location: selected } },
      },
    });
  });

  test("applies a default named profile after project values with explicit inheritance", async () => {
    const directory = await temporaryDirectory();
    const projectFile = path.join(directory, "profiles.json");
    await writeJson(projectFile, {
      version: 1,
      timeoutMs: 1_000,
      defaultProfile: "office",
      profiles: {
        base: {
          timeoutMs: 2_000,
          output: { animation: false },
          targets: { aliases: { phone: "USB-BASE" } },
        },
        office: {
          extends: "base",
          timeoutMs: 3_000,
          adb: { host: "office-adb" },
        },
      },
    });

    const result = await loadConfig({
      cwd: directory,
      env: {},
      homeDirectory: directory,
      userConfigPath: path.join(directory, "missing-user.json"),
      projectConfigPath: projectFile,
      explicitProjectConfig: true,
    });

    expect(result).toMatchObject({
      ok: true,
      config: {
        values: {
          timeoutMs: 3_000,
          animation: false,
          adbHost: "office-adb",
          targetAliases: { phone: "USB-BASE" },
        },
        profile: { name: "office", source: "project", chain: ["base", "office"] },
        provenance: {
          timeoutMs: { source: "profile", location: `${projectFile}#profiles.office` },
          animation: { source: "profile", location: `${projectFile}#profiles.base` },
        },
      },
    });
  });

  test("uses CLI then environment profile selection precedence and preserves value precedence", async () => {
    const directory = await temporaryDirectory();
    const projectFile = path.join(directory, "profiles.json");
    await writeJson(projectFile, {
      version: 1,
      defaultProfile: "default",
      profiles: {
        default: { timeoutMs: 1_000 },
        environment: { timeoutMs: 2_000 },
        cli: { timeoutMs: 3_000 },
      },
    });

    const result = await loadConfig({
      cwd: directory,
      env: { ADB_READY_PROFILE: "environment", ADB_READY_TIMEOUT_MS: "4000" },
      homeDirectory: directory,
      userConfigPath: path.join(directory, "missing-user.json"),
      projectConfigPath: projectFile,
      explicitProjectConfig: true,
      profileName: "cli",
      cli: { timeoutMs: 5_000 },
    });

    expect(result).toMatchObject({
      ok: true,
      config: {
        values: { timeoutMs: 5_000 },
        profile: { name: "cli" },
        provenance: { timeoutMs: { source: "cli" } },
      },
    });
  });

  test("returns missing references, inheritance cycles, and unknown selections together", async () => {
    const directory = await temporaryDirectory();
    const projectFile = path.join(directory, "invalid-profiles.json");
    await writeJson(projectFile, {
      version: 1,
      profiles: {
        first: { extends: "second" },
        second: { extends: "first" },
        orphan: { extends: "missing" },
      },
    });

    const result = await loadConfig({
      cwd: directory,
      env: {},
      homeDirectory: directory,
      userConfigPath: path.join(directory, "missing-user.json"),
      projectConfigPath: projectFile,
      explicitProjectConfig: true,
      profileName: "unknown",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map(({ path: errorPath }) => errorPath)).toContainAllValues([
        "profiles.second.extends",
        "profiles.orphan.extends",
        "profile",
      ]);
    }
  });

  test("never hangs while reporting a selected inheritance cycle", async () => {
    const directory = await temporaryDirectory();
    const projectFile = path.join(directory, "cycle.json");
    await writeJson(projectFile, {
      version: 1,
      defaultProfile: "first",
      profiles: {
        first: { extends: "second", timeoutMs: 1_000 },
        second: { extends: "first", timeoutMs: 2_000 },
      },
    });

    const result = await loadConfig({
      cwd: directory,
      env: {},
      homeDirectory: directory,
      userConfigPath: path.join(directory, "missing-user.json"),
      projectConfigPath: projectFile,
      explicitProjectConfig: true,
    });

    expect(result).toMatchObject({
      ok: false,
      errors: [{ path: "profiles.second.extends" }],
    });
  });
});

describe("configuration paths", () => {
  test("finds project configuration in a parent directory", async () => {
    const directory = await temporaryDirectory();
    const nested = path.join(directory, "packages", "mobile");
    const config = path.join(directory, "adb-ready.config.json");
    await mkdir(nested, { recursive: true });
    await writeJson(config, { version: 1 });

    expect(await findProjectConfig(nested)).toBe(config);
  });

  test("uses established per-platform user config roots", () => {
    expect(defaultUserConfigPath("linux", {}, "/home/dev")).toBe(
      "/home/dev/.config/adb-ready/config.json",
    );
    expect(defaultUserConfigPath("darwin", {}, "/Users/dev")).toBe(
      "/Users/dev/Library/Application Support/adb-ready/config.json",
    );
    expect(
      defaultUserConfigPath(
        "win32",
        { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
        "C:\\Users\\dev",
      ),
    ).toBe("C:\\Users\\dev\\AppData\\Roaming\\adb-ready\\config.json");
    expect(defaultUserConfigPath("linux", { XDG_CONFIG_HOME: "/custom" }, "/home/dev")).toBe(
      "/custom/adb-ready/config.json",
    );
  });
});
