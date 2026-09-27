import { describe, expect, test } from "bun:test";
import type { CommandDependencies } from "../../src/app/commands.js";
import { runUiAction } from "../../src/evidence/ui-actions.js";
import { parseUiHierarchy } from "../../src/evidence/ui-hierarchy.js";
import {
  observePermissionDialog,
  parseKeyboardObservation,
} from "../../src/evidence/ui-system-actions.js";
import type { ProcessRequest, ProcessResult } from "../../src/platform/process-runner.js";

const PERMISSION = `<?xml version="1.0"?><hierarchy><node package="com.google.android.permissioncontroller" resource-id="com.android.permissioncontroller:id/grant_dialog" enabled="true" bounds="[0,0][1080,1600]"><node package="com.google.android.permissioncontroller" resource-id="com.android.permissioncontroller:id/permission_message" text="Allow Camera?" enabled="true" bounds="[100,200][900,400]"/><node package="com.google.android.permissioncontroller" resource-id="com.android.permissioncontroller:id/permission_allow_foreground_only_button" text="While using" clickable="true" enabled="true" bounds="[100,500][900,650]"/><node package="com.google.android.permissioncontroller" resource-id="com.android.permissioncontroller:id/permission_deny_button" text="Deny" clickable="true" enabled="true" bounds="[100,700][900,850]"/></node></hierarchy>`;
const APP = `<?xml version="1.0"?><hierarchy><node package="dev.example" text="Ready" enabled="true" bounds="[0,0][1080,2400]"/></hierarchy>`;
const INPUT_VISIBLE = "mImeWindowVis=3\nmInputShown=true\n";
const INPUT_HIDDEN = "mImeWindowVis=0\nmInputShown=false\n";
const WINDOW_VISIBLE =
  "InsetsSource id=3 type=ime frame=[0,100][100,200] visible=true sideHint=BOTTOM\n";
const WINDOW_HIDDEN = "InsetsSource id=3 type=ime frame=[0,0][0,0] visible=false sideHint=NONE\n";

