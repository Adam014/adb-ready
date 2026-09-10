import { describe, expect, test } from "bun:test";
import { SerialTaskQueue } from "../../src/agent/serial-task-queue.js";

describe("SerialTaskQueue", () => {
  test("does not overlap tasks and preserves submission order", async () => {
    const queue = new SerialTaskQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
      return 1;
    });
    const second = queue.run(async () => {
      events.push("second:start");
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst?.();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("continues after a task rejects", async () => {
    const queue = new SerialTaskQueue();
    const failed = queue.run(async () => {
      throw new Error("expected failure");
    });
    const recovered = queue.run(async () => "ready");

    await expect(failed).rejects.toThrow("expected failure");
    await expect(recovered).resolves.toBe("ready");
  });
});
