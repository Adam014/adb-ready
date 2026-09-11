import {
  context,
  finish,
  operationProblem,
  problem,
  readyTarget,
  succeeded,
} from "../app/app-commands.js";
import type { CommandConfig, CommandDependencies, CommandExecution } from "../app/commands.js";
import { type OperationPlan, type Problem, SCHEMA_VERSION } from "../domain/contracts.js";
import type { SelectedTarget } from "../target/selection.js";
import { parseUiHierarchy, type UiHierarchySnapshot, type UiNode } from "./ui-hierarchy.js";

export type UiAction =
  | "assert"
  | "compare"
  | "find"
  | "long-press"
  | "press"
  | "swipe"
  | "tap"
  | "type"
  | "wait";
export type UiDirection = "down" | "left" | "right" | "up";
export type UiKey = "back" | "enter" | "home" | "menu" | "volume-down" | "volume-up";
export type UiWaitState = "gone" | "visible";
export interface UiSelectorSpec {
  field: "class" | "desc" | "id" | "package" | "text";
  value: string;
  match?: "contains" | "exact" | "starts-with" | undefined;
  enabled?: boolean | undefined;
  actionable?: boolean | undefined;
}
export type UiSelector = string | UiSelectorSpec;

export type UiActionRequest =
  | { action: "tap"; ref: string; dryRun?: boolean }
  | { action: "tap"; x: number; y: number; dryRun?: boolean }
  | { action: "tap"; selector: UiSelector; occurrence?: number; dryRun?: boolean }
  | { action: "long-press"; ref: string; dryRun?: boolean }
  | { action: "long-press"; x: number; y: number; dryRun?: boolean }
  | { action: "long-press"; selector: UiSelector; occurrence?: number; dryRun?: boolean }
  | { action: "swipe"; direction: UiDirection; dryRun?: boolean }
  | { action: "swipe"; x1: number; y1: number; x2: number; y2: number; dryRun?: boolean }
  | { action: "type"; text: string; submit?: boolean; dryRun?: boolean }
  | { action: "press"; key: UiKey; dryRun?: boolean }
  | { action: "find"; selector: UiSelector; limit?: number }
  | { action: "assert"; selector: UiSelector; state?: UiWaitState }
  | { action: "compare"; digest: string }
  | { action: "wait"; selector: UiSelector; state?: UiWaitState; timeoutMs?: number };

export interface UiSnapshotSummary {
  digest: string;
  complete: boolean;
  totalNodes: number;
  truncated: boolean;
}

export interface UiActionData {
  action: UiAction;
  selected: SelectedTarget;
  status: "completed" | "matched" | "observed" | "planned" | "timed-out";
  verified: boolean;
  attempts: number;
  before?: UiSnapshotSummary;
  after?: UiSnapshotSummary;
  input: Record<string, boolean | number | string>;
  resolved?: { ref?: string; x: number; y: number };
  verification: "planned" | "query-completed" | "selector-matched" | "ui-changed" | "ui-unchanged";
  verificationGap?: "ui-unchanged";
  matched?: Pick<UiNode, "className" | "contentDescription" | "ref" | "resourceId" | "text">;
  matches?: Array<Pick<UiNode, "className" | "contentDescription" | "ref" | "resourceId" | "text">>;
  matchCount?: number;
  plan?: OperationPlan;
}

const MAX_COORDINATE = 100_000;
const REF_PATTERN = /^ui:([a-f0-9]{12}):(\d+)$/u;
const SAFE_TEXT_PATTERN = /^[A-Za-z0-9 ._@+,:/-]{1,256}$/u;
const KEYCODES: Record<UiKey, number> = {
  back: 4,
  enter: 66,
  home: 3,
  menu: 82,
  "volume-down": 25,
  "volume-up": 24,
};

type Ready = NonNullable<Awaited<ReturnType<typeof readyTarget>>>;

