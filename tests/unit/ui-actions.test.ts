import { describe, expect, test } from "bun:test";
import type { CommandDependencies } from "../../src/app/commands.js";
import { runUiAction } from "../../src/evidence/ui-actions.js";
import { parseUiHierarchy } from "../../src/evidence/ui-hierarchy.js";
import type { ProcessRequest, ProcessResult } from "../../src/platform/process-runner.js";

const BEFORE = `<?xml version="1.0"?><hierarchy><node bounds="[0,0][1080,2400]"><node text="Open" resource-id="com.example:id/open" clickable="true" long-clickable="true" enabled="true" bounds="[20,100][220,200]" /></node></hierarchy>`;
const AFTER = `<?xml version="1.0"?><hierarchy><node bounds="[0,0][1080,2400]"><node text="Close" resource-id="com.example:id/close" clickable="true" enabled="true" bounds="[20,100][220,200]" /></node></hierarchy>`;

function processResult(request: ProcessRequest, stdout = "", exitCode = 0): ProcessResult {
  return {
    executable: request.executable,
    args: [...(request.args ?? [])],
    startedAt: "2026-09-10T10:00:00.000Z",
    finishedAt: "2026-09-10T10:00:00.010Z",
    durationMs: 10,
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    stoppedAfterIdle: false,
    killEscalated: false,
  };
}

function fixture(
  snapshots: string[],
  requests: string[][] = [],
  sleep: CommandDependencies["sleep"] = async () => false,
): CommandDependencies {
  let id = 0;
  let snapshot = 0;
  return {
    idFactory: () => `id-${String(++id)}`,
    clock: () => new Date("2026-09-10T10:00:00.000Z"),
    locateAdb: async () => "/sdk/adb",
    sleep,
    runner: async (request) => {
      const args = [...(request.args ?? [])];
      requests.push(args);
      if (args.includes("devices")) {
        return processResult(
          request,
          "List of devices attached\nUSB-1 device model:Pixel_9 transport_id:7\n",
        );
      }
      if (args.includes("host-features")) return processResult(request, "shell_v2\n");
      if (args.includes("mdns"))
        return processResult(request, "List of discovered mdns services\n");
      if (args.includes("ro.serialno")) return processResult(request, "hardware-1\n");
      if (args.includes("wm") && args.includes("size")) {
        return processResult(request, "Physical size: 1080x2400\n");
      }
      if (args.includes("uiautomator")) {
        const value = snapshots[Math.min(snapshot, snapshots.length - 1)] ?? BEFORE;
        snapshot += 1;
        return processResult(request, value);
      }
      return processResult(request);
    },
  };
}

describe("safe UI actions", () => {
  test("resolves a current ref, taps its center, and verifies changed UI", async () => {
    const requests: string[][] = [];
    const ref = parseUiHierarchy(BEFORE)?.nodes[1]?.ref;
    expect(ref).toBeDefined();
    const execution = await runUiAction(
      { action: "tap", ref: ref ?? "" },
      {},
      fixture([BEFORE, AFTER], requests),
    );
    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        action: "tap",
        status: "completed",
        verified: true,
        resolved: { ref, x: 120, y: 150 },
        verification: "ui-changed",
      },
    });
    expect(requests).toContainEqual(
      expect.arrayContaining(["-t", "7", "shell", "input", "tap", "120", "150"]),
    );
  });

  test("rejects stale refs before sending input", async () => {
    const requests: string[][] = [];
    const execution = await runUiAction(
      { action: "tap", ref: "ui:000000000000:2" },
      {},
      fixture([BEFORE], requests),
    );
    expect(execution.result).toMatchObject({ ok: false, problems: [{ code: "UI_REF_STALE" }] });
    expect(requests.some((args) => args.includes("tap"))).toBe(false);
  });

  test("reports an explicit verification gap when input succeeds without a UI change", async () => {
    const execution = await runUiAction(
      { action: "press", key: "volume-up" },
      {},
      fixture([BEFORE, BEFORE]),
    );
    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        status: "completed",
        verified: false,
        verification: "ui-unchanged",
        verificationGap: "ui-unchanged",
      },
    });
  });

  test("rejects unsupported typed text instead of passing shell syntax to Android", async () => {
    const requests: string[][] = [];
    const execution = await runUiAction(
      { action: "type", text: "hello; reboot" },
      {},
      fixture([BEFORE], requests),
    );
    expect(execution.result).toMatchObject({
      ok: false,
      problems: [{ code: "UI_TEXT_UNSUPPORTED" }],
    });
    expect(requests.some((args) => args.includes("text"))).toBe(false);
  });

  test("waits for an exact selector and exposes the attempt count", async () => {
    const execution = await runUiAction(
      { action: "wait", selector: "id=com.example:id/close", state: "visible" },
      {},
      fixture([BEFORE, AFTER], [], async () => true),
    );
    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        action: "wait",
        status: "matched",
        verified: true,
        attempts: 2,
        matched: { resourceId: "com.example:id/close" },
      },
    });
  });

  test("returns an exact mutation plan without sending input", async () => {
    const requests: string[][] = [];
    const execution = await runUiAction(
      { action: "swipe", direction: "up", dryRun: true },
      { adbHost: "127.0.0.1", adbPort: 5038 },
      fixture([BEFORE], requests),
    );
    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        status: "planned",
        verification: "planned",
        plan: {
          dryRun: true,
          steps: [
            {
              executable: "/sdk/adb",
              args: [
                "-H",
                "127.0.0.1",
                "-P",
                "5038",
                "-t",
                "7",
                "shell",
                "input",
                "swipe",
                "540",
                "1920",
                "540",
                "480",
                "350",
              ],
            },
          ],
        },
      },
    });
    expect(requests.some((args) => args.includes("swipe"))).toBe(false);
  });
});
