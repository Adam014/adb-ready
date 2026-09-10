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

export type UiAction = "long-press" | "press" | "swipe" | "tap" | "type" | "wait";
export type UiDirection = "down" | "left" | "right" | "up";
export type UiKey = "back" | "enter" | "home" | "menu" | "volume-down" | "volume-up";
export type UiWaitState = "gone" | "visible";

export type UiActionRequest =
  | { action: "tap"; ref: string; dryRun?: boolean }
  | { action: "tap"; x: number; y: number; dryRun?: boolean }
  | { action: "long-press"; ref: string; dryRun?: boolean }
  | { action: "long-press"; x: number; y: number; dryRun?: boolean }
  | { action: "swipe"; direction: UiDirection; dryRun?: boolean }
  | { action: "swipe"; x1: number; y1: number; x2: number; y2: number; dryRun?: boolean }
  | { action: "type"; text: string; submit?: boolean; dryRun?: boolean }
  | { action: "press"; key: UiKey; dryRun?: boolean }
  | { action: "wait"; selector: string; state?: UiWaitState; timeoutMs?: number };

export interface UiSnapshotSummary {
  digest: string;
  complete: boolean;
  totalNodes: number;
  truncated: boolean;
}

export interface UiActionData {
  action: UiAction;
  selected: SelectedTarget;
  status: "completed" | "matched" | "planned" | "timed-out";
  verified: boolean;
  attempts: number;
  before?: UiSnapshotSummary;
  after?: UiSnapshotSummary;
  input: Record<string, boolean | number | string>;
  resolved?: { ref?: string; x: number; y: number };
  verification: "planned" | "selector-matched" | "ui-changed" | "ui-unchanged";
  verificationGap?: "ui-unchanged";
  matched?: Pick<UiNode, "className" | "contentDescription" | "ref" | "resourceId" | "text">;
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

function selectorMatch(selector: string, node: UiNode): boolean {
  const separator = selector.indexOf("=");
  if (separator < 1) return false;
  const kind = selector.slice(0, separator);
  const value = selector.slice(separator + 1);
  if (value === "") return false;
  if (kind === "id") return node.resourceId === value;
  if (kind === "text") return node.text === value;
  if (kind === "desc") return node.contentDescription === value;
  return kind === "package" && node.packageName === value;
}

function validSelector(selector: string): boolean {
  return /^(?:desc|id|package|text)=.{1,256}$/u.test(selector);
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

  if (request.action === "wait") {
    if (!validSelector(request.selector)) {
      problems.push(
        problem(
          "UI_SELECTOR_INVALID",
          "input.ui.selector",
          `Invalid UI selector: ${request.selector}.`,
          "Use an exact id=, text=, desc=, or package= selector.",
          current.commandId,
        ),
      );
      return finish<UiActionData>(current, null, problems);
    }
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
            input: { selector: request.selector, state, timeoutMs },
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
        `UI selector ${request.selector} did not become ${state}.`,
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
        input: { selector: request.selector, state, timeoutMs },
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

  if (request.action === "tap" || request.action === "long-press") {
    const size = await screenSize(ready, current.commandId, problems, signal);
    if (size === undefined) return finish<UiActionData>(current, null, problems);
    if ("ref" in request) {
      resolved = resolveRef(request.ref, request.action, before, current.commandId, problems);
      input = { ref: request.ref };
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
      verification: changed ? "ui-changed" : "ui-unchanged",
      ...(changed ? {} : { verificationGap: "ui-unchanged" as const }),
    },
    problems,
  );
}
