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
  | "audit"
  | "clear"
  | "compare"
  | "fill"
  | "find"
  | "get"
  | "long-press"
  | "press"
  | "scroll"
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
  | { action: "audit" }
  | { action: "tap"; ref: string; dryRun?: boolean }
  | { action: "tap"; x: number; y: number; dryRun?: boolean }
  | { action: "tap"; selector: UiSelector; occurrence?: number; dryRun?: boolean }
  | { action: "long-press"; ref: string; dryRun?: boolean }
  | { action: "long-press"; x: number; y: number; dryRun?: boolean }
  | { action: "long-press"; selector: UiSelector; occurrence?: number; dryRun?: boolean }
  | { action: "swipe"; direction: UiDirection; dryRun?: boolean }
  | { action: "swipe"; x1: number; y1: number; x2: number; y2: number; dryRun?: boolean }
  | { action: "type"; text: string; submit?: boolean; dryRun?: boolean }
  | {
      action: "fill";
      selector: UiSelector;
      occurrence?: number;
      text: string;
      submit?: boolean;
      dryRun?: boolean;
    }
  | { action: "clear"; selector: UiSelector; occurrence?: number; dryRun?: boolean }
  | { action: "press"; key: UiKey; dryRun?: boolean }
  | { action: "find"; selector: UiSelector; limit?: number }
  | { action: "get"; selector: UiSelector; occurrence?: number }
  | {
      action: "scroll";
      direction: UiDirection;
      selector?: UiSelector;
      occurrence?: number;
      dryRun?: boolean;
    }
  | { action: "assert"; selector: UiSelector; state?: UiWaitState }
  | { action: "compare"; digest: string }
  | { action: "wait"; selector: UiSelector; state?: UiWaitState; timeoutMs?: number };

export interface UiSnapshotSummary {
  digest: string;
  complete: boolean;
  totalNodes: number;
  truncated: boolean;
  acquisitionDurationMs?: number;
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
  verification:
    | "planned"
    | "query-completed"
    | "selector-matched"
    | "text-cleared"
    | "text-matched"
    | "text-mismatch"
    | "ui-changed"
    | "ui-unchanged";
  verificationGap?: "text-mismatch" | "text-not-observable" | "ui-unchanged";
  matched?: UiNode;
  matches?: UiNode[];
  matchCount?: number;
  audit?: UiAuditReport;
  plan?: OperationPlan;
}

export interface UiAuditFinding {
  code: "UI_ACTIONABLE_UNLABELED" | "UI_ACTIONABLE_WITHOUT_STABLE_ID";
  severity: "info" | "warning";
  summary: string;
  node: UiNode;
}

