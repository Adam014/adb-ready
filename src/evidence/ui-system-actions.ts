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
import {
  DEFAULT_UI_SNAPSHOT_TIMEOUT_MS,
  type UiHierarchySnapshot,
  type UiNode,
} from "./ui-hierarchy.js";
import { acquireUiSnapshot } from "./ui-hierarchy-capture.js";

export type KeyboardAction = "dismiss" | "status";
export type PermissionDecision =
  | "allow"
  | "allow-always"
  | "allow-once"
  | "allow-while-using"
  | "deny"
  | "deny-and-dont-ask-again";
export type UiSystemActionRequest =
  | { action: "keyboard"; operation: KeyboardAction; dryRun?: boolean }
  | { action: "permission"; operation: "inspect" }
  | { action: "permission"; operation: "respond"; decision: PermissionDecision; dryRun?: boolean };

export interface KeyboardObservation {
  state: "ambiguous" | "hidden" | "unsupported" | "visible";
  confidence: "high" | "none";
  signals: {
    inputMethod?: boolean;
    windowInsets?: boolean;
  };
}

export interface PermissionDialogObservation {
  state: "absent" | "permission" | "unsupported";
  controllerPackage?: string;
  message?: string;
  availableDecisions: PermissionDecision[];
  digest: string;
}

export interface UiSystemActionData {
  action: "keyboard" | "permission";
  operation: KeyboardAction | "inspect" | "respond";
  selected: SelectedTarget;
  status: "completed" | "observed" | "planned";
  verified: boolean;
  keyboard?: { before: KeyboardObservation; after?: KeyboardObservation; changed: boolean };
  permission?: {
    before: PermissionDialogObservation;
    after?: PermissionDialogObservation;
    decision?: PermissionDecision;
    changed: boolean;
  };
  plan?: OperationPlan;
}

const PERMISSION_CONTROLLER_PACKAGE = /(?:^|\.)android\.permissioncontroller$/u;
const PERMISSION_DIALOG_ID = "com.android.permissioncontroller:id/grant_dialog";
const PERMISSION_MESSAGE_ID = "com.android.permissioncontroller:id/permission_message";
const DECISION_IDS: Readonly<Record<PermissionDecision, string>> = {
  allow: "com.android.permissioncontroller:id/permission_allow_button",
  "allow-always": "com.android.permissioncontroller:id/permission_allow_always_button",
  "allow-once": "com.android.permissioncontroller:id/permission_allow_one_time_button",
  "allow-while-using":
    "com.android.permissioncontroller:id/permission_allow_foreground_only_button",
  deny: "com.android.permissioncontroller:id/permission_deny_button",
  "deny-and-dont-ask-again":
    "com.android.permissioncontroller:id/permission_deny_and_dont_ask_again_button",
};

type Ready = NonNullable<Awaited<ReturnType<typeof readyTarget>>>;

function uniqueBoolean(matches: Iterable<string>): boolean | undefined | "ambiguous" {
  const values = new Set(Array.from(matches, (value) => value === "true"));
  if (values.size === 0) return undefined;
  if (values.size > 1) return "ambiguous";
  return values.values().next().value;
}

export function parseKeyboardObservation(
  inputMethodOutput: string,
  windowOutput: string,
): KeyboardObservation {
  const inputMethod = uniqueBoolean(
    Array.from(
      inputMethodOutput.matchAll(/\bmInputShown=(true|false)\b/gu),
      (match) => match[1] ?? "",
    ),
  );
  const windowInsets = uniqueBoolean(
    Array.from(
      windowOutput.matchAll(/\bInsetsSource\b[^\n]*\btype=ime\b[^\n]*\bvisible=(true|false)\b/gu),
      (match) => match[1] ?? "",
    ),
  );
  if (inputMethod === "ambiguous" || windowInsets === "ambiguous") {
    return { state: "ambiguous", confidence: "none", signals: {} };
  }
  if (inputMethod === undefined || windowInsets === undefined) {
    return {
      state: "unsupported",
      confidence: "none",
      signals: {
        ...(inputMethod === undefined ? {} : { inputMethod }),
        ...(windowInsets === undefined ? {} : { windowInsets }),
      },
    };
  }
  if (inputMethod !== windowInsets) {
    return {
      state: "ambiguous",
      confidence: "none",
      signals: { inputMethod, windowInsets },
    };
  }
  return {
    state: inputMethod ? "visible" : "hidden",
    confidence: "high",
    signals: { inputMethod, windowInsets },
  };
}

function permissionNodes(snapshot: UiHierarchySnapshot): UiNode[] {
  return snapshot.nodes.filter((node) =>
    PERMISSION_CONTROLLER_PACKAGE.test(node.packageName ?? ""),
  );
}

