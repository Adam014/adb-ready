import type { UiBounds, UiHierarchySnapshot, UiNode } from "./ui-hierarchy.js";

const MAX_RETURNED_CHANGES = 100;

export type UiSnapshotCompatibilityCode =
  | "UI_DIFF_ACQUISITION_MISMATCH"
  | "UI_DIFF_DISPLAY_MISMATCH"
  | "UI_DIFF_FILTER_MISMATCH"
  | "UI_DIFF_INCOMPLETE_SNAPSHOT";

export interface CompactUiNode {
  ref: string;
  className?: string;
  resourceId?: string;
  text?: string;
  hintText?: string;
  contentDescription?: string;
  bounds?: UiBounds;
  enabled: boolean;
  checked: boolean;
  focused: boolean;
  selected: boolean;
}

export interface UiNodeChange {
  before: CompactUiNode;
  after: CompactUiNode;
  fields: string[];
}

export interface UiNodeMove {
  beforeRef: string;
  afterRef: string;
  selector: Pick<CompactUiNode, "className" | "contentDescription" | "resourceId" | "text">;
  from: { depth: number; bounds?: UiBounds };
  to: { depth: number; bounds?: UiBounds };
}

export interface UiHierarchyDiff {
  sensitive: true;
  baseDigest: string;
  currentDigest: string;
  changed: boolean;
  digestChanged: boolean;
  totalChanges: number;
  returnedChanges: number;
  truncated: boolean;
  display: { left: number; top: number; right: number; bottom: number } | null;
  added: CompactUiNode[];
  removed: CompactUiNode[];
  updated: UiNodeChange[];
  moved: UiNodeMove[];
}

export type UiHierarchyDiffResult =
  | { ok: true; diff: UiHierarchyDiff }
  | { ok: false; code: UiSnapshotCompatibilityCode; message: string };

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compact(node: UiNode): CompactUiNode {
  return {
    ref: node.ref,
    ...(node.className === undefined ? {} : { className: node.className }),
    ...(node.resourceId === undefined ? {} : { resourceId: node.resourceId }),
    ...(node.text === undefined ? {} : { text: node.text }),
    ...(node.hintText === undefined ? {} : { hintText: node.hintText }),
    ...(node.contentDescription === undefined
      ? {}
      : { contentDescription: node.contentDescription }),
    ...(node.bounds === undefined ? {} : { bounds: node.bounds }),
    enabled: node.enabled,
    checked: node.checked,
    focused: node.focused,
    selected: node.selected,
  };
}

function occurrenceKeys(nodes: readonly UiNode[]): string[] {
  const occurrences = new Map<string, number>();
  const siblingIndexes: number[] = [];
  return nodes.map((node) => {
    siblingIndexes.length = node.depth + 1;
    siblingIndexes[node.depth] = (siblingIndexes[node.depth] ?? -1) + 1;
    const path = siblingIndexes.slice(0, node.depth + 1).join(".");
    const semantic =
      node.resourceId === undefined
        ? node.contentDescription === undefined
          ? node.hintText === undefined
            ? undefined
            : `hint:${node.className ?? ""}:${node.hintText}`
          : `desc:${node.className ?? ""}:${node.contentDescription}`
        : `id:${node.resourceId}`;
    if (semantic === undefined) return `path:${path}:${node.className ?? ""}`;
    const occurrence = (occurrences.get(semantic) ?? 0) + 1;
    occurrences.set(semantic, occurrence);
    return `${semantic}#${String(occurrence)}`;
  });
}

function changedFields(before: UiNode, after: UiNode): string[] {
  const fields: Array<keyof UiNode> = [
    "className",
    "resourceId",
    "text",
    "hintText",
    "contentDescription",
    "packageName",
    "clickable",
    "checkable",
    "checked",
    "enabled",
    "focusable",
    "focused",
    "longClickable",
    "password",
    "scrollable",
    "selected",
  ];
  return fields.filter((field) => !same(before[field], after[field]));
}