function summary(snapshot: UiHierarchySnapshot): UiSnapshotSummary {
  return {
    digest: snapshot.digest,
    complete: snapshot.complete,
    totalNodes: snapshot.totalNodes,
    truncated: snapshot.truncated,
  };
}

function validCoordinate(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COORDINATE;
}

async function hierarchy(
  ready: Ready,
  commandId: string,
  problems: Problem[],
  signal?: AbortSignal,
): Promise<UiHierarchySnapshot | undefined> {
  const observation = await ready.client.targetCommand(
    ready.target,
    "ui-snapshot",
    "Reading Android UI state",
    ["exec-out", "uiautomator", "dump", "/dev/tty"],
    (output) => parseUiHierarchy(output, { maxDepth: 100, maxNodes: 2_000 }),
    signal,
    { maxBufferBytes: 8 * 1024 * 1024 },
  );
  if (!succeeded(observation.process)) {
    problems.push(operationProblem("ui-snapshot", observation, commandId));
    return undefined;
  }
  if (observation.value === undefined) {
    problems.push(
      problem(
        "UI_HIERARCHY_UNAVAILABLE",
        "evidence.ui",
        "Android returned no readable UI hierarchy.",
        "The current window may be secure, inaccessible, or unsupported by UI Automator.",
        commandId,
      ),
    );
  }
  return observation.value;
}

function parseScreenSize(output: string): { width: number; height: number } | undefined {
  const matches = [...output.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/gu)];
  const match = matches.at(-1);
  if (match === undefined) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return validCoordinate(width) && validCoordinate(height) && width > 0 && height > 0
    ? { width, height }
    : undefined;
}

async function screenSize(
  ready: Ready,
  commandId: string,
  problems: Problem[],
  signal?: AbortSignal,
): Promise<{ width: number; height: number } | undefined> {
  const observation = await ready.client.targetCommand(
    ready.target,
    "ui-screen-size",
    "Reading Android display size",
    ["shell", "wm", "size"],
    parseScreenSize,
    signal,
  );
  if (!succeeded(observation.process) || observation.value === undefined) {
    problems.push(operationProblem("ui-screen-size", observation, commandId));
    return undefined;
  }
  return observation.value;
}

function validatePoint(
  point: { x: number; y: number },
  size: { width: number; height: number },
  commandId: string,
  problems: Problem[],
): boolean {
  if (
    !validCoordinate(point.x) ||
    !validCoordinate(point.y) ||
    point.x >= size.width ||
    point.y >= size.height
  ) {
    problems.push(
      problem(
        "UI_COORDINATE_INVALID",
        "input.ui.coordinate",
        `UI coordinate ${String(point.x)},${String(point.y)} is outside the ${String(size.width)}x${String(size.height)} display.`,
        "Use non-negative integer coordinates inside the current display.",
        commandId,
      ),
    );
    return false;
  }
  return true;
}

function resolveRef(
  ref: string,
  action: "long-press" | "tap",
  snapshot: UiHierarchySnapshot,
  commandId: string,
  problems: Problem[],
): { ref: string; x: number; y: number } | undefined {
  const parsed = ref.match(REF_PATTERN);
  if (parsed === null) {
    problems.push(
      problem(
        "UI_REF_INVALID",
        "input.ui.ref",
        `Invalid UI reference: ${ref}.`,
        "Copy a ui:<digest>:<index> reference from adb-ready inspect ui.",
        commandId,
      ),
    );
    return undefined;
  }
  if (parsed[1] !== snapshot.digest.slice(0, 12)) {
    problems.push(
      problem(
        "UI_REF_STALE",
        "input.ui.ref",
        `UI reference ${ref} no longer matches the current screen.`,
        "Inspect the UI again and use a reference from the new snapshot.",
        commandId,
      ),
    );
    return undefined;
  }
  const node = snapshot.nodes.find(({ ref: candidate }) => candidate === ref);
  const applicable =
    node?.enabled === true &&
    (action === "long-press" ? node.longClickable : node.clickable || node.checkable) &&
    node.bounds !== undefined &&
    node.bounds.right > node.bounds.left &&
    node.bounds.bottom > node.bounds.top;
  if (!applicable || node?.bounds === undefined) {
    problems.push(
      problem(
        "UI_REF_NOT_ACTIONABLE",
        "input.ui.ref",
        `UI reference ${ref} is not ${action === "tap" ? "clickable" : "long-clickable"}.`,
        "Choose an enabled actionable node with valid bounds from inspect ui --interactive-only.",
        commandId,
      ),
    );
    return undefined;
  }
  return {
    ref,
    x: Math.floor((node.bounds.left + node.bounds.right) / 2),
    y: Math.floor((node.bounds.top + node.bounds.bottom) / 2),
  };
}