export function observePermissionDialog(
  snapshot: UiHierarchySnapshot,
): PermissionDialogObservation {
  const nodes = permissionNodes(snapshot);
  const roots = nodes.filter((node) => node.resourceId === PERMISSION_DIALOG_ID);
  if (nodes.length === 0) {
    return { state: "absent", availableDecisions: [], digest: snapshot.digest };
  }
  const packages = new Set(nodes.map((node) => node.packageName ?? ""));
  if (roots.length !== 1 || packages.size !== 1) {
    return { state: "unsupported", availableDecisions: [], digest: snapshot.digest };
  }
  const availableDecisions = (Object.entries(DECISION_IDS) as [PermissionDecision, string][])
    .filter(([, id]) => nodes.filter((node) => node.resourceId === id && node.enabled).length === 1)
    .map(([decision]) => decision);
  const messageNodes = nodes.filter((node) => node.resourceId === PERMISSION_MESSAGE_ID);
  const message = messageNodes[0]?.text;
  return {
    state: availableDecisions.length > 0 && messageNodes.length <= 1 ? "permission" : "unsupported",
    controllerPackage: nodes[0]?.packageName ?? "android.permissioncontroller",
    ...(messageNodes.length === 1 && message !== undefined && message !== "" ? { message } : {}),
    availableDecisions,
    digest: snapshot.digest,
  };
}

function uiTimeout(config: CommandConfig): number {
  return config.uiTimeoutMs ?? config.timeoutMs ?? DEFAULT_UI_SNAPSHOT_TIMEOUT_MS;
}

async function snapshot(
  ready: Ready,
  commandId: string,
  config: CommandConfig,
  dependencies: CommandDependencies,
  signal: AbortSignal | undefined,
  problems: Problem[],
): Promise<UiHierarchySnapshot | undefined> {
  const captured = await acquireUiSnapshot({
    client: ready.client,
    target: ready.target,
    targetIdentity: ready.selected.target.id,
    commandId,
    operation: "ui-system-observe",
    message: `Observing system UI on ${ready.target.serial}`,
    timeoutMs: uiTimeout(config),
    maxBufferBytes: 4 * 1024 * 1024,
    ...(signal === undefined ? {} : { signal }),
    ...(dependencies.uiHierarchyLock === undefined ? {} : { lock: dependencies.uiHierarchyLock }),
    profile: config.uiAcquisitionProfile ?? "balanced",
  });
  if (!captured.ok) {
    problems.push(captured.problem);
    return undefined;
  }
  return captured.snapshot;
}

async function keyboardObservation(
  ready: Ready,
  commandId: string,
  signal: AbortSignal | undefined,
  problems: Problem[],
): Promise<KeyboardObservation | undefined> {
  const [inputMethod, window] = await Promise.all([
    ready.client.targetCommand(
      ready.target,
      "keyboard-input-method-state",
      `Inspecting keyboard input state on ${ready.target.serial}`,
      ["shell", "dumpsys", "input_method"],
      (output) => output,
      signal,
      { maxBufferBytes: 2 * 1024 * 1024 },
    ),
    ready.client.targetCommand(
      ready.target,
      "keyboard-window-state",
      `Inspecting keyboard window state on ${ready.target.serial}`,
      ["shell", "dumpsys", "window"],
      (output) => output,
      signal,
      { maxBufferBytes: 4 * 1024 * 1024 },
    ),
  ]);
  if (!succeeded(inputMethod.process)) {
    problems.push(operationProblem("keyboard-input-method-state", inputMethod, commandId));
  }
  if (!succeeded(window.process)) {
    problems.push(operationProblem("keyboard-window-state", window, commandId));
  }
  if (problems.length > 0) return undefined;
  return parseKeyboardObservation(inputMethod.value, window.value);
}

function unsupportedKeyboardProblem(observation: KeyboardObservation, commandId: string): Problem {
  return problem(
    observation.state === "ambiguous"
      ? "UI_KEYBOARD_STATE_AMBIGUOUS"
      : "UI_KEYBOARD_STATE_UNSUPPORTED",
    "evidence.ui.keyboard",
    observation.state === "ambiguous"
      ? "Android reported conflicting keyboard visibility signals."
      : "This Android target does not expose both supported keyboard visibility signals.",
    "ADB Ready requires agreement between InputMethodManager and WindowInsets before changing keyboard state. Dismiss the keyboard in the app or use a target whose Android build exposes both dumpsys signals.",
    commandId,
  );
}