export interface UiAuditReport {
  actionableNodes: number;
  labeledNodes: number;
  stableIdNodes: number;
  findingCount: number;
  findingsTruncated: boolean;
  findings: UiAuditFinding[];
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
type MeasuredUiSnapshot = UiHierarchySnapshot & { acquisitionDurationMs: number };

function summary(snapshot: UiHierarchySnapshot | MeasuredUiSnapshot): UiSnapshotSummary {
  return {
    digest: snapshot.digest,
    complete: snapshot.complete,
    totalNodes: snapshot.totalNodes,
    truncated: snapshot.truncated,
    ...("acquisitionDurationMs" in snapshot
      ? { acquisitionDurationMs: snapshot.acquisitionDurationMs }
      : {}),
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
): Promise<MeasuredUiSnapshot | undefined> {
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
  return observation.value === undefined
    ? undefined
    : { ...observation.value, acquisitionDurationMs: observation.process.durationMs };
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

async function supportsKeyCombination(
  ready: Ready,
  commandId: string,
  problems: Problem[],
  signal?: AbortSignal,
): Promise<boolean> {
  const observation = await ready.client.targetCommand(
    ready.target,
    "ui-input-capabilities",
    "Checking Android text input capabilities",
    ["shell", "input", "help"],
    (output) => /\bkeycombination\b/u.test(output),
    signal,
  );
  if (!succeeded(observation.process)) {
    problems.push(operationProblem("ui-input-capabilities", observation, commandId));
    return false;
  }
  if (observation.value !== true) {
    problems.push(
      problem(
        "UI_CLEAR_UNSUPPORTED",
        "capability.ui.input",
        "This Android target cannot safely replace existing field text through ADB.",
        "Use ui tap followed by ui type to append text, or upgrade the target Android version.",
        commandId,
      ),
    );
    return false;
  }
  return true;
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
  const node = selectUniqueNode(selector, occurrence, snapshot, commandId, problems);
  if (node === undefined) return undefined;
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

function selectUniqueNode(
  selector: UiSelector,
  occurrence: number | undefined,
  snapshot: UiHierarchySnapshot,
  commandId: string,
  problems: Problem[],
): UiNode | undefined {
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
  }
  return node;
}

function nodeCenter(node: UiNode): { ref: string; x: number; y: number } | undefined {
  const bounds = node.bounds;
  if (bounds === undefined || bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
    return undefined;
  }
  return {
    ref: node.ref,
    x: Math.floor((bounds.left + bounds.right) / 2),
    y: Math.floor((bounds.top + bounds.bottom) / 2),
  };
}

function directionalPoints(
  direction: UiDirection,
  bounds: { left: number; top: number; right: number; bottom: number },
): { x1: number; y1: number; x2: number; y2: number } {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const point = (x: number, y: number): { x: number; y: number } => ({
    x: Math.floor(bounds.left + width * x),
    y: Math.floor(bounds.top + height * y),
  });
  const start =
    direction === "up"
      ? point(0.5, 0.8)
      : direction === "down"
        ? point(0.5, 0.2)
        : direction === "left"
          ? point(0.8, 0.5)
          : point(0.2, 0.5);
  const end =
    direction === "up"
      ? point(0.5, 0.2)
      : direction === "down"
        ? point(0.5, 0.8)
        : direction === "left"
          ? point(0.2, 0.5)
          : point(0.8, 0.5);
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
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
    depth: node.depth,
    ...(node.resourceId === undefined ? {} : { resourceId: node.resourceId }),
    ...(node.text === undefined ? {} : { text: node.text }),
    ...(node.contentDescription === undefined
      ? {}
      : { contentDescription: node.contentDescription }),
    ...(node.className === undefined ? {} : { className: node.className }),
    ...(node.packageName === undefined ? {} : { packageName: node.packageName }),
    ...(node.bounds === undefined ? {} : { bounds: node.bounds }),
    clickable: node.clickable,
    checkable: node.checkable,
    checked: node.checked,
    enabled: node.enabled,
    focusable: node.focusable,
    focused: node.focused,
    longClickable: node.longClickable,
    password: node.password,
    scrollable: node.scrollable,
    selected: node.selected,
  };
}

function correspondingNode(node: UiNode, snapshot: UiHierarchySnapshot): UiNode | undefined {
  if (node.resourceId !== undefined) {
    const candidates = snapshot.nodes.filter(({ resourceId }) => resourceId === node.resourceId);
    if (candidates.length === 1) return candidates[0];
  }
  return snapshot.nodes.find(
    (candidate) =>
      candidate.className === node.className &&
      candidate.bounds?.left === node.bounds?.left &&
      candidate.bounds?.top === node.bounds?.top &&
      candidate.bounds?.right === node.bounds?.right &&
      candidate.bounds?.bottom === node.bounds?.bottom,
  );
}

function auditSnapshot(snapshot: UiHierarchySnapshot): UiAuditReport {
  const controls = snapshot.nodes.filter(
    (node) =>
      node.enabled && (node.clickable || node.checkable || node.focusable || node.longClickable),
  );
  const findings: UiAuditFinding[] = [];
  let labeledNodes = 0;
  let stableIdNodes = 0;
  for (const node of controls) {
    const labeled =
      (node.text !== undefined && node.text.trim() !== "") ||
      (node.contentDescription !== undefined && node.contentDescription.trim() !== "");
    const stableId = node.resourceId !== undefined && node.resourceId.trim() !== "";
    if (labeled) labeledNodes += 1;
    else {
      findings.push({
        code: "UI_ACTIONABLE_UNLABELED",
        severity: "warning",
        summary: "Enabled actionable node has no visible text or content description.",
        node: compactNode(node),
      });
    }
    if (stableId) stableIdNodes += 1;
    else {
      findings.push({
        code: "UI_ACTIONABLE_WITHOUT_STABLE_ID",
        severity: "info",
        summary: "Enabled actionable node has no resource ID for a stable automation selector.",
        node: compactNode(node),
      });
    }
  }
  return {
    actionableNodes: controls.length,
    labeledNodes,
    stableIdNodes,
    findingCount: findings.length,
    findingsTruncated: findings.length > 100,
    findings: findings.slice(0, 100),
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

  const requestSelector = "selector" in request ? request.selector : undefined;
  if (requestSelector !== undefined) {
    if (normalizeSelector(requestSelector) === undefined) {
      problems.push(
        problem(
          "UI_SELECTOR_INVALID",
          "input.ui.selector",
          `Invalid UI selector: ${selectorLabel(requestSelector)}.`,
          "Use a bounded selector for id, text, description, class, or package.",
          current.commandId,
        ),
      );
      return finish<UiActionData>(current, null, problems);
    }
  }

  if (request.action === "audit") {
    const snapshot = await hierarchy(ready, current.commandId, problems, signal);
    if (snapshot === undefined) return finish<UiActionData>(current, null, problems);
    return finish(
      current,
      {
        action: "audit",
        selected: ready.selected,
        status: "observed",
        verified: true,
        attempts: 1,
        after: summary(snapshot),
        input: {},
        verification: "query-completed",
        audit: auditSnapshot(snapshot),
      },
      problems,
    );
  }

  if (request.action === "get") {
    const snapshot = await hierarchy(ready, current.commandId, problems, signal);
    if (snapshot === undefined) return finish<UiActionData>(current, null, problems);
    const node = selectUniqueNode(
      request.selector,
      request.occurrence,
      snapshot,
      current.commandId,
      problems,
    );
    if (node === undefined) return finish<UiActionData>(current, null, problems);
    return finish(
      current,
      {
        action: "get",
        selected: ready.selected,
        status: "matched",
        verified: true,
        attempts: 1,
        after: summary(snapshot),
        input: {
          selector: selectorLabel(request.selector),
          ...(request.occurrence === undefined ? {} : { occurrence: request.occurrence }),
        },
        verification: "selector-matched",
        matchCount: 1,
        matched: compactNode(node),
      },
      problems,
    );
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
  let matchedNode: UiNode | undefined;
  const followingSteps: Array<{ id: string; title: string; args: string[] }> = [];

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
      matchedNode = selected?.matched;
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
  } else if (request.action === "swipe" || request.action === "scroll") {
    const size = await screenSize(ready, current.commandId, problems, signal);
    if (size === undefined) return finish<UiActionData>(current, null, problems);
    if (request.action === "scroll" && request.selector !== undefined) {
      matchedNode = selectUniqueNode(
        request.selector,
        request.occurrence,
        before,
        current.commandId,
        problems,
      );
      if (matchedNode === undefined) return finish<UiActionData>(current, null, problems);
      if (!matchedNode.enabled || !matchedNode.scrollable || matchedNode.bounds === undefined) {
        problems.push(
          problem(
            "UI_SELECTOR_NOT_SCROLLABLE",
            "input.ui.selector",
            "The selected UI node is not an enabled scroll container with valid bounds.",
            "Inspect the hierarchy and select a node whose scrollable property is true.",
            current.commandId,
          ),
        );
        return finish<UiActionData>(current, null, problems);
      }
      matched = compactNode(matchedNode);
    }
    const points =
      request.action === "scroll"
        ? directionalPoints(
            request.direction,
            matchedNode?.bounds ?? { left: 0, top: 0, right: size.width, bottom: size.height },
          )
        : "direction" in request
          ? directionalPoints(request.direction, {
              left: 0,
              top: 0,
              right: size.width,
              bottom: size.height,
            })
          : request;
    const startPoint = {
      x: points.x1,
      y: points.y1,
    };
    const endPoint = {
      x: points.x2,
      y: points.y2,
    };
    if (
      !validatePoint(startPoint, size, current.commandId, problems) ||
      !validatePoint(endPoint, size, current.commandId, problems)
    ) {
      return finish<UiActionData>(current, null, problems);
    }
    input =
      request.action === "scroll"
        ? {
            direction: request.direction,
            ...(request.selector === undefined
              ? {}
              : { selector: selectorLabel(request.selector) }),
            ...(request.occurrence === undefined ? {} : { occurrence: request.occurrence }),
          }
        : "direction" in request
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
  } else if (request.action === "fill" || request.action === "clear") {
    matchedNode = selectUniqueNode(
      request.selector,
      request.occurrence,
      before,
      current.commandId,
      problems,
    );
    if (matchedNode === undefined) return finish<UiActionData>(current, null, problems);
    resolved = nodeCenter(matchedNode);
    const size = await screenSize(ready, current.commandId, problems, signal);
    if (size === undefined) return finish<UiActionData>(current, null, problems);
    if (!matchedNode.enabled || !matchedNode.focusable || resolved === undefined) {
      problems.push(
        problem(
          "UI_SELECTOR_NOT_EDITABLE",
          "input.ui.selector",
          "The selected UI node is not an enabled focusable field with valid bounds.",
          "Inspect the hierarchy and select the editable input node rather than its label.",
          current.commandId,
        ),
      );
      return finish<UiActionData>(current, null, problems);
    }
    if (!validatePoint(resolved, size, current.commandId, problems)) {
      return finish<UiActionData>(current, null, problems);
    }
    if (request.action === "fill" && !SAFE_TEXT_PATTERN.test(request.text)) {
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
    if (
      request.dryRun !== true &&
      config.dryRun !== true &&
      !(await supportsKeyCombination(ready, current.commandId, problems, signal))
    ) {
      return finish<UiActionData>(current, null, problems);
    }
    matched = compactNode(matchedNode);
    input = {
      selector: selectorLabel(request.selector),
      ...(request.occurrence === undefined ? {} : { occurrence: request.occurrence }),
      ...(request.action === "fill" ? { text: request.text, submit: request.submit === true } : {}),
    };
    args = ["shell", "input", "tap", String(resolved.x), String(resolved.y)];
    followingSteps.push(
      {
        id: "select-text",
        title: "Select existing Android field text",
        args: ["shell", "input", "keycombination", "KEYCODE_CTRL_LEFT", "KEYCODE_A"],
      },
      {
        id: "clear-text",
        title: "Clear selected Android field text",
        args: ["shell", "input", "keyevent", "KEYCODE_DEL"],
      },
    );
    if (request.action === "fill") {
      followingSteps.push({
        id: "type-text",
        title: "Type Android field text",
        args: ["shell", "input", "text", request.text.replaceAll(" ", "%s")],
      });
      if (request.submit === true) {
        followingSteps.push({
          id: "submit",
          title: "Press Android enter key",
          args: ["shell", "input", "keyevent", "KEYCODE_ENTER"],
        });
      }
    }
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
    if (request.submit === true) {
      followingSteps.push({
        id: "submit",
        title: "Press Android enter key",
        args: ["shell", "input", "keyevent", "KEYCODE_ENTER"],
      });
    }
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
    ...followingSteps.map((step) => ({
      id: step.id,
      title: step.title,
      risk: "device-reversible" as const,
      executable: ready.adbPath,
      args: remoteArgs(ready, config, step.args),
    })),
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

  const commands = [
    { id: `ui-${request.action}`, title: `Sending Android UI ${request.action}`, args },
    ...followingSteps.map((step) => ({
      id: `ui-${step.id}`,
      title: step.title,
      args: step.args,
    })),
  ];
  for (const command of commands) {
    const operation = await ready.client.targetCommand(
      ready.target,
      command.id,
      command.title,
      command.args,
      () => undefined,
      signal,
    );
    if (!succeeded(operation.process)) {
      problems.push(operationProblem(command.id, operation, current.commandId));
      return finish<UiActionData>(current, null, problems);
    }
  }
  const after = await hierarchy(ready, current.commandId, problems, signal);
  if (after === undefined) return finish<UiActionData>(current, null, problems);
  const changed = before.digest !== after.digest;
  const resultingNode =
    matchedNode === undefined ? undefined : correspondingNode(matchedNode, after);
  const textObservable =
    (request.action === "fill" || request.action === "clear") &&
    resultingNode !== undefined &&
    !resultingNode.password;
  const textVerified =
    request.action === "fill" && textObservable
      ? resultingNode.text === request.text
      : request.action === "clear" && textObservable
        ? resultingNode.text === undefined || resultingNode.text === ""
        : undefined;
  if (textVerified === false) {
    problems.push(
      problem(
        "UI_TEXT_POSTCONDITION_FAILED",
        "ui.text",
        `Android accepted the ${request.action} input sequence, but the field value did not match afterward.`,
        "Inspect the current hierarchy; the app or input method may have transformed or rejected the value.",
        current.commandId,
      ),
    );
  }
  const verified =
    request.action === "fill" || request.action === "clear" ? textVerified === true : changed;
  const verification =
    request.action === "fill" && textVerified === true
      ? "text-matched"
      : request.action === "clear" && textVerified === true
        ? "text-cleared"
        : textVerified === false
          ? "text-mismatch"
          : changed
            ? "ui-changed"
            : "ui-unchanged";
  return finish(
    current,
    {
      action: request.action,
      selected: ready.selected,
      status: "completed",
      verified,
      attempts: 1,
      before: summary(before),
      after: summary(after),
      input,
      ...(resolved === undefined ? {} : { resolved }),
      ...(matched === undefined ? {} : { matched }),
      verification,
      ...(verified
        ? {}
        : {
            verificationGap:
              textVerified === false
                ? ("text-mismatch" as const)
                : request.action === "fill" || request.action === "clear"
                  ? ("text-not-observable" as const)
                  : ("ui-unchanged" as const),
          }),
    },
    problems,
  );
}