function resolveSelector(
  selector: UiSelector,
  occurrence: number | undefined,
  action: "long-press" | "tap",
  snapshot: UiHierarchySnapshot,
  commandId: string,
  problems: Problem[],
): { ref: string; x: number; y: number; matched: UiNode } | undefined {
  const matches = snapshot.nodes.filter((node) => selectorMatch(selector, node));
  if (matches.length === 0) {
    problems.push(
      problem(
        "UI_SELECTOR_NOT_FOUND",
        "input.ui.selector",
        `No UI node matches ${selectorLabel(selector)}.`,
        "Inspect the current UI or wait for the selector before acting.",
        commandId,
      ),
    );
    return undefined;
  }
  if (occurrence === undefined && matches.length > 1) {
    problems.push(
      problem(
        "UI_SELECTOR_AMBIGUOUS",
        "input.ui.selector",
        `${selectorLabel(selector)} matches ${String(matches.length)} UI nodes.`,
        "Add selector qualifiers or pass a one-based occurrence explicitly.",
        commandId,
      ),
    );
    return undefined;
  }
  if (occurrence !== undefined && (!Number.isSafeInteger(occurrence) || occurrence < 1)) {
    problems.push(
      problem(
        "UI_SELECTOR_OCCURRENCE_INVALID",
        "input.ui.selector",
        "UI selector occurrence must be a one-based integer.",
        "Use a value starting at 1 or make the selector unique.",
        commandId,
      ),
    );
    return undefined;
  }
  const node = matches[(occurrence ?? 1) - 1];
  if (node === undefined) {
    problems.push(
      problem(
        "UI_SELECTOR_OCCURRENCE_MISSING",
        "input.ui.selector",
        `${selectorLabel(selector)} has no occurrence ${String(occurrence)}.`,
        `Choose an occurrence from 1 to ${String(matches.length)}.`,
        commandId,
      ),
    );
    return undefined;
  }
  const applicable =
    node.enabled &&
    (action === "long-press" ? node.longClickable : node.clickable || node.checkable) &&
    node.bounds !== undefined &&
    node.bounds.right > node.bounds.left &&
    node.bounds.bottom > node.bounds.top;
  if (!applicable || node.bounds === undefined) {
    problems.push(
      problem(
        "UI_SELECTOR_NOT_ACTIONABLE",
        "input.ui.selector",
        `The selected UI node is not ${action === "tap" ? "clickable" : "long-clickable"}.`,
        "Match an enabled actionable node or inspect the hierarchy for a better selector.",
        commandId,
      ),
    );
    return undefined;
  }
  return {
    ref: node.ref,
    x: Math.floor((node.bounds.left + node.bounds.right) / 2),
    y: Math.floor((node.bounds.top + node.bounds.bottom) / 2),
    matched: node,
  };
}

function remoteArgs(ready: Ready, config: CommandConfig, args: string[]): string[] {
  return [
    ...(config.adbHost === undefined ? [] : ["-H", config.adbHost]),
    ...(config.adbPort === undefined ? [] : ["-P", String(config.adbPort)]),
    ...(ready.target.transportId === undefined
      ? ["-s", ready.target.serial]
      : ["-t", ready.target.transportId]),
    ...args,
  ];
}