function plannedStep(ready: Ready, config: CommandConfig, args: string[]): OperationPlan {
  return {
    schemaVersion: SCHEMA_VERSION,
    dryRun: true,
    steps: [
      {
        id: "dismiss-keyboard",
        title: "Dismiss the currently visible software keyboard",
        executable: ready.adbPath,
        args: [
          ...(config.adbHost === undefined ? [] : ["-H", config.adbHost]),
          ...(config.adbPort === undefined ? [] : ["-P", String(config.adbPort)]),
          ...(ready.target.transportId === undefined
            ? ["-s", ready.target.serial]
            : ["-t", ready.target.transportId]),
          ...args,
        ],
        risk: "device-reversible",
      },
    ],
  };
}

async function runKeyboardAction(
  request: Extract<UiSystemActionRequest, { action: "keyboard" }>,
  config: CommandConfig,
  dependencies: CommandDependencies,
  signal?: AbortSignal,
): Promise<CommandExecution<UiSystemActionData>> {
  const current = context(`ui keyboard ${request.operation}`, dependencies);
  const problems: Problem[] = [];
  const ready = await readyTarget(current, config, dependencies, problems, signal);
  if (ready === undefined) return finish<UiSystemActionData>(current, null, problems);
  const before = await keyboardObservation(ready, current.commandId, signal, problems);
  if (before === undefined) return finish<UiSystemActionData>(current, null, problems);
  if (request.operation === "status") {
    if (before.state === "ambiguous" || before.state === "unsupported") {
      problems.push(unsupportedKeyboardProblem(before, current.commandId));
    }
    return finish(
      current,
      {
        action: "keyboard",
        operation: "status",
        selected: ready.selected,
        status: "observed",
        verified: before.state === "hidden" || before.state === "visible",
        keyboard: { before, changed: false },
      },
      problems,
    );
  }
  if (before.state === "ambiguous" || before.state === "unsupported") {
    problems.push(unsupportedKeyboardProblem(before, current.commandId));
    return finish<UiSystemActionData>(current, null, problems);
  }
  if (before.state === "hidden") {
    return finish(
      current,
      {
        action: "keyboard",
        operation: "dismiss",
        selected: ready.selected,
        status: "completed",
        verified: true,
        keyboard: { before, after: before, changed: false },
      },
      problems,
    );
  }
  if (request.dryRun === true || config.dryRun === true) {
    return finish(
      current,
      {
        action: "keyboard",
        operation: "dismiss",
        selected: ready.selected,
        status: "planned",
        verified: false,
        keyboard: { before, changed: false },
        plan: plannedStep(ready, config, ["shell", "input", "keyevent", "KEYCODE_BACK"]),
      },
      problems,
    );
  }
  const dismissed = await ready.client.targetCommand(
    ready.target,
    "keyboard-dismiss",
    `Dismissing the visible keyboard on ${ready.target.serial}`,
    ["shell", "input", "keyevent", "KEYCODE_BACK"],
    (output) => output,
    signal,
  );
  if (!succeeded(dismissed.process)) {
    problems.push(operationProblem("keyboard-dismiss", dismissed, current.commandId));
    return finish<UiSystemActionData>(current, null, problems);
  }
  await (
    dependencies.sleep ??
    (async (milliseconds) => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
      return true;
    })
  )(250, signal ?? new AbortController().signal);
  const after = await keyboardObservation(ready, current.commandId, signal, problems);
  if (after === undefined) return finish<UiSystemActionData>(current, null, problems);
  if (after.state !== "hidden") {
    problems.push(
      problem(
        "UI_KEYBOARD_DISMISS_NOT_VERIFIED",
        "evidence.ui.keyboard",
        "Android did not verify that the software keyboard was dismissed.",
        "The app may intercept Back or the keyboard may still be transitioning. Retry after the screen settles or dismiss it in the app.",
        current.commandId,
      ),
    );
  }
  return finish(
    current,
    {
      action: "keyboard",
      operation: "dismiss",
      selected: ready.selected,
      status: "completed",
      verified: after.state === "hidden",
      keyboard: { before, after, changed: before.state !== after.state },
    },
    problems,
  );
}

