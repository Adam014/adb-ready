import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { canSpawnWithoutShell, locateAdb } from "../../src/platform/executable.js";
import { runProcess } from "../../src/platform/process-runner.js";
import { detectRuntime } from "../../src/platform/runtime.js";

const temporaryDirectories: string[] = [];
const testOnUnix = process.platform === "win32" ? test.skip : test;

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

  test("captures a streaming snapshot after output becomes idle", async () => {
    const result = await runProcess({
      executable: process.execPath,
      args: [
        "-e",
        'process.stdout.write("first"); setTimeout(() => process.stdout.write("-second"), 10); setTimeout(() => {}, 10_000)',
      ],
      stopAfterIdleMs: 25,
      timeoutMs: 1_000,
    });

    expect(result.stdout).toBe("first-second");
    expect(result.stoppedAfterIdle).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });

  test("streams raw chunks while preserving split UTF-8 and malformed bytes in capture", async () => {
    const streamed: Uint8Array[] = [];
    const result = await runProcess({
      executable: process.execPath,
      args: [
        "-e",
        "const chunks=[[0x41,0xf0],[0x9f,0x98],[0x80,0xc3]]; let i=0; const next=()=>{ if(i===chunks.length) return; process.stdout.write(Buffer.from(chunks[i++])); setTimeout(next,5); }; next();",
      ],
      onStdoutChunk: (chunk) => streamed.push(chunk),
    });
    const merged = new Uint8Array(streamed.reduce((size, chunk) => size + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of streamed) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    expect(result.stdout).toBe("A😀�");
    expect(new TextDecoder().decode(merged)).toBe(result.stdout);
    expect(result.exitCode).toBe(0);
  });

  test("contains stream callback failures and terminates the owned child", async () => {
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", 'process.stdout.write("ready"); setTimeout(() => {}, 10_000)'],
      onStdoutChunk: () => {
        throw new Error("fixture consumer failed");
      },
      killGraceMs: 50,
      timeoutMs: 1_000,
    });

    expect(result.streamError).toEqual({
      stream: "stdout",
      message: "fixture consumer failed",
    });
    expect(result.timedOut).toBe(false);
    expect(result.signal).not.toBeNull();
  });

  testOnUnix("escalates termination when an owned child ignores SIGTERM", async () => {
    const result = await runProcess({
      executable: process.execPath,
      args: [
        "-e",
        'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)',
      ],
      stopAfterIdleMs: 20,
      killGraceMs: 20,
      timeoutMs: 1_000,
    });

    expect(result.stoppedAfterIdle).toBe(true);
    expect(result.killEscalated).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(result.timedOut).toBe(false);
  });

  test("applies an explicit working directory and environment overlay", async () => {
    const directory = await temporaryDirectory();
    const result = await runProcess({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({cwd: process.cwd(), value: process.env.ADB_READY_FIXTURE}))",
      ],
      cwd: directory,
      env: { ADB_READY_FIXTURE: "portable" },
    });

    expect(JSON.parse(result.stdout)).toEqual({
      cwd: await realpath(directory),
      value: "portable",
    });
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
      runProcess({ executable: process.execPath, stopAfterIdleMs: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      runProcess({ executable: process.execPath, killGraceMs: -1 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      runProcess({ executable: process.execPath, stdio: "inherit", input: "secret" }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe("locateAdb", () => {
  test("never resolves Windows command shims that require an implicit shell", () => {
    expect(canSpawnWithoutShell("adb.exe", "win32")).toBe(true);
    expect(canSpawnWithoutShell("adb.COM", "win32")).toBe(true);
    expect(canSpawnWithoutShell("adb", "win32")).toBe(true);
    expect(canSpawnWithoutShell("adb.cmd", "win32")).toBe(false);
    expect(canSpawnWithoutShell("adb.bat", "win32")).toBe(false);
    expect(canSpawnWithoutShell("adb.ps1", "win32")).toBe(false);
    expect(canSpawnWithoutShell("adb.cmd", "linux")).toBe(true);
  });

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
