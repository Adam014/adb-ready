import { createHash } from "node:crypto";

export interface UiBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface UiNode {
  ref: string;
  depth: number;
  className?: string;
  resourceId?: string;
  text?: string;
  contentDescription?: string;
  packageName?: string;
  bounds?: UiBounds;
  clickable: boolean;
  checkable: boolean;
  enabled: boolean;
  focusable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  selected: boolean;
}

export interface UiHierarchySnapshot {
  digest: string;
  sensitive: true;
  complete: boolean;
  totalNodes: number;
  returnedNodes: number;
  truncated: boolean;
  nodes: UiNode[];
}

function decodeXml(value: string): string {
  return value.replaceAll(
    /&(?:#(\d+)|#x([\da-f]+)|amp|apos|gt|lt|quot);/giu,
    (entity, decimal, hex) => {
      if (decimal !== undefined || hex !== undefined) {
        const codePoint = decimal === undefined ? Number.parseInt(hex, 16) : Number(decimal);
        return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : "�";
      }
      if (entity === "&amp;") return "&";
      if (entity === "&apos;") return "'";
      if (entity === "&gt;") return ">";
      if (entity === "&lt;") return "<";
      return '"';
    },
  );
}

function attributes(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of raw.matchAll(/([\w:-]+)="([^"]*)"/gu)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) result[key] = decodeXml(value);
  }
  return result;
}

function boolean(value: string | undefined, fallback = false): boolean {
  return value === undefined ? fallback : value === "true";
}

function bounds(value: string | undefined): UiBounds | undefined {
  const match = value?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/u);
  if (match === undefined || match === null) return undefined;
  const values = match.slice(1).map(Number);
  if (values.some((item) => !Number.isSafeInteger(item))) return undefined;
  return {
    left: values[0] ?? 0,
    top: values[1] ?? 0,
    right: values[2] ?? 0,
    bottom: values[3] ?? 0,
  };
}

function interactive(node: Omit<UiNode, "ref">): boolean {
  return (
    node.enabled &&
    (node.clickable || node.checkable || node.focusable || node.longClickable || node.scrollable)
  );
}

export function parseUiHierarchy(
  output: string,
  options: { interactiveOnly?: boolean; maxDepth?: number; maxNodes?: number } = {},
): UiHierarchySnapshot | undefined {
  const start = output.indexOf("<?xml");
  const hierarchyStart = output.indexOf("<hierarchy");
  const xmlStart = start === -1 ? hierarchyStart : start;
  const xmlEnd = output.lastIndexOf("</hierarchy>");
  if (xmlStart === -1 || xmlEnd === -1 || xmlEnd < xmlStart) return undefined;
  const xml = output.slice(xmlStart, xmlEnd + "</hierarchy>".length);
  const maxDepth = options.maxDepth ?? 25;
  const maxNodes = options.maxNodes ?? 2_000;
  const canonical: Array<Omit<UiNode, "ref">> = [];
  const digestHash = createHash("sha256");
  let depth = 0;
  let totalNodes = 0;
  let truncated = false;
  for (const token of xml.matchAll(/<node\b([^>]*)\/?\s*>|<\/node\s*>/gu)) {
    const raw = token[0];
    if (raw.startsWith("</")) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const selfClosing = /\/\s*>$/u.test(raw);
    const currentDepth = depth;
    totalNodes += 1;
    const values = attributes(token[1] ?? "");
    const parsedBounds = bounds(values.bounds);
    const node: Omit<UiNode, "ref"> = {
      depth: currentDepth,
      ...(values.class === undefined || values.class === "" ? {} : { className: values.class }),
      ...(values["resource-id"] === undefined || values["resource-id"] === ""
        ? {}
        : { resourceId: values["resource-id"] }),
      ...(values.text === undefined || values.text === "" ? {} : { text: values.text }),
      ...(values["content-desc"] === undefined || values["content-desc"] === ""
        ? {}
        : { contentDescription: values["content-desc"] }),
      ...(values.package === undefined || values.package === ""
        ? {}
        : { packageName: values.package }),
      ...(parsedBounds === undefined ? {} : { bounds: parsedBounds }),
      clickable: boolean(values.clickable),
      checkable: boolean(values.checkable),
      enabled: boolean(values.enabled, true),
      focusable: boolean(values.focusable),
      longClickable: boolean(values["long-clickable"]),
      scrollable: boolean(values.scrollable),
      selected: boolean(values.selected),
    };
    digestHash.update(JSON.stringify(node));
    if (canonical.length >= maxNodes) truncated = true;
    else canonical.push(node);
    if (currentDepth > maxDepth) truncated = true;
    if (!selfClosing) depth += 1;
  }
  const digest = digestHash.digest("hex");
  const prefix = digest.slice(0, 12);
  const nodes = canonical
    .map((node, index) => ({
      ref: `ui:${prefix}:${String(index + 1)}`,
      ...node,
    }))
    .filter(
      (node) => node.depth <= maxDepth && (options.interactiveOnly !== true || interactive(node)),
    );
  return {
    digest,
    sensitive: true,
    complete: !truncated,
    totalNodes,
    returnedNodes: nodes.length,
    truncated,
    nodes,
  };
}
