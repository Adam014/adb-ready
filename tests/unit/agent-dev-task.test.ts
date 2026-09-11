import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
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
});
