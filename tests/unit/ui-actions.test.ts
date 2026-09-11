import { describe, expect, test } from "bun:test";
import type { CommandDependencies } from "../../src/app/commands.js";
import { runUiAction } from "../../src/evidence/ui-actions.js";
import { parseUiHierarchy } from "../../src/evidence/ui-hierarchy.js";
import type { ProcessRequest, ProcessResult } from "../../src/platform/process-runner.js";

const BEFORE = `<?xml version="1.0"?><hierarchy><node bounds="[0,0][1080,2400]"><node text="Open" resource-id="com.example:id/open" clickable="true" long-clickable="true" enabled="true" bounds="[20,100][220,200]" /></node></hierarchy>`;
const AFTER = `<?xml version="1.0"?><hierarchy><node bounds="[0,0][1080,2400]"><node text="Close" resource-id="com.example:id/close" clickable="true" enabled="true" bounds="[20,100][220,200]" /></node></hierarchy>`;
const FIELD = `<?xml version="1.0"?><hierarchy><node bounds="[0,0][1080,2400]"><node text="old" resource-id="com.example:id/email" class="android.widget.EditText" focusable="true" enabled="true" bounds="[100,300][900,420]" /></node></hierarchy>`;
const FILLED_FIELD = FIELD.replace('text="old"', 'text="person@example.com"');
const SCROLLER = `<?xml version="1.0"?><hierarchy><node resource-id="com.example:id/list" scrollable="true" enabled="true" bounds="[100,400][900,2000]" /></hierarchy>`;
const AUDIT = `<?xml version="1.0"?><hierarchy><node bounds="[0,0][1080,2400]"><node text="Save" resource-id="com.example:id/save" clickable="true" enabled="true" bounds="[20,100][220,200]" /><node class="android.widget.ImageButton" clickable="true" enabled="true" bounds="[240,100][440,200]" /></node></hierarchy>`;

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
  keyCombination = true,
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
      if (args.includes("input") && args.includes("help")) {
        return processResult(
          request,
          keyCombination ? "text keyevent keycombination\n" : "text keyevent\n",
        );
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

  test("finds semantic UI nodes and exposes a bounded match set", async () => {
    const execution = await runUiAction(
      {
        action: "find",
        selector: { field: "text", value: "Op", match: "starts-with", actionable: true },
      },
      {},
      fixture([BEFORE]),
    );
    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        action: "find",
        status: "observed",
        verified: true,
        matchCount: 1,
        matches: [{ text: "Open", resourceId: "com.example:id/open" }],
        verification: "query-completed",
      },
    });
  });

  test("gets one semantic node with agent-useful state and bounds", async () => {
    const execution = await runUiAction(
      { action: "get", selector: "id=com.example:id/email" },
      {},
      fixture([FIELD]),
    );
    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        action: "get",
        verified: true,
        matched: {
          text: "old",
          className: "android.widget.EditText",
          enabled: true,
          focusable: true,
          bounds: { left: 100, top: 300, right: 900, bottom: 420 },
        },
      },
    });
  });

  test("audits actionable nodes without inventing an aggregate quality score", async () => {
    const execution = await runUiAction({ action: "audit" }, {}, fixture([AUDIT]));
    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        action: "audit",
        verified: true,
        audit: {
          actionableNodes: 2,
          labeledNodes: 1,
          stableIdNodes: 1,
          findingCount: 2,
          findingsTruncated: false,
          findings: [
            { code: "UI_ACTIONABLE_UNLABELED", severity: "warning" },
            { code: "UI_ACTIONABLE_WITHOUT_STABLE_ID", severity: "info" },
          ],
        },
      },
    });
  });

  test("taps one unique semantic match without requiring a prior ref", async () => {
    const requests: string[][] = [];
    const execution = await runUiAction(
      { action: "tap", selector: "id=com.example:id/open" },
      {},
      fixture([BEFORE, AFTER], requests),
    );
    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        matched: { text: "Open", resourceId: "com.example:id/open" },
        resolved: { x: 120, y: 150 },
        verified: true,
      },
    });
    expect(requests).toContainEqual(
      expect.arrayContaining(["shell", "input", "tap", "120", "150"]),
    );
  });

  test("fails a semantic assertion with structured current evidence", async () => {
    const execution = await runUiAction(
      { action: "assert", selector: "text=Missing" },
      {},
      fixture([BEFORE]),
    );
    expect(execution.result).toMatchObject({
      ok: false,
      data: { action: "assert", verified: false, matchCount: 0 },
      problems: [{ code: "UI_ASSERTION_FAILED" }],
    });
  });

  test("compares a prior complete digest with current UI", async () => {
    const digest = parseUiHierarchy(BEFORE)?.digest;
    expect(digest).toBeDefined();
    const execution = await runUiAction(
      { action: "compare", digest: digest ?? "" },
      {},
      fixture([AFTER]),
    );
    expect(execution.result).toMatchObject({
      ok: true,
      data: { action: "compare", verified: true, verification: "ui-changed" },
    });
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

  test("fills one semantic field and verifies its observable value", async () => {
    const requests: string[][] = [];
    const execution = await runUiAction(
      {
        action: "fill",
        selector: "id=com.example:id/email",
        text: "person@example.com",
      },
      {},
      fixture([FIELD, FILLED_FIELD], requests),
    );
    expect(execution.result).toMatchObject({
      ok: true,
      data: { action: "fill", verified: true, verification: "text-matched" },
    });
    expect(requests).toContainEqual(expect.arrayContaining(["input", "tap", "500", "360"]));
    expect(requests).toContainEqual(
      expect.arrayContaining(["input", "keycombination", "KEYCODE_CTRL_LEFT", "KEYCODE_A"]),
    );
    expect(requests).toContainEqual(expect.arrayContaining(["input", "keyevent", "KEYCODE_DEL"]));
    expect(requests).toContainEqual(
      expect.arrayContaining(["input", "text", "person@example.com"]),
    );
  });

  test("refuses to clear a field before mutation when the target lacks safe selection", async () => {
    const requests: string[][] = [];
    const execution = await runUiAction(
      { action: "clear", selector: "id=com.example:id/email" },
      {},
      fixture([FIELD], requests, async () => false, false),
    );
    expect(execution.result).toMatchObject({
      ok: false,
      problems: [{ code: "UI_CLEAR_UNSUPPORTED" }],
    });
    expect(requests.some((args) => args.includes("tap"))).toBe(false);
    expect(requests.some((args) => args.includes("keycombination"))).toBe(false);
  });

  test("scrolls inside one semantic scroll container", async () => {
    const requests: string[][] = [];
    const execution = await runUiAction(
      { action: "scroll", direction: "up", selector: "id=com.example:id/list" },
      {},
      fixture([SCROLLER, AFTER], requests),
    );
    expect(execution.result).toMatchObject({
      ok: true,
      data: { action: "scroll", verified: true, matched: { scrollable: true } },
    });
    expect(requests).toContainEqual(
      expect.arrayContaining(["input", "swipe", "500", "1680", "500", "720", "350"]),
    );
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
