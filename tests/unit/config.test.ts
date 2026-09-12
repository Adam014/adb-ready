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

  test("loads project app identity with provenance and rejects invalid package names", async () => {
    const directory = await temporaryDirectory();
    const validFile = path.join(directory, "app-valid.json");
    const invalidFile = path.join(directory, "app-invalid.json");
    await writeJson(validFile, {
      version: 1,
      app: { android: { package: "com.example.mobile" } },
    });
    await writeJson(invalidFile, {
      version: 1,
      app: { android: { package: "not a package" } },
    });

    const valid = await loadConfig({
      cwd: directory,
      env: {},
      homeDirectory: directory,
      userConfigPath: path.join(directory, "missing-user.json"),
      projectConfigPath: validFile,
      explicitProjectConfig: true,
    });
    expect(valid).toMatchObject({
      ok: true,
      config: {
        values: { appPackage: "com.example.mobile" },
        provenance: { appPackage: { source: "project", location: validFile } },
      },
    });

    const invalid = await loadConfig({
      cwd: directory,
      env: {},
      homeDirectory: directory,
      userConfigPath: path.join(directory, "missing-user.json"),
      projectConfigPath: invalidFile,
      explicitProjectConfig: true,
    });
    expect(invalid).toMatchObject({
      ok: false,
      errors: [{ path: "app.android.package" }],
    });
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
        ready: {
          timeoutMs: 45_000,
          pollIntervalMs: 500,
          all: [
            { kind: "boot" },
            { kind: "host-port", port: 8081 },
            { kind: "foreground", package: "com.example.app" },
            { kind: "ui", selector: "text=Sign in" },
          ],
        },
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
          devReadiness: {
            timeoutMs: 45_000,
            pollIntervalMs: 500,
            all: [
              { kind: "boot" },
              { kind: "host-port", port: 8081 },
              { kind: "foreground", package: "com.example.app" },
              { kind: "ui", selector: "text=Sign in" },
            ],
          },
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

  test("accepts every supported readiness assertion and normalizes optional fields", async () => {
    const directory = await temporaryDirectory();
    const projectFile = path.join(directory, "readiness.json");
    await writeJson(projectFile, {
      version: 1,
      dev: {
        ready: {
          timeoutMs: 30_000,
          pollIntervalMs: 250,
          all: [
            { kind: "boot" },
            { kind: "unlocked" },
            { kind: "foreground", package: "com.example.app" },
            { kind: "process", package: "com.example.worker" },
            { kind: "activity", value: "com.example.app/.MainActivity" },
            { kind: "host-port", host: "127.0.0.1", port: 8081 },
            { kind: "http", url: "https://localhost:8081/health", status: [200, 204] },
            { kind: "log", contains: "Application started", absent: false },
            { kind: "ui", selector: "text=Ready", state: "visible" },
            { kind: "ui", selector: "id=com.example:id/spinner", state: "gone" },
          ],
        },
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

    expect(loaded).toMatchObject({
      ok: true,
      config: {
        values: {
          devReadiness: {
            timeoutMs: 30_000,
            pollIntervalMs: 250,
            all: [
              { kind: "boot" },
              { kind: "unlocked" },
              { kind: "foreground", package: "com.example.app" },
              { kind: "process", package: "com.example.worker" },
              { kind: "activity", value: "com.example.app/.MainActivity" },
              { kind: "host-port", host: "127.0.0.1", port: 8081 },
              { kind: "http", url: "https://localhost:8081/health", status: [200, 204] },
              { kind: "log", contains: "Application started", absent: false },
              { kind: "ui", selector: "text=Ready", state: "visible" },
              { kind: "ui", selector: "id=com.example:id/spinner", state: "gone" },
            ],
          },
        },
      },
    });
  });

  test("reports every malformed readiness assertion and timing field", async () => {
    const directory = await temporaryDirectory();
    const projectFile = path.join(directory, "invalid-readiness.json");
    await writeJson(projectFile, {
      version: 1,
      dev: {
        ready: {
          typo: true,
          timeoutMs: 0,
          pollIntervalMs: -1,
          all: [
            null,
            { kind: "foreground", package: "invalid" },
            { kind: "activity", value: "" },
            { kind: "host-port", host: "", port: 70_000 },
            { kind: "http", url: "ftp://example.com", status: [] },
            { kind: "log", contains: "", absent: "no" },
            { kind: "ui", selector: "unsupported=Ready", state: "maybe" },
            { kind: "unknown", extra: true },
          ],
        },
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
      const paths = loaded.errors.map(({ path: errorPath }) => errorPath);
      expect(paths).toContainAllValues([
        "dev.ready.typo",
        "dev.ready.timeoutMs",
        "dev.ready.pollIntervalMs",
        "dev.ready.all.0",
        "dev.ready.all.1",
        "dev.ready.all.2",
        "dev.ready.all.3",
        "dev.ready.all.4",
        "dev.ready.all.5",
        "dev.ready.all.6",
        "dev.ready.all.7.extra",
        "dev.ready.all.7",
      ]);
    }
  });

  test("rejects malformed nested sections without throwing", async () => {
    const directory = await temporaryDirectory();
    const documents = [
      { version: 1, adb: [] },
      { version: 1, output: "human" },
      { version: 1, targets: [] },
      { version: 1, targets: { aliases: [] } },
      { version: 1, app: [] },
      { version: 1, app: { android: [] } },
      { version: 1, dev: [] },
      { version: 1, dev: { command: [] } },
      { version: 1, dev: { reversePorts: "8081" } },
      { version: 1, dev: { ready: [] } },
      { version: 1, dev: { recovery: [] } },
      { version: 1, dev: { session: [] } },
      { version: 1, dev: { journal: [] } },
      { version: 1, dev: { hooks: [] } },
      { version: 1, profiles: [] },
    ];

    for (const [index, document] of documents.entries()) {
      const projectFile = path.join(directory, `invalid-section-${String(index)}.json`);
      await writeJson(projectFile, document);
      const loaded = await loadConfig({
        cwd: directory,
        env: {},
        homeDirectory: directory,
        userConfigPath: path.join(directory, "missing-user.json"),
        projectConfigPath: projectFile,
        explicitProjectConfig: true,
      });
      expect(loaded.ok).toBeFalse();
      if (!loaded.ok) expect(loaded.errors).toBeArrayOfSize(1);
    }
  });

  test("validates all environment overrides and accepts their supported forms", async () => {
    const directory = await temporaryDirectory();
    const base = {
      cwd: directory,
      homeDirectory: directory,
      userConfigPath: path.join(directory, "missing-user.json"),
    };
    const valid = await loadConfig({
      ...base,
      env: {
        ADB_READY_ADB_PATH: "/sdk/adb",
        ADB_READY_ADB_HOST: "localhost",
        ADB_READY_APP_PACKAGE: "com.example.app",
        ADB_READY_PRESET: "flutter",
        ADB_READY_PACKAGE_MANAGER: "yarn",
        ADB_READY_JOURNAL_MINIMUM_SEVERITY: "warning",
        ADB_READY_REVERSE_PORTS: "8081, 3000",
        ADB_READY_JOURNAL_REDACT_ENVIRONMENT: "TOKEN,TOKEN,API_KEY",
        ADB_READY_ADB_PORT: "5037",
        ADB_READY_TIMEOUT_MS: "9000",
        ADB_READY_JOURNAL_MAX_ENTRIES: "100",
        ADB_READY_JOURNAL_MAX_BYTES: "10000",
        ADB_READY_RECOVERY_MAX_ATTEMPTS: "3",
        ADB_READY_RECOVERY_INITIAL_DELAY_MS: "100",
        ADB_READY_RECOVERY_MAX_DELAY_MS: "1000",
        ADB_READY_RECOVERY_TOTAL_TIMEOUT_MS: "5000",
        ADB_READY_SESSION_MAX_SESSIONS: "10",
        ADB_READY_SESSION_MAX_AGE_DAYS: "14",
        ADB_READY_SESSION_MAX_BYTES: "100000",
        ADB_READY_COLOR: "yes",
        ADB_READY_UNICODE: "1",
        ADB_READY_ANIMATION: "on",
        ADB_READY_INTERACTIVE: "true",
        ADB_READY_DEV_LOGS: "no",
        ADB_READY_CLEANUP_PORTS: "0",
        ADB_READY_DEV_WATCH: "off",
        ADB_READY_SESSION_PERSIST: "false",
      },
    });
    expect(valid).toMatchObject({
      ok: true,
      config: {
        values: {
          adbPath: "/sdk/adb",
          adbHost: "localhost",
          appPackage: "com.example.app",
          devPreset: "flutter",
          packageManager: "yarn",
          journalMinimumSeverity: "warning",
          devReversePorts: [{ device: 8081 }, { device: 3000 }],
          journalRedactEnvironment: ["TOKEN", "API_KEY"],
          adbPort: 5037,
          timeoutMs: 9000,
          color: true,
          devLogs: false,
          sessionPersist: false,
        },
      },
    });

    const invalid = await loadConfig({
      ...base,
      env: {
        ADB_READY_ADB_PATH: " ",
        ADB_READY_ADB_HOST: "",
        ADB_READY_APP_PACKAGE: "invalid",
        ADB_READY_PRESET: "cordova",
        ADB_READY_PACKAGE_MANAGER: "other",
        ADB_READY_JOURNAL_MINIMUM_SEVERITY: "fatal",
        ADB_READY_REVERSE_PORTS: "8081,",
        ADB_READY_JOURNAL_REDACT_ENVIRONMENT: "VALID,NOT-VALID",
        ADB_READY_JOURNAL_MAX_ENTRIES: "0",
        ADB_READY_RECOVERY_MAX_ATTEMPTS: "1.5",
        ADB_READY_SESSION_MAX_BYTES: "Infinity",
        ADB_READY_INTERACTIVE: "sometimes",
      },
    });
    expect(invalid.ok).toBeFalse();
    if (!invalid.ok) {
      expect(invalid.errors.map(({ path: errorPath }) => errorPath)).toContainAllValues([
        "ADB_READY_ADB_PATH",
        "ADB_READY_ADB_HOST",
        "ADB_READY_APP_PACKAGE",
        "ADB_READY_PRESET",
        "ADB_READY_PACKAGE_MANAGER",
        "ADB_READY_JOURNAL_MINIMUM_SEVERITY",
        "ADB_READY_REVERSE_PORTS",
        "ADB_READY_JOURNAL_REDACT_ENVIRONMENT",
        "ADB_READY_JOURNAL_MAX_ENTRIES",
        "ADB_READY_RECOVERY_MAX_ATTEMPTS",
        "ADB_READY_SESSION_MAX_BYTES",
        "ADB_READY_INTERACTIVE",
      ]);
    }
  });

  test("loads profiles from user configuration and reports invalid profile declarations", async () => {
    const directory = await temporaryDirectory();
    const userFile = path.join(directory, "user.json");
    await writeJson(userFile, {
      version: 1,
      defaultProfile: "desk",
      profiles: { desk: { timeoutMs: 3210 } },
    });
    const loaded = await loadConfig({
      cwd: directory,
      env: {},
      homeDirectory: directory,
      userConfigPath: userFile,
    });
    expect(loaded).toMatchObject({
      ok: true,
      config: {
        profile: { name: "desk", source: "user", chain: ["desk"] },
        values: { timeoutMs: 3210 },
      },
    });

    const invalidFile = path.join(directory, "invalid-profiles.json");
    await writeJson(invalidFile, {
      version: 1,
      defaultProfile: "missing",
      profiles: {
        "bad profile": {},
        scalar: 42,
        child: { extends: "bad parent" },
        nested: { timeoutMs: 0 },
      },
    });
    const invalid = await loadConfig({
      cwd: directory,
      env: { ADB_READY_PROFILE: " " },
      homeDirectory: directory,
      userConfigPath: path.join(directory, "missing-user.json"),
      projectConfigPath: invalidFile,
      explicitProjectConfig: true,
    });
    expect(invalid.ok).toBeFalse();
    if (!invalid.ok) {
      expect(invalid.errors.map(({ path: errorPath }) => errorPath)).toContainAllValues([
        "profiles.bad profile",
        "profiles.scalar",
        "profiles.child.extends",
        "profiles.nested.timeoutMs",
        "defaultProfile",
        "ADB_READY_PROFILE",
        "profile",
      ]);
    }
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