function permissionTarget(
  snapshot: UiHierarchySnapshot,
  decision: PermissionDecision,
): UiNode | undefined {
  const id = DECISION_IDS[decision];
  const matches = permissionNodes(snapshot).filter(
    (node) => node.resourceId === id && node.enabled && node.clickable && node.bounds !== undefined,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

async function runPermissionAction(
  request: Extract<UiSystemActionRequest, { action: "permission" }>,
  config: CommandConfig,
  dependencies: CommandDependencies,
  signal?: AbortSignal,
): Promise<CommandExecution<UiSystemActionData>> {
  const current = context(`ui permission ${request.operation}`, dependencies);
  const problems: Problem[] = [];
  const ready = await readyTarget(current, config, dependencies, problems, signal);
  if (ready === undefined) return finish<UiSystemActionData>(current, null, problems);
  const beforeSnapshot = await snapshot(
    ready,
    current.commandId,
    config,
    dependencies,
    signal,
    problems,
  );
  if (beforeSnapshot === undefined) return finish<UiSystemActionData>(current, null, problems);
  const before = observePermissionDialog(beforeSnapshot);
  if (request.operation === "inspect") {
    if (before.state === "unsupported") {
      problems.push(
        problem(
          "UI_PERMISSION_DIALOG_UNSUPPORTED",
          "evidence.ui.permission",
          "The visible PermissionController state is not an unambiguous runtime-permission dialog.",
          "Use a standard Android runtime-permission prompt. Notification, biometric, Settings, and OEM-specific dialogs are intentionally reported without automation.",
          current.commandId,
        ),
      );
    }
    return finish(
      current,
      {
        action: "permission",
        operation: "inspect",
        selected: ready.selected,
        status: "observed",
        verified: before.state !== "unsupported",
        permission: { before, changed: false },
      },
      problems,
    );
  }
  if (before.state !== "permission") {
    problems.push(
      problem(
        before.state === "absent"
          ? "UI_PERMISSION_DIALOG_ABSENT"
          : "UI_PERMISSION_DIALOG_UNSUPPORTED",
        "evidence.ui.permission",
        before.state === "absent"
          ? "No runtime-permission dialog is visible."
          : "The visible PermissionController state is not an unambiguous runtime-permission dialog.",
        "Open one standard Android runtime-permission prompt and retry. Notification, biometric, Settings, and OEM-specific dialogs are intentionally not automated.",
        current.commandId,
      ),
    );
    return finish<UiSystemActionData>(current, null, problems);
  }
  const target = permissionTarget(beforeSnapshot, request.decision);
  if (target === undefined || target.bounds === undefined) {
    problems.push(
      problem(
        "UI_PERMISSION_DECISION_UNAVAILABLE",
        "input.ui.permission",
        `The visible permission dialog does not expose one ${request.decision} action.`,
        `Choose one available decision: ${before.availableDecisions.join(", ") || "none"}.`,
        current.commandId,
      ),
    );
    return finish<UiSystemActionData>(current, null, problems);
  }
  const x = Math.floor((target.bounds.left + target.bounds.right) / 2);
  const y = Math.floor((target.bounds.top + target.bounds.bottom) / 2);
  if (request.dryRun === true || config.dryRun === true) {
    return finish(
      current,
      {
        action: "permission",
        operation: "respond",
        selected: ready.selected,
        status: "planned",
        verified: false,
        permission: { before, decision: request.decision, changed: false },
        plan: plannedStep(ready, config, ["shell", "input", "tap", String(x), String(y)]),
      },
      problems,
    );
  }
  const tapped = await ready.client.targetCommand(
    ready.target,
    "permission-dialog-response",
    `Responding to a verified permission dialog on ${ready.target.serial}`,
    ["shell", "input", "tap", String(x), String(y)],
    (output) => output,
    signal,
  );
  if (!succeeded(tapped.process)) {
    problems.push(operationProblem("permission-dialog-response", tapped, current.commandId));
    return finish<UiSystemActionData>(current, null, problems);
  }
  const afterSnapshot = await snapshot(
    ready,
    current.commandId,
    config,
    dependencies,
    signal,
    problems,
  );
  if (afterSnapshot === undefined) return finish<UiSystemActionData>(current, null, problems);
  const after = observePermissionDialog(afterSnapshot);
  const changed =
    after.digest !== before.digest &&
    (after.state === "absent" || before.message === undefined || after.message !== before.message);
  if (!changed) {
    problems.push(
      problem(
        "UI_PERMISSION_RESPONSE_NOT_VERIFIED",
        "evidence.ui.permission",
        "The permission dialog response could not be verified from a fresh UI observation.",
        "The dialog may have ignored the input or advanced to an indistinguishable state. Inspect the current dialog before retrying.",
        current.commandId,
      ),
    );
  }
  return finish(
    current,
    {
      action: "permission",
      operation: "respond",
      selected: ready.selected,
      status: "completed",
      verified: changed,
      permission: { before, after, decision: request.decision, changed },
    },
    problems,
  );
}

export async function runUiSystemAction(
  request: UiSystemActionRequest,
  config: CommandConfig = {},
  dependencies: CommandDependencies = {},
  signal?: AbortSignal,
): Promise<CommandExecution<UiSystemActionData>> {
  return request.action === "keyboard"
    ? await runKeyboardAction(request, config, dependencies, signal)
    : await runPermissionAction(request, config, dependencies, signal);
}
