import { describe, expect, test } from "bun:test";
import type { CommandDependencies } from "../../src/app/commands.js";
import { runUiAction } from "../../src/evidence/ui-actions.js";
import { parseUiHierarchy } from "../../src/evidence/ui-hierarchy.js";
import type { ProcessRequest, ProcessResult } from "../../src/platform/process-runner.js";

const BEFORE = `<?xml version="1.0"?><hierarchy><node bounds="[0,0][1080,2400]"><node text="Open" resource-id="com.example:id/open" clickable="true" long-clickable="true" enabled="true" bounds="[20,100][220,200]" /></node></hierarchy>`;
const AFTER = `<?xml version="1.0"?><hierarchy><node bounds="[0,0][1080,2400]"><node text="Close" resource-id="com.example:id/close" clickable="true" enabled="true" bounds="[20,100][220,200]" /></node></hierarchy>`;
const FIELD = `<?xml version="1.0"?><hierarchy><node bounds="[0,0][1080,2400]"><node text="old" resource-id="com.example:id/email" class="android.widget.EditText" focusable="true" enabled="true" bounds="[100,300][900,420]" /></node></hierarchy>`;
const FILLED_FIELD = FIELD.replace('text="old"', 'text="person@example.com"');
const HINTED_EMPTY_FIELD = FIELD.replace('text="old"', 'text="Email" hint="Email"');
const SCROLLER = `<?xml version="1.0"?><hierarchy><node resource-id="com.example:id/list" scrollable="true" enabled="true" bounds="[100,400][900,2000]" /></hierarchy>`;
const AUDIT = `<?xml version="1.0"?><hierarchy><node bounds="[0,0][1080,2400]"><node text="Save" resource-id="com.example:id/save" clickable="true" enabled="true" bounds="[20,100][220,200]" /><node class="android.widget.ImageButton" clickable="true" enabled="true" bounds="[240,100][440,200]" /></node></hierarchy>`;
const COMPOSITE_AUDIT = `<?xml version="1.0"?><hierarchy><node bounds="[0,0][1080,2400]"><node resource-id="com.example:id/list" class="android.widget.ScrollView" focusable="true" scrollable="true" enabled="true" bounds="[0,100][1080,2200]"><node clickable="true" enabled="true" bounds="[20,120][1060,300]"><node text="Notifications" class="android.widget.TextView" enabled="true" bounds="[60,150][500,220]" /><node class="android.widget.Switch" checkable="true" enabled="true" bounds="[850,140][1020,260]" /></node></node><node hint="Email" class="android.widget.EditText" focusable="true" enabled="true" bounds="[20,2240][1060,2360]" /><node clickable="true" enabled="true" bounds="[0,2500][1080,2400]" /></node></hierarchy>`;
const PARTIAL_AUDIT = `<?xml version="1.0"?><hierarchy><node clickable="true" enabled="true" bounds="[20,100][220,200]" />${"<node>".repeat(102)}${"</node>".repeat(102)}</hierarchy>`;
const DUPLICATE = `<?xml version="1.0"?><hierarchy><node><node text="Same" clickable="true" enabled="true" bounds="[10,10][100,100]" /><node text="Same" clickable="true" enabled="true" bounds="[110,10][200,100]" /></node></hierarchy>`;
const NON_ACTIONABLE = `<?xml version="1.0"?><hierarchy><node text="Label" enabled="true" bounds="[10,10][100,100]" /></hierarchy>`;
const LABELED_ROW = `<?xml version="1.0"?><hierarchy><node bounds="[0,0][1080,2400]"><node resource-id="android:id/apps_row" clickable="true" enabled="true" bounds="[20,100][1060,240]"><node class="android.widget.LinearLayout" enabled="true" bounds="[63,100][1060,240]"><node text="Apps" resource-id="android:id/title" class="android.widget.TextView" enabled="true" bounds="[63,120][148,190]" /></node></node></node></hierarchy>`;
const DESCRIBED_ROW = LABELED_ROW.replace('text="Apps"', 'content-desc="Open apps"');
const NOT_EDITABLE = `<?xml version="1.0"?><hierarchy><node text="Label" resource-id="com.example:id/label" clickable="true" enabled="true" bounds="[10,10][100,100]" /></hierarchy>`;

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
): CommandDependencies & { runner: NonNullable<CommandDependencies["runner"]> } {
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
        after: { acquisitionDurationMs: 10 },
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
            {
              code: "UI_ACTIONABLE_UNLABELED",
              severity: "warning",
              confidence: "high",
              rationale: expect.stringContaining("descendants"),
            },
            {
              code: "UI_ACTIONABLE_WITHOUT_STABLE_ID",
              severity: "info",
              confidence: "high",
              rationale: expect.stringContaining("digest-scoped"),
            },
          ],
        },
      },
    });
  });

  test("uses effective hierarchy labels without auditing scroll and focus containers", async () => {
    const execution = await runUiAction({ action: "audit" }, {}, fixture([COMPOSITE_AUDIT]));

    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        audit: {
          actionableNodes: 3,
          labeledNodes: 3,
          stableIdNodes: 0,
          findingCount: 3,
          findings: [
            {
              code: "UI_ACTIONABLE_WITHOUT_STABLE_ID",
              rationale: expect.stringContaining("effective text"),
              effectiveLabel: { source: "descendant", kind: "text", value: "Notifications" },
            },
            {
              code: "UI_ACTIONABLE_WITHOUT_STABLE_ID",
              rationale: expect.stringContaining("effective text"),
              effectiveLabel: { source: "ancestor", kind: "text", value: "Notifications" },
            },
            {
              code: "UI_ACTIONABLE_WITHOUT_STABLE_ID",
              rationale: expect.stringContaining("human-readable hint"),
              effectiveLabel: { source: "self", kind: "hint", value: "Email" },
            },
          ],
        },
      },
    });
  });

  test("downgrades missing-label confidence when the hierarchy is incomplete", async () => {
    const execution = await runUiAction({ action: "audit" }, {}, fixture([PARTIAL_AUDIT]));

    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        after: { complete: false, truncated: true },
        audit: {
          findings: [
            {
              code: "UI_ACTIONABLE_UNLABELED",
              confidence: "medium",
              rationale: expect.stringContaining("partial hierarchy"),
            },
            {
              code: "UI_ACTIONABLE_WITHOUT_STABLE_ID",
              confidence: "high",
            },
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

  test("taps the nearest actionable ancestor of a unique text label", async () => {
    const requests: string[][] = [];
    const snapshot = parseUiHierarchy(LABELED_ROW);
    const row = snapshot?.nodes.find(({ resourceId }) => resourceId === "android:id/apps_row");
    const label = snapshot?.nodes.find(({ text }) => text === "Apps");
    const execution = await runUiAction(
      { action: "tap", selector: "text=Apps" },
      {},
      fixture([LABELED_ROW, AFTER], requests),
    );

    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        matched: { ref: label?.ref, text: "Apps", clickable: false },
        actionNode: {
          ref: row?.ref,
          resourceId: "android:id/apps_row",
          clickable: true,
        },
        resolved: { ref: row?.ref, x: 540, y: 170 },
        verified: true,
      },
    });
    expect(requests).toContainEqual(
      expect.arrayContaining(["shell", "input", "tap", "540", "170"]),
    );
  });

  test("resolves a unique content description through its actionable ancestor", async () => {
    const execution = await runUiAction(
      { action: "tap", selector: "desc=Open apps", dryRun: true },
      {},
      fixture([DESCRIBED_ROW]),
    );

    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        status: "planned",
        matched: { contentDescription: "Open apps", clickable: false },
        actionNode: { resourceId: "android:id/apps_row", clickable: true },
        resolved: { x: 540, y: 170 },
      },
    });
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

  test("verifies a cleared field when Android exposes its declared hint as text", async () => {
    const execution = await runUiAction(
      { action: "clear", selector: "id=com.example:id/email" },
      {},
      fixture([FIELD, HINTED_EMPTY_FIELD]),
    );

    expect(execution.result).toMatchObject({
      ok: true,
      data: {
        verified: true,
        verification: "text-cleared",
        after: { digest: expect.any(String) },
      },
      problems: [],
    });
  });

  test("scrolls by content direction inside one semantic container", async () => {
    const requests: string[][] = [];
    const execution = await runUiAction(
      { action: "scroll", direction: "down", selector: "id=com.example:id/list" },
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

  test("keeps swipe direction physical while scroll direction describes content navigation", async () => {
    const scroll = await runUiAction(
      { action: "scroll", direction: "right", dryRun: true },
      {},
      fixture([BEFORE]),
    );
    const swipe = await runUiAction(
      { action: "swipe", direction: "right", dryRun: true },
      {},
      fixture([BEFORE]),
    );
    expect(scroll.result.data?.plan?.steps[0]?.args).toEqual(
      expect.arrayContaining(["input", "swipe", "864", "1200", "216", "1200", "350"]),
    );
    expect(swipe.result.data?.plan?.steps[0]?.args).toEqual(
      expect.arrayContaining(["input", "swipe", "216", "1200", "864", "1200", "350"]),
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

  test("rejects malformed selectors, limits, digests, and wait bounds", async () => {
    const fixtures = [
      {
        request: { action: "find" as const, selector: "missing-separator" },
        code: "UI_SELECTOR_INVALID",
      },
      {
        request: { action: "find" as const, selector: "text=Open", limit: 101 },
        code: "UI_FIND_LIMIT_INVALID",
      },
      { request: { action: "compare" as const, digest: "short" }, code: "UI_DIGEST_INVALID" },
      {
        request: { action: "wait" as const, selector: "text=Open", timeoutMs: 99 },
        code: "UI_WAIT_TIMEOUT_INVALID",
      },
    ];
    for (const item of fixtures) {
      const execution = await runUiAction(item.request, {}, fixture([BEFORE]));
      expect(execution.result).toMatchObject({ ok: false, problems: [{ code: item.code }] });
    }
  });

  test("reports missing, ambiguous, invalid, and unavailable selector occurrences", async () => {
    const fixtures = [
      {
        request: { action: "get" as const, selector: "text=Missing" },
        code: "UI_SELECTOR_NOT_FOUND",
      },
      { request: { action: "get" as const, selector: "text=Same" }, code: "UI_SELECTOR_AMBIGUOUS" },
      {
        request: { action: "get" as const, selector: "text=Same", occurrence: 0 },
        code: "UI_SELECTOR_OCCURRENCE_INVALID",
      },
      {
        request: { action: "get" as const, selector: "text=Same", occurrence: 3 },
        code: "UI_SELECTOR_OCCURRENCE_MISSING",
      },
    ];
    for (const item of fixtures) {
      const execution = await runUiAction(item.request, {}, fixture([DUPLICATE]));
      expect(execution.result).toMatchObject({ ok: false, problems: [{ code: item.code }] });
    }
  });

  test("validates references, actionability, editability, and display coordinates", async () => {
    const currentRef = parseUiHierarchy(NON_ACTIONABLE)?.nodes[0]?.ref ?? "";
    const fixtures = [
      { request: { action: "tap" as const, ref: "invalid" }, xml: BEFORE, code: "UI_REF_INVALID" },
      {
        request: { action: "tap" as const, ref: currentRef },
        xml: NON_ACTIONABLE,
        code: "UI_REF_NOT_ACTIONABLE",
      },
      {
        request: { action: "tap" as const, selector: "text=Label" },
        xml: NON_ACTIONABLE,
        code: "UI_SELECTOR_NOT_ACTIONABLE",
      },
      {
        request: { action: "fill" as const, selector: "id=com.example:id/label", text: "value" },
        xml: NOT_EDITABLE,
        code: "UI_SELECTOR_NOT_EDITABLE",
      },
      {
        request: { action: "tap" as const, x: 1080, y: 20 },
        xml: BEFORE,
        code: "UI_COORDINATE_INVALID",
      },
      {
        request: { action: "swipe" as const, x1: -1, y1: 0, x2: 20, y2: 30 },
        xml: BEFORE,
        code: "UI_COORDINATE_INVALID",
      },
    ];
    for (const item of fixtures) {
      const execution = await runUiAction(item.request, { dryRun: true }, fixture([item.xml]));
      expect(execution.result).toMatchObject({ ok: false, problems: [{ code: item.code }] });
    }
  });

  test("rejects non-scrollable targets and unsafe replacement text", async () => {
    const notScrollable = await runUiAction(
      { action: "scroll", direction: "down", selector: "text=Label" },
      {},
      fixture([NON_ACTIONABLE]),
    );
    expect(notScrollable.result).toMatchObject({
      ok: false,
      problems: [{ code: "UI_SELECTOR_NOT_SCROLLABLE" }],
    });

    const unsafe = await runUiAction(
      { action: "fill", selector: "id=com.example:id/email", text: "unsafe$(value)" },
      {},
      fixture([FIELD]),
    );
    expect(unsafe.result).toMatchObject({ ok: false, problems: [{ code: "UI_TEXT_UNSUPPORTED" }] });
  });

  test("plans long press, explicit swipe, typed submit, clear, and filled submit exactly", async () => {
    const ref = parseUiHierarchy(BEFORE)?.nodes[1]?.ref ?? "";
    const fixtures = [
      {
        request: { action: "long-press" as const, ref, dryRun: true },
        xml: BEFORE,
        ids: ["long-press"],
      },
      {
        request: { action: "swipe" as const, x1: 10, y1: 20, x2: 300, y2: 400, dryRun: true },
        xml: BEFORE,
        ids: ["swipe"],
      },
      {
        request: { action: "type" as const, text: "hello world", submit: true, dryRun: true },
        xml: BEFORE,
        ids: ["type", "submit"],
      },
      {
        request: { action: "clear" as const, selector: "id=com.example:id/email", dryRun: true },
        xml: FIELD,
        ids: ["clear", "select-text", "clear-text"],
      },
      {
        request: {
          action: "fill" as const,
          selector: "id=com.example:id/email",
          text: "new",
          submit: true,
          dryRun: true,
        },
        xml: FIELD,
        ids: ["fill", "select-text", "clear-text", "type-text", "submit"],
      },
    ];
    for (const item of fixtures) {
      const execution = await runUiAction(item.request, {}, fixture([item.xml]));
      expect(execution.result.data?.plan?.steps.map(({ id }) => id)).toEqual(item.ids);
    }
  });

  test("supports gone assertions and bounded wait timeouts", async () => {
    const gone = await runUiAction(
      { action: "assert", selector: "text=Missing", state: "gone" },
      {},
      fixture([BEFORE]),
    );
    expect(gone.result).toMatchObject({ ok: true, data: { verified: true, status: "matched" } });

    const timedOut = await runUiAction(
      { action: "wait", selector: "text=Missing", state: "visible", timeoutMs: 100 },
      {},
      fixture([BEFORE], [], async () => false),
    );
    expect(timedOut.result).toMatchObject({
      ok: false,
      data: { status: "timed-out", verified: false, attempts: 1 },
      problems: [{ code: "UI_WAIT_TIMEOUT" }],
    });
  });

  test("classifies hierarchy acquisition failures without attempting input", async () => {
    for (const item of [
      { output: "ERROR: could not get idle state.", exitCode: 0, code: "UI_NOT_IDLE" },
      { output: "secure window", exitCode: 0, code: "UI_HIERARCHY_UNAVAILABLE" },
      { output: "", exitCode: 1, code: "ADB_COMMAND_FAILED" },
    ]) {
      const deps = fixture([BEFORE]);
      const base = deps.runner;
      deps.runner = async (request) =>
        request.args?.includes("uiautomator")
          ? processResult(request, item.output, item.exitCode)
          : await base(request);
      const execution = await runUiAction({ action: "audit" }, {}, deps);
      expect(execution.result).toMatchObject({ ok: false, problems: [{ code: item.code }] });
    }
  });

  test("surfaces display probing, input capability, and mutation failures", async () => {
    const display = fixture([BEFORE]);
    const displayBase = display.runner;
    display.runner = async (request) =>
      request.args?.includes("wm")
        ? processResult(request, "unknown size")
        : await displayBase(request);
    expect((await runUiAction({ action: "tap", x: 10, y: 10 }, {}, display)).result.ok).toBeFalse();

    const capability = fixture([FIELD]);
    const capabilityBase = capability.runner;
    capability.runner = async (request) =>
      request.args?.includes("help")
        ? processResult(request, "", 1)
        : await capabilityBase(request);
    expect(
      (await runUiAction({ action: "clear", selector: "id=com.example:id/email" }, {}, capability))
        .result.ok,
    ).toBeFalse();

    const mutation = fixture([BEFORE]);
    const mutationBase = mutation.runner;
    mutation.runner = async (request) =>
      request.args?.includes("tap") ? processResult(request, "", 1) : await mutationBase(request);
    expect((await runUiAction({ action: "tap", x: 10, y: 10 }, {}, mutation)).result).toMatchObject(
      {
        ok: false,
        problems: [{ code: "ADB_COMMAND_FAILED" }],
      },
    );
  });

  test("reports observable replacement mismatches and protected field verification gaps", async () => {
    const mismatch = await runUiAction(
      { action: "fill", selector: "id=com.example:id/email", text: "expected" },
      {},
      fixture([FIELD, FIELD]),
    );
    expect(mismatch.result).toMatchObject({
      ok: false,
      data: { verified: false, verification: "text-mismatch", verificationGap: "text-mismatch" },
      problems: [{ code: "UI_TEXT_POSTCONDITION_FAILED" }],
    });

    const uncleared = await runUiAction(
      { action: "clear", selector: "id=com.example:id/email" },
      {},
      fixture([FIELD, FIELD.replace('text="old"', 'text="remaining" hint="Email"')]),
    );
    expect(uncleared.result).toMatchObject({
      ok: false,
      data: { verified: false, verification: "text-mismatch" },
      problems: [{ code: "UI_TEXT_POSTCONDITION_FAILED" }],
    });

    const password = FIELD.replace('focusable="true"', 'focusable="true" password="true"');
    const changedPassword = password.replace('text="old"', 'text="secret"');
    const protectedResult = await runUiAction(
      { action: "fill", selector: "id=com.example:id/email", text: "secret" },
      {},
      fixture([password, changedPassword]),
    );
    expect(protectedResult.result).toMatchObject({
      ok: true,
      data: { verified: false, verificationGap: "text-not-observable" },
    });
  });
});