function take<T>(values: readonly T[], remaining: { value: number }): T[] {
  const result = values.slice(0, Math.max(0, remaining.value));
  remaining.value -= result.length;
  return result;
}

export function diffUiHierarchies(
  base: UiHierarchySnapshot,
  current: UiHierarchySnapshot,
): UiHierarchyDiffResult {
  if (!base.complete || !current.complete || base.truncated || current.truncated) {
    return {
      ok: false,
      code: "UI_DIFF_INCOMPLETE_SNAPSHOT",
      message: "UI diff requires two complete, untruncated hierarchy snapshots.",
    };
  }
  if (!same(base.filtering, current.filtering)) {
    return {
      ok: false,
      code: "UI_DIFF_FILTER_MISMATCH",
      message: "UI snapshots were captured with different hierarchy filters.",
    };
  }
  const baseAcquisition = base.acquisition;
  const currentAcquisition = current.acquisition;
  if (
    baseAcquisition?.profile !== currentAcquisition?.profile ||
    baseAcquisition?.source !== currentAcquisition?.source ||
    baseAcquisition?.idleStrategy !== currentAcquisition?.idleStrategy
  ) {
    return {
      ok: false,
      code: "UI_DIFF_ACQUISITION_MISMATCH",
      message: "UI snapshots were captured with different acquisition contracts.",
    };
  }
  const baseDisplay = base.display;
  const currentDisplay = current.display;
  if (!same(baseDisplay, currentDisplay)) {
    return {
      ok: false,
      code: "UI_DIFF_DISPLAY_MISMATCH",
      message: "UI snapshots describe different display bounds.",
    };
  }

  const baseEntries = new Map(
    occurrenceKeys(base.nodes).map((key, index) => [key, base.nodes[index] as UiNode]),
  );
  const currentEntries = new Map(
    occurrenceKeys(current.nodes).map((key, index) => [key, current.nodes[index] as UiNode]),
  );
  const added: CompactUiNode[] = [];
  const removed: CompactUiNode[] = [];
  const updated: UiNodeChange[] = [];
  const moved: UiNodeMove[] = [];

  for (const [key, node] of baseEntries) {
    const next = currentEntries.get(key);
    if (next === undefined) {
      removed.push(compact(node));
      continue;
    }
    const fields = changedFields(node, next);
    if (fields.length > 0) updated.push({ before: compact(node), after: compact(next), fields });
    if (node.depth !== next.depth || !same(node.bounds, next.bounds)) {
      moved.push({
        beforeRef: node.ref,
        afterRef: next.ref,
        selector: {
          ...(next.className === undefined ? {} : { className: next.className }),
          ...(next.resourceId === undefined ? {} : { resourceId: next.resourceId }),
          ...(next.text === undefined ? {} : { text: next.text }),
          ...(next.contentDescription === undefined
            ? {}
            : { contentDescription: next.contentDescription }),
        },
        from: { depth: node.depth, ...(node.bounds === undefined ? {} : { bounds: node.bounds }) },
        to: { depth: next.depth, ...(next.bounds === undefined ? {} : { bounds: next.bounds }) },
      });
    }
  }
  for (const [key, node] of currentEntries) {
    if (!baseEntries.has(key)) added.push(compact(node));
  }

  const totalChanges = added.length + removed.length + updated.length + moved.length;
  const remaining = { value: MAX_RETURNED_CHANGES };
  const boundedAdded = take(added, remaining);
  const boundedRemoved = take(removed, remaining);
  const boundedUpdated = take(updated, remaining);
  const boundedMoved = take(moved, remaining);
  const returnedChanges = MAX_RETURNED_CHANGES - remaining.value;
  return {
    ok: true,
    diff: {
      sensitive: true,
      baseDigest: base.digest,
      currentDigest: current.digest,
      changed: totalChanges > 0,
      digestChanged: base.digest !== current.digest,
      totalChanges,
      returnedChanges,
      truncated: returnedChanges < totalChanges,
      display: currentDisplay.bounds,
      added: boundedAdded,
      removed: boundedRemoved,
      updated: boundedUpdated,
      moved: boundedMoved,
    },
  };
}
