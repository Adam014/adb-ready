import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activateAgentTaskFromEnvironment,
  defaultAgentTaskDirectory,
  getAgentDevTask,
  startAgentDevTask,
  stopAgentDevTask,
} from "../../src/agent/dev-task.js";

const created: string[] = [];
const fixture = fileURLToPath(new URL("../fixtures/agent-task-child.ts", import.meta.url));

afterEach(async () => {
  await Promise.all(
    created.splice(0).map(async (directory) => await rm(directory, { recursive: true })),
  );
});

async function temporary(): Promise<{ directory: string; project: string; state: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-agent-task-"));
  created.push(directory);
  const project = path.join(directory, "project");
  const state = path.join(directory, "state");
  await mkdir(project);
  return { directory, project, state };
}

async function awaitStatus(
  handle: string,
  project: string,
  state: string,
  expected: "completed" | "interrupted",
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await getAgentDevTask(handle, { cwd: project, env: {}, directory: state });
    if (current?.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Managed task did not become ${expected}`);
}

async function recordFile(project: string, state: string, handle: string): Promise<string> {
  const canonical = await realpath(project);
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const fingerprint = createHash("sha256").update(`root:${identity}`).digest("hex").slice(0, 24);
  const directory = path.join(state, fingerprint);
  await mkdir(directory, { recursive: true });
  return path.join(directory, `${handle}.json`);
}

function storedTask(handle: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    handle,
    projectFingerprint: "project",
    targetFingerprint: "target",
    status: "running",
    ready: true,
    pid: 1234,
    startedAt: "2026-09-10T10:00:00.000Z",
    updatedAt: "2026-09-10T10:00:00.000Z",
    resultFile: "/tmp/result.json",
    diagnosticFile: "/tmp/stderr.log",
    ...overrides,
  };
}

describe("agent development tasks", () => {
  test("uses per-user platform state locations", () => {
    expect(defaultAgentTaskDirectory("linux", {}, "/home/dev")).toBe(
      "/home/dev/.local/state/adb-ready/agent-tasks",
    );
    expect(defaultAgentTaskDirectory("darwin", {}, "/Users/dev")).toContain(
      "Library/Application Support/adb-ready/agent-tasks",
    );
    expect(
      defaultAgentTaskDirectory("win32", { LOCALAPPDATA: "C:\\Local" }, "C:\\Users\\dev"),
    ).toBe("C:\\Local\\adb-ready\\agent-tasks");
  });

  test("persists completion and scopes opaque handles to one project", async () => {
    const { directory, project, state } = await temporary();
    const task = await startAgentDevTask({
      cwd: project,
      env: {},
      cliPath: fixture,
      serial: "fixture-usb",
      targetIdentity: "hardware-1",
      directory: state,
    });
    expect(task).toMatchObject({ status: "running" });
    await awaitStatus(task.handle, project, state, "completed");
    expect(
      await getAgentDevTask(task.handle, { cwd: directory, env: {}, directory: state }),
    ).toBeUndefined();
  });

  test("stops only the process owned by a fresh project handle", async () => {
    const { project, state } = await temporary();
    const task = await startAgentDevTask({
      cwd: project,
      env: { ADB_READY_TASK_FIXTURE_WAIT: "1" },
      cliPath: fixture,
      serial: "fixture-usb",
      targetIdentity: "hardware-1",
      directory: state,
    });
    const stopped = await stopAgentDevTask(task.handle, {
      cwd: project,
      env: {},
      directory: state,
    });
    expect(stopped).toMatchObject({ handle: task.handle, status: "interrupted", exitCode: 130 });
    await awaitStatus(task.handle, project, state, "interrupted");
  });

  test("records an intentional stop when the owned child exits before finalizing", async () => {
    const { project, state } = await temporary();
    const task = await startAgentDevTask({
      cwd: project,
      env: { ADB_READY_TASK_FIXTURE_ABRUPT: "1" },
      cliPath: fixture,
      serial: "fixture-usb",
      targetIdentity: "hardware-1",
      directory: state,
    });
    const stopped = await stopAgentDevTask(task.handle, {
      cwd: project,
      env: {},
      directory: state,
    });
    expect(stopped).toMatchObject({ handle: task.handle, status: "interrupted", exitCode: 130 });
  });

  test("rejects invalid records and marks stale managed processes as failed", async () => {
    const { project, state } = await temporary();
    const handle = "11111111-1111-4111-8111-111111111111";
    const file = await recordFile(project, state, handle);
    expect(
      await getAgentDevTask("not-a-handle", { cwd: project, env: {}, directory: state }),
    ).toBeUndefined();
    expect(
      await stopAgentDevTask("not-a-handle", { cwd: project, env: {}, directory: state }),
    ).toBeUndefined();

    await writeFile(file, "not-json\n");
    expect(
      await getAgentDevTask(handle, { cwd: project, env: {}, directory: state }),
    ).toBeUndefined();

    const projectFingerprint = path.basename(path.dirname(file));
    await writeFile(
      file,
      `${JSON.stringify(
        storedTask(handle, {
          projectFingerprint,
          status: "starting",
          ready: false,
          pid: 0,
        }),
      )}\n`,
    );
    const failed = await getAgentDevTask(handle, {
      cwd: project,
      env: {},
      directory: state,
      clock: () => new Date("2026-09-10T10:02:00.000Z"),
      processAlive: () => true,
    });
    expect(failed).toMatchObject({ status: "failed", exitCode: 70 });
    expect(
      await stopAgentDevTask(handle, { cwd: project, env: {}, directory: state }),
    ).toMatchObject({ status: "failed", exitCode: 70 });
  });

  test("fails a ready task safely when its owned process no longer exists", async () => {
    const { project, state } = await temporary();
    const handle = "22222222-2222-4222-8222-222222222222";
    const file = await recordFile(project, state, handle);
    const projectFingerprint = path.basename(path.dirname(file));
    await writeFile(
      file,
      `${JSON.stringify(storedTask(handle, { projectFingerprint, updatedAt: "2026-09-10T10:02:00.000Z" }))}\n`,
    );
    const stopped = await stopAgentDevTask(handle, {
      cwd: project,
      env: {},
      directory: state,
      clock: () => new Date("2026-09-10T10:02:01.000Z"),
      processAlive: () => false,
    });
    expect(stopped).toMatchObject({ status: "failed", exitCode: 70 });
  });

  test("activates and finalizes the exact agent task supplied through the environment", async () => {
    const { directory } = await temporary();
    for (const fixture of [
      { handle: "33333333-3333-4333-8333-333333333333", exitCode: 0, status: "completed" },
      { handle: "44444444-4444-4444-8444-444444444444", exitCode: 130, status: "interrupted" },
      { handle: "55555555-5555-4555-8555-555555555555", exitCode: 5, status: "failed" },
    ]) {
      const file = path.join(directory, `${fixture.handle}.json`);
      await writeFile(
        file,
        `${JSON.stringify(storedTask(fixture.handle, { pid: process.pid }))}\n`,
      );
      const activation = await activateAgentTaskFromEnvironment({
        ADB_READY_AGENT_TASK_FILE: file,
        ADB_READY_AGENT_TASK_HANDLE: fixture.handle,
      });
      expect(activation).toBeDefined();
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
        ready: true,
        status: "running",
      });
      await activation?.finish(fixture.exitCode);
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
        status: fixture.status,
        exitCode: fixture.exitCode,
      });
      await activation?.finish(70);
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
        status: fixture.status,
        exitCode: fixture.exitCode,
      });
    }
    expect(await activateAgentTaskFromEnvironment({})).toBeUndefined();
    expect(
      await activateAgentTaskFromEnvironment({
        ADB_READY_AGENT_TASK_FILE: "/tmp/missing",
        ADB_READY_AGENT_TASK_HANDLE: "invalid",
      }),
    ).toBeUndefined();
  });

  test("records startup failure when the managed process cannot be spawned", async () => {
    const { directory, state } = await temporary();
    const missingProject = path.join(directory, "missing-project");
    await expect(
      startAgentDevTask({
        cwd: missingProject,
        env: {},
        cliPath: fixture,
        serial: "fixture-usb",
        targetIdentity: "hardware-1",
        directory: state,
      }),
    ).rejects.toThrow();
  });
});