function normalizeSelector(selector: UiSelector): UiSelectorSpec | undefined {
  if (typeof selector !== "string") {
    return selector.value.length >= 1 && selector.value.length <= 256 ? selector : undefined;
  }
  const separator = selector.indexOf("=");
  if (separator < 1) return undefined;
  const field = selector.slice(0, separator);
  const value = selector.slice(separator + 1);
  if (!new Set(["class", "desc", "id", "package", "text"]).has(field) || value.length < 1) {
    return undefined;
  }
  if (value.length > 256) return undefined;
  return { field: field as UiSelectorSpec["field"], value, match: "exact" };
}

function selectorLabel(selector: UiSelector): string {
  if (typeof selector === "string") return selector;
  const qualifiers = [
    selector.match ?? "exact",
    ...(selector.enabled === undefined ? [] : [`enabled:${String(selector.enabled)}`]),
    ...(selector.actionable === undefined ? [] : [`actionable:${String(selector.actionable)}`]),
  ];
  return `${selector.field}=${selector.value} (${qualifiers.join(",")})`;
}

function nodeValue(field: UiSelectorSpec["field"], node: UiNode): string | undefined {
  if (field === "id") return node.resourceId;
  if (field === "text") return node.text;
  if (field === "desc") return node.contentDescription;
  if (field === "class") return node.className;
  return node.packageName;
}

function actionable(node: UiNode): boolean {
  return (
    node.clickable || node.checkable || node.focusable || node.longClickable || node.scrollable
  );
}

function selectorMatch(selector: UiSelector, node: UiNode): boolean {
  const parsed = normalizeSelector(selector);
  if (parsed === undefined) return false;
  const candidate = nodeValue(parsed.field, node);
  if (candidate === undefined) return false;
  const matched =
    parsed.match === "contains"
      ? candidate.includes(parsed.value)
      : parsed.match === "starts-with"
        ? candidate.startsWith(parsed.value)
        : candidate === parsed.value;
  return (
    matched &&
    (parsed.enabled === undefined || parsed.enabled === node.enabled) &&
    (parsed.actionable === undefined || parsed.actionable === actionable(node))
  );
}

async function delay(
  milliseconds: number,
  dependencies: CommandDependencies,
  signal?: AbortSignal,
): Promise<boolean> {
  const activeSignal = signal ?? new AbortController().signal;
  if (dependencies.sleep !== undefined) return await dependencies.sleep(milliseconds, activeSignal);
  if (activeSignal.aborted) return false;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      activeSignal.removeEventListener("abort", cancel);
      resolve(true);
    }, milliseconds);
    const cancel = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    activeSignal.addEventListener("abort", cancel, { once: true });
  });
}

function compactNode(node: UiNode): NonNullable<UiActionData["matched"]> {
  return {
    ref: node.ref,
    ...(node.resourceId === undefined ? {} : { resourceId: node.resourceId }),
    ...(node.text === undefined ? {} : { text: node.text }),
    ...(node.contentDescription === undefined
      ? {}
      : { contentDescription: node.contentDescription }),
    ...(node.className === undefined ? {} : { className: node.className }),
  };
}