function result(request: ProcessRequest, stdout = "", exitCode = 0): ProcessResult {
  return {
    executable: request.executable,
    args: [...(request.args ?? [])],
    startedAt: "2026-09-27T10:00:00.000Z",
    finishedAt: "2026-09-27T10:00:00.010Z",
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

function fixture(options: {
  snapshots?: string[];
  keyboard?: Array<{ input: string; window: string }>;
  requests?: string[][];
  fail?: "input_method" | "keyevent" | "tap" | "uiautomator" | "window";
}): CommandDependencies {
  let id = 0;
  let snapshotIndex = 0;
  let inputIndex = 0;
  let windowIndex = 0;
  const snapshots = options.snapshots ?? [APP];
  const keyboard = options.keyboard ?? [{ input: INPUT_HIDDEN, window: WINDOW_HIDDEN }];
  return {
    idFactory: () => `id-${String(++id)}`,
    clock: () => new Date("2026-09-27T10:00:00.000Z"),
    locateAdb: async () => "/sdk/adb",
    sleep: async () => true,
    runner: async (request) => {
      const args = [...(request.args ?? [])];
      options.requests?.push(args);
      if (
        (options.fail === "input_method" && args.includes("input_method")) ||
        (options.fail === "window" && args.includes("window")) ||
        (options.fail === "keyevent" && args.includes("KEYCODE_BACK")) ||
        (options.fail === "tap" && args.includes("tap")) ||
        (options.fail === "uiautomator" && args.includes("uiautomator"))
      ) {
        return result(request, "", 1);
      }
      if (args.includes("devices")) {
        return result(
          request,
          "List of devices attached\nUSB-1 device model:Pixel_9 transport_id:7\n",
        );
      }
      if (args.includes("host-features")) return result(request, "shell_v2\n");
      if (args.includes("mdns")) return result(request, "List of discovered mdns services\n");
      if (args.includes("ro.serialno")) return result(request, "hardware-1\n");
      if (args.includes("uiautomator")) {
        const value = snapshots[Math.min(snapshotIndex, snapshots.length - 1)] ?? APP;
        snapshotIndex += 1;
        return result(request, value);
      }
      if (args.includes("input_method")) {
        const value = keyboard[Math.min(inputIndex, keyboard.length - 1)]?.input ?? "";
        inputIndex += 1;
        return result(request, value);
      }
      if (args.includes("window")) {
        const value = keyboard[Math.min(windowIndex, keyboard.length - 1)]?.window ?? "";
        windowIndex += 1;
        return result(request, value);
      }
      return result(request);
    },
  };
}

describe("keyboard and system-dialog UI actions", () => {
  test("requires two agreeing keyboard visibility signals", () => {
    expect(parseKeyboardObservation(INPUT_VISIBLE, WINDOW_VISIBLE)).toMatchObject({
      state: "visible",
      confidence: "high",
    });
    expect(parseKeyboardObservation(INPUT_HIDDEN, WINDOW_HIDDEN).state).toBe("hidden");
    expect(parseKeyboardObservation(INPUT_VISIBLE, WINDOW_HIDDEN).state).toBe("ambiguous");
    expect(parseKeyboardObservation("", WINDOW_HIDDEN).state).toBe("unsupported");
    expect(
      parseKeyboardObservation("mInputShown=true\nmInputShown=false", WINDOW_VISIBLE).state,
    ).toBe("ambiguous");
  });

  test("classifies exact runtime-permission dialogs without localized button matching", () => {
    const permission = parseUiHierarchy(PERMISSION);
    const app = parseUiHierarchy(APP);
    if (permission === undefined || app === undefined) throw new Error("invalid test fixture");
    expect(observePermissionDialog(permission)).toMatchObject({
      state: "permission",
      controllerPackage: "com.google.android.permissioncontroller",
      message: "Allow Camera?",
      availableDecisions: ["allow-while-using", "deny"],
    });
    expect(observePermissionDialog(app).state).toBe("absent");
    const unsupported = parseUiHierarchy(
      `<?xml version="1.0"?><hierarchy><node package="com.google.android.permissioncontroller" resource-id="com.android.permissioncontroller:id/grant_dialog" enabled="true" bounds="[0,0][100,100]"/></hierarchy>`,
    );
    if (unsupported === undefined) throw new Error("invalid unsupported fixture");
    expect(observePermissionDialog(unsupported).state).toBe("unsupported");
  });

  test("observes, dismisses, and verifies a visible keyboard", async () => {
    const requests: string[][] = [];
    const execution = await runUiAction(
      { action: "keyboard", operation: "dismiss" },
      {},
      fixture({
        keyboard: [
          { input: INPUT_VISIBLE, window: WINDOW_VISIBLE },
          { input: INPUT_HIDDEN, window: WINDOW_HIDDEN },
        ],
        requests,
      }),
    );
    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        status: "completed",
        verified: true,
        keyboard: { before: { state: "visible" }, after: { state: "hidden" }, changed: true },
      },
    });
    expect(requests).toContainEqual(
      expect.arrayContaining(["shell", "input", "keyevent", "KEYCODE_BACK"]),
    );
  });

  test("does not press Back when the keyboard is hidden or visibility is uncertain", async () => {
    const hiddenRequests: string[][] = [];
    const hidden = await runUiAction(
      { action: "keyboard", operation: "dismiss" },
      {},
      fixture({ requests: hiddenRequests }),
    );
    expect(hidden.result).toMatchObject({ ok: true, data: { verified: true } });
    expect(hiddenRequests.some((args) => args.includes("KEYCODE_BACK"))).toBeFalse();

    const ambiguousRequests: string[][] = [];
    const ambiguous = await runUiAction(
      { action: "keyboard", operation: "dismiss" },
      {},
      fixture({
        keyboard: [{ input: INPUT_VISIBLE, window: WINDOW_HIDDEN }],
        requests: ambiguousRequests,
      }),
    );
    expect(ambiguous.result.problems[0]?.code).toBe("UI_KEYBOARD_STATE_AMBIGUOUS");
    expect(ambiguousRequests.some((args) => args.includes("KEYCODE_BACK"))).toBeFalse();
  });

  test("plans guarded keyboard dismissal and rejects an unverified transition", async () => {
    const planned = await runUiAction(
      { action: "keyboard", operation: "dismiss", dryRun: true },
      { adbHost: "127.0.0.1", adbPort: 5038 },
      fixture({ keyboard: [{ input: INPUT_VISIBLE, window: WINDOW_VISIBLE }] }),
    );
    expect(planned.result).toMatchObject({
      ok: true,
      data: { status: "planned" },
    });
    expect(JSON.stringify(planned.result.data)).toContain('"-H","127.0.0.1","-P","5038"');
    const unchanged = await runUiAction(
      { action: "keyboard", operation: "dismiss" },
      {},
      fixture({
        keyboard: [
          { input: INPUT_VISIBLE, window: WINDOW_VISIBLE },
          { input: INPUT_VISIBLE, window: WINDOW_VISIBLE },
        ],
      }),
    );
    expect(unchanged.result.problems[0]?.code).toBe("UI_KEYBOARD_DISMISS_NOT_VERIFIED");
  });

  test("reports unsupported keyboard status and failed Android probes", async () => {
    const unsupported = await runUiAction(
      { action: "keyboard", operation: "status" },
      {},
      fixture({ keyboard: [{ input: "", window: WINDOW_HIDDEN }] }),
    );
    expect(unsupported.result.problems[0]?.code).toBe("UI_KEYBOARD_STATE_UNSUPPORTED");
    const inputFailure = await runUiAction(
      { action: "keyboard", operation: "status" },
      {},
      fixture({ fail: "input_method" }),
    );
    expect(inputFailure.result.ok).toBeFalse();
    const windowFailure = await runUiAction(
      { action: "keyboard", operation: "status" },
      {},
      fixture({ fail: "window" }),
    );
    expect(windowFailure.result.ok).toBeFalse();
  });

  test("inspects and responds to one exact permission action with fresh verification", async () => {
    const inspected = await runUiAction(
      { action: "permission", operation: "inspect" },
      {},
      fixture({ snapshots: [PERMISSION] }),
    );
    expect(inspected.result).toMatchObject({
      ok: true,
      data: { permission: { before: { state: "permission" } } },
    });

    const requests: string[][] = [];
    const responded = await runUiAction(
      { action: "permission", operation: "respond", decision: "deny" },
      {},
      fixture({ snapshots: [PERMISSION, APP], requests }),
    );
    expect(responded.result).toMatchObject({
      ok: true,
      data: {
        verified: true,
        permission: { decision: "deny", changed: true, after: { state: "absent" } },
      },
    });
    expect(requests).toContainEqual(
      expect.arrayContaining(["shell", "input", "tap", "500", "775"]),
    );
  });

  test("plans permission responses and rejects unavailable decisions without tapping", async () => {
    const planned = await runUiAction(
      { action: "permission", operation: "respond", decision: "deny", dryRun: true },
      {},
      fixture({ snapshots: [PERMISSION] }),
    );
    expect(planned.result).toMatchObject({
      ok: true,
      data: { status: "planned", plan: { dryRun: true } },
    });
    const unavailable = await runUiAction(
      { action: "permission", operation: "respond", decision: "allow-once" },
      {},
      fixture({ snapshots: [PERMISSION] }),
    );
    expect(unavailable.result.problems[0]?.code).toBe("UI_PERMISSION_DECISION_UNAVAILABLE");
  });

  test("fails closed for unsupported, absent, unchanged, and failed permission responses", async () => {
    const unsupportedXml = `<?xml version="1.0"?><hierarchy><node package="com.google.android.permissioncontroller" resource-id="com.android.permissioncontroller:id/grant_dialog" enabled="true" bounds="[0,0][100,100]"/></hierarchy>`;
    const unsupported = await runUiAction(
      { action: "permission", operation: "inspect" },
      {},
      fixture({ snapshots: [unsupportedXml] }),
    );
    expect(unsupported.result.problems[0]?.code).toBe("UI_PERMISSION_DIALOG_UNSUPPORTED");
    const absent = await runUiAction(
      { action: "permission", operation: "respond", decision: "deny" },
      {},
      fixture({ snapshots: [APP] }),
    );
    expect(absent.result.problems[0]?.code).toBe("UI_PERMISSION_DIALOG_ABSENT");
    const unchanged = await runUiAction(
      { action: "permission", operation: "respond", decision: "deny" },
      {},
      fixture({ snapshots: [PERMISSION, PERMISSION] }),
    );
    expect(unchanged.result.problems[0]?.code).toBe("UI_PERMISSION_RESPONSE_NOT_VERIFIED");
    const failedTap = await runUiAction(
      { action: "permission", operation: "respond", decision: "deny" },
      {},
      fixture({ snapshots: [PERMISSION], fail: "tap" }),
    );
    expect(failedTap.result.ok).toBeFalse();
    const failedSnapshot = await runUiAction(
      { action: "permission", operation: "inspect" },
      {},
      fixture({ fail: "uiautomator" }),
    );
    expect(failedSnapshot.result.ok).toBeFalse();
  });
});
