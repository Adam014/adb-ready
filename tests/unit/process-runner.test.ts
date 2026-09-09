import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { locateAdb } from "../../src/platform/executable.js";
import { runProcess } from "../../src/platform/process-runner.js";
import { detectRuntime } from "../../src/platform/runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("runProcess", () => {
  test("passes arguments directly without shell interpolation", async () => {
    const value = "literal value; $(never-run) & more";
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", value],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(value);
    expect(result.stderr).toBe("");
    expect(result.spawnError).toBeUndefined();
  });

  test("captures stderr and preserves a non-zero exit code", async () => {
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", 'process.stderr.write("failure"); process.exit(23)'],
    });

    expect(result.exitCode).toBe(23);
    expect(result.stderr).toBe("failure");
  });

  test("writes sensitive input through stdin without retaining it in process evidence", async () => {
    const secret = "739201";
    const result = await runProcess({
      executable: process.execPath,
      args: [
        "-e",
        'let value = ""; process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => process.stdout.write(String(value.length)))',
      ],
      input: `${secret}\n`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("7");
    expect(result.args.join(" ")).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("terminates a process after its timeout", async () => {
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10_000)"],
      timeoutMs: 20,
    });

    expect(result.timedOut).toBe(true);
    expect(result.signal).not.toBeNull();
  });

  test("terminates a process when aborted", async () => {
    const controller = new AbortController();
    const pending = runProcess({
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10_000)"],
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;

    expect(result.aborted).toBe(true);
    expect(result.signal).not.toBeNull();
  });

  test("bounds captured output while continuing to drain the child", async () => {
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", 'process.stdout.write("abcdefghij")'],
      maxBufferBytes: 5,
    });

    expect(result.stdout).toBe("abcde");
    expect(result.stdoutTruncated).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("reports a missing executable without invoking a shell", async () => {
    const result = await runProcess({ executable: "adb-ready-command-that-does-not-exist" });

    expect(result.exitCode).toBeNull();
    expect(result.spawnError?.code).toBe("ENOENT");
  });

  test("rejects invalid resource limits before spawning", async () => {
    await expect(
      runProcess({ executable: process.execPath, timeoutMs: -1 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      runProcess({ executable: process.execPath, maxBufferBytes: -1 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      runProcess({ executable: process.execPath, stdio: "inherit", input: "secret" }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe("locateAdb", () => {
  test("prefers an executable from PATH", async () => {
    const directory = await temporaryDirectory();
    const executable = path.join(directory, process.platform === "win32" ? "adb.exe" : "adb");
    await writeFile(executable, "fixture", { mode: 0o755 });

    const resolved = await locateAdb({
      env: { PATH: directory },
      homeDirectory: directory,
      platform: process.platform,
    });

    expect(resolved).toBe(executable);
  });

  test("falls back to ANDROID_SDK_ROOT", async () => {
    const directory = await temporaryDirectory();
    const platformTools = path.join(directory, "platform-tools");
    const executable = path.join(platformTools, process.platform === "win32" ? "adb.exe" : "adb");
    await mkdir(platformTools, { recursive: true });
    await writeFile(executable, "fixture");
    if (process.platform !== "win32") {
      await chmod(executable, 0o755);
    }

    const resolved = await locateAdb({
      env: { ANDROID_SDK_ROOT: directory, PATH: "" },
      homeDirectory: directory,
      platform: process.platform,
    });

    expect(resolved).toBe(executable);
  });

  test("does not accept a directory as an explicit executable", async () => {
    const directory = await temporaryDirectory();
    expect(await locateAdb({ explicitPath: directory })).toBeUndefined();
  });
});

describe("detectRuntime", () => {
  test("reports the active runtime and host", () => {
    const runtime = detectRuntime();
    expect(["bun", "deno", "node"]).toContain(runtime.name);
    expect(runtime.version).not.toBe("");
    expect(runtime.platform).toBe(process.platform);
    expect(runtime.architecture).toBe(process.arch);
  });
});