export async function runUiAction(
  request: UiActionRequest,
  config: CommandConfig = {},
  dependencies: CommandDependencies = {},
  signal?: AbortSignal,
): Promise<CommandExecution<UiActionData>> {
  const current = context(`ui ${request.action}`, dependencies);
  const problems: Problem[] = [];
  const ready = await readyTarget(current, config, dependencies, problems, signal);
  if (ready === undefined) return finish<UiActionData>(current, null, problems);

  if (request.action === "find" || request.action === "assert" || request.action === "wait") {
    if (normalizeSelector(request.selector) === undefined) {
      problems.push(
        problem(
          "UI_SELECTOR_INVALID",
          "input.ui.selector",
          `Invalid UI selector: ${selectorLabel(request.selector)}.`,
          "Use a bounded selector for id, text, description, class, or package.",
          current.commandId,
        ),
      );
      return finish<UiActionData>(current, null, problems);
    }
  }

  if (request.action === "find" || request.action === "assert") {
    const snapshot = await hierarchy(ready, current.commandId, problems, signal);
    if (snapshot === undefined) return finish<UiActionData>(current, null, problems);
    const matches = snapshot.nodes.filter((node) => selectorMatch(request.selector, node));
    const limit = request.action === "find" ? (request.limit ?? 20) : 1;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      problems.push(
        problem(
          "UI_FIND_LIMIT_INVALID",
          "input.ui.limit",
          "UI result limit must be from 1 to 100.",
          "Choose a bounded result limit.",
          current.commandId,
        ),
      );
      return finish<UiActionData>(current, null, problems);
    }
    const state = request.action === "assert" ? (request.state ?? "visible") : undefined;
    const assertionPassed =
      state === undefined || (state === "visible" ? matches.length > 0 : matches.length === 0);
    if (!assertionPassed) {
      problems.push(
        problem(
          "UI_ASSERTION_FAILED",
          "ui.assert",
          `Expected ${selectorLabel(request.selector)} to be ${state}.`,
          `The current hierarchy contains ${String(matches.length)} matching node(s).`,
          current.commandId,
        ),
      );
    }
    return finish(
      current,
      {
        action: request.action,
        selected: ready.selected,
        status: request.action === "find" ? "observed" : assertionPassed ? "matched" : "observed",
        verified: request.action === "find" || assertionPassed,
        attempts: 1,
        after: summary(snapshot),
        input: {
          selector: selectorLabel(request.selector),
          ...(state === undefined ? { limit } : { state }),
        },
        verification: request.action === "find" ? "query-completed" : "selector-matched",
        matchCount: matches.length,
        matches: matches.slice(0, limit).map(compactNode),
        ...(matches[0] === undefined ? {} : { matched: compactNode(matches[0]) }),
      },
      problems,
    );
  }

  if (request.action === "compare") {
    if (!/^[a-f0-9]{64}$/u.test(request.digest)) {
      problems.push(
        problem(
          "UI_DIGEST_INVALID",
          "input.ui.digest",
          "UI digest must be a complete lowercase SHA-256 value.",
          "Use the digest returned by inspect_ui or a previous UI action.",
          current.commandId,
        ),
      );
      return finish<UiActionData>(current, null, problems);
    }
    const snapshot = await hierarchy(ready, current.commandId, problems, signal);
    if (snapshot === undefined) return finish<UiActionData>(current, null, problems);
    const changed = snapshot.digest !== request.digest;
    return finish(
      current,
      {
        action: "compare",
        selected: ready.selected,
        status: "observed",
        verified: true,
        attempts: 1,
        after: summary(snapshot),
        input: { digest: request.digest },
        verification: changed ? "ui-changed" : "ui-unchanged",
      },
      problems,
    );
  }

  if (request.action === "wait") {
    const state = request.state ?? "visible";
    const timeoutMs = request.timeoutMs ?? config.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      problems.push(
        problem(
          "UI_WAIT_TIMEOUT_INVALID",
          "input.ui.timeout",
          `Invalid UI wait timeout: ${String(timeoutMs)}ms.`,
          "Use a timeout from 100ms to 2m.",
          current.commandId,
        ),
      );
      return finish<UiActionData>(current, null, problems);
    }
    const started = Date.now();
    let attempts = 0;
    let last: UiHierarchySnapshot | undefined;
    const maxAttempts = Math.ceil(timeoutMs / 250) + 1;
    while (attempts < maxAttempts) {
      attempts += 1;
      last = await hierarchy(ready, current.commandId, problems, signal);
      if (last === undefined) return finish<UiActionData>(current, null, problems);
      const matched = last.nodes.find((node) => selectorMatch(request.selector, node));
      if (
        (state === "visible" && matched !== undefined) ||
        (state === "gone" && matched === undefined)
      ) {
        return finish(
          current,
          {
            action: "wait",
            selected: ready.selected,
            status: "matched",
            verified: true,
            attempts,
            after: summary(last),
            input: { selector: selectorLabel(request.selector), state, timeoutMs },
            verification: "selector-matched",
            ...(matched === undefined ? {} : { matched: compactNode(matched) }),
          },
          problems,
        );
      }
      if (Date.now() - started >= timeoutMs || !(await delay(250, dependencies, signal))) break;
    }
    problems.push(
      problem(
        "UI_WAIT_TIMEOUT",
        "ui.wait",
        `UI selector ${selectorLabel(request.selector)} did not become ${state}.`,
        `The bounded wait ended after ${String(attempts)} attempt(s).`,
        current.commandId,
      ),
    );
    return finish(
      current,
      {
        action: "wait",
        selected: ready.selected,
        status: "timed-out",
        verified: false,
        attempts,
        ...(last === undefined ? {} : { after: summary(last) }),
        input: { selector: selectorLabel(request.selector), state, timeoutMs },
        verification: "ui-unchanged",
        verificationGap: "ui-unchanged",
      },
      problems,
    );
  }

  const before = await hierarchy(ready, current.commandId, problems, signal);
  if (before === undefined) return finish<UiActionData>(current, null, problems);
  let args: string[];
  let input: UiActionData["input"];
  let resolved: UiActionData["resolved"];
  let matched: UiActionData["matched"];

  if (request.action === "tap" || request.action === "long-press") {
    const size = await screenSize(ready, current.commandId, problems, signal);
    if (size === undefined) return finish<UiActionData>(current, null, problems);
    if ("ref" in request) {
      resolved = resolveRef(request.ref, request.action, before, current.commandId, problems);
      input = { ref: request.ref };
    } else if ("selector" in request) {
      const selected = resolveSelector(
        request.selector,
        request.occurrence,
        request.action,
        before,
        current.commandId,
        problems,
      );
      resolved =
        selected === undefined ? undefined : { ref: selected.ref, x: selected.x, y: selected.y };
      matched = selected === undefined ? undefined : compactNode(selected.matched);
      input = {
        selector: selectorLabel(request.selector),
        ...(request.occurrence === undefined ? {} : { occurrence: request.occurrence }),
      };
    } else {
      resolved = { x: request.x, y: request.y };
      input = { x: request.x, y: request.y };
    }
    if (resolved === undefined || !validatePoint(resolved, size, current.commandId, problems)) {
      return finish<UiActionData>(current, null, problems);
    }
    args =
      request.action === "tap"
        ? ["shell", "input", "tap", String(resolved.x), String(resolved.y)]
        : [
            "shell",
            "input",
            "swipe",
            String(resolved.x),
            String(resolved.y),
            String(resolved.x),
            String(resolved.y),
            "750",
          ];
  } else if (request.action === "swipe") {
    const size = await screenSize(ready, current.commandId, problems, signal);
    if (size === undefined) return finish<UiActionData>(current, null, problems);
    const points =
      "direction" in request
        ? request.direction === "up"
          ? { x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2 }
          : request.direction === "down"
            ? { x1: 0.5, y1: 0.2, x2: 0.5, y2: 0.8 }
            : request.direction === "left"
              ? { x1: 0.8, y1: 0.5, x2: 0.2, y2: 0.5 }
              : { x1: 0.2, y1: 0.5, x2: 0.8, y2: 0.5 }
        : request;
    const startPoint = {
      x: "direction" in request ? Math.floor(size.width * points.x1) : points.x1,
      y: "direction" in request ? Math.floor(size.height * points.y1) : points.y1,
    };
    const endPoint = {
      x: "direction" in request ? Math.floor(size.width * points.x2) : points.x2,
      y: "direction" in request ? Math.floor(size.height * points.y2) : points.y2,
    };
    if (
      !validatePoint(startPoint, size, current.commandId, problems) ||
      !validatePoint(endPoint, size, current.commandId, problems)
    ) {
      return finish<UiActionData>(current, null, problems);
    }
    input =
      "direction" in request
        ? { direction: request.direction }
        : { x1: request.x1, y1: request.y1, x2: request.x2, y2: request.y2 };
    args = [
      "shell",
      "input",
      "swipe",
      String(startPoint.x),
      String(startPoint.y),
      String(endPoint.x),
      String(endPoint.y),
      "350",
    ];
  } else if (request.action === "type") {
    if (!SAFE_TEXT_PATTERN.test(request.text)) {
      problems.push(
        problem(
          "UI_TEXT_UNSUPPORTED",
          "input.ui.text",
          "Text contains characters that cannot be typed safely through Android input.",
          "Use 1-256 ASCII letters, numbers, spaces, or ._@+,:/- characters.",
          current.commandId,
        ),
      );
      return finish<UiActionData>(current, null, problems);
    }
    const encoded = request.text.replaceAll(" ", "%s");
    input = { text: request.text, submit: request.submit === true };
    args = ["shell", "input", "text", encoded];
  } else if (request.action === "press") {
    input = { key: request.key };
    args = ["shell", "input", "keyevent", String(KEYCODES[request.key])];
  } else {
    const unreachable: never = request;
    throw new Error(`Unsupported UI action: ${String(unreachable)}`);
  }

  const steps: OperationPlan["steps"] = [
    {
      id: request.action,
      title: `Send Android UI ${request.action}`,
      risk: "device-reversible",
      executable: ready.adbPath,
      args: remoteArgs(ready, config, args),
    },
    ...(request.action === "type" && request.submit === true
      ? [
          {
            id: "submit",
            title: "Press Android enter key",
            risk: "device-reversible" as const,
            executable: ready.adbPath,
            args: remoteArgs(ready, config, ["shell", "input", "keyevent", "66"]),
          },
        ]
      : []),
  ];
  if (request.dryRun === true || config.dryRun === true) {
    return finish(
      current,
      {
        action: request.action,
        selected: ready.selected,
        status: "planned",
        verified: false,
        attempts: 0,
        before: summary(before),
        input,
        ...(resolved === undefined ? {} : { resolved }),
        ...(matched === undefined ? {} : { matched }),
        verification: "planned",
        plan: { schemaVersion: SCHEMA_VERSION, dryRun: true, steps },
      },
      problems,
    );
  }

  for (const [index, stepArgs] of [
    args,
    ...(request.action === "type" && request.submit === true
      ? [["shell", "input", "keyevent", "66"]]
      : []),
  ].entries()) {
    const operation = await ready.client.targetCommand(
      ready.target,
      index === 0 ? `ui-${request.action}` : "ui-submit",
      index === 0 ? `Sending Android UI ${request.action}` : "Submitting Android text input",
      stepArgs,
      () => undefined,
      signal,
    );
    if (!succeeded(operation.process)) {
      problems.push(
        operationProblem(
          index === 0 ? `ui-${request.action}` : "ui-submit",
          operation,
          current.commandId,
        ),
      );
      return finish<UiActionData>(current, null, problems);
    }
  }
  const after = await hierarchy(ready, current.commandId, problems, signal);
  if (after === undefined) return finish<UiActionData>(current, null, problems);
  const changed = before.digest !== after.digest;
  return finish(
    current,
    {
      action: request.action,
      selected: ready.selected,
      status: "completed",
      verified: changed,
      attempts: 1,
      before: summary(before),
      after: summary(after),
      input,
      ...(resolved === undefined ? {} : { resolved }),
      ...(matched === undefined ? {} : { matched }),
      verification: changed ? "ui-changed" : "ui-unchanged",
      ...(changed ? {} : { verificationGap: "ui-unchanged" as const }),
    },
    problems,
  );
}
