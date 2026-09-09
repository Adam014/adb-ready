import type { AndroidTarget, TargetTransport } from "./model.js";

export type TargetSelectionReason =
  | "alias"
  | "explicit"
  | "only-ready"
  | "remembered"
  | "transport-id";

export interface SelectedTarget {
  target: AndroidTarget;
  transport: TargetTransport;
  reason: TargetSelectionReason;
}

export type TargetSelectionResult =
  | { kind: "selected"; selection: SelectedTarget }
  | { kind: "ambiguous"; candidates: AndroidTarget[] }
  | { kind: "not-found"; selector: string }
  | { kind: "unavailable"; target: AndroidTarget }
  | { kind: "none" };

export interface TargetSelectionOptions {
  selector?: string;
  transportId?: string;
  rememberedSerial?: string;
  aliases?: Readonly<Record<string, string>>;
}

function readyTransports(target: AndroidTarget): TargetTransport[] {
  return target.transports.filter(({ stable, state }) => stable && state === "device");
}

function selection(
  target: AndroidTarget,
  transport: TargetTransport,
  reason: TargetSelectionReason,
): TargetSelectionResult {
  return { kind: "selected", selection: { target, transport, reason } };
}

function findBySerial(
  targets: readonly AndroidTarget[],
  serial: string,
): { target: AndroidTarget; transport: TargetTransport } | undefined {
  for (const target of targets) {
    const transport = target.transports.find((candidate) => candidate.serial === serial);
    if (transport !== undefined) {
      return { target, transport };
    }
  }
  return undefined;
}

export function selectTarget(
  targets: readonly AndroidTarget[],
  options: TargetSelectionOptions = {},
): TargetSelectionResult {
  if (options.transportId !== undefined) {
    for (const target of targets) {
      const transport = target.transports.find(
        ({ transportId }) => transportId === options.transportId,
      );
      if (transport !== undefined) {
        return transport.state === "device" && transport.stable
          ? selection(target, transport, "transport-id")
          : { kind: "unavailable", target };
      }
    }
    return { kind: "not-found", selector: options.transportId };
  }

  if (options.selector !== undefined) {
    const resolved = options.aliases?.[options.selector] ?? options.selector;
    const reason: TargetSelectionReason =
      options.aliases?.[options.selector] === undefined ? "explicit" : "alias";
    const exactTarget = targets.find(({ id }) => id === resolved);
    if (exactTarget !== undefined) {
      const transport = readyTransports(exactTarget)[0];
      return transport === undefined
        ? { kind: "unavailable", target: exactTarget }
        : selection(exactTarget, transport, reason);
    }
    const match = findBySerial(targets, resolved);
    if (match === undefined) {
      return { kind: "not-found", selector: options.selector };
    }
    return match.transport.state === "device" && match.transport.stable
      ? selection(match.target, match.transport, reason)
      : { kind: "unavailable", target: match.target };
  }

  if (options.rememberedSerial !== undefined) {
    const remembered = findBySerial(targets, options.rememberedSerial);
    if (
      remembered !== undefined &&
      remembered.transport.state === "device" &&
      remembered.transport.stable
    ) {
      return selection(remembered.target, remembered.transport, "remembered");
    }
  }

  const ready = targets.filter((target) => readyTransports(target).length > 0);
  if (ready.length === 0) {
    return { kind: "none" };
  }
  if (ready.length > 1) {
    return { kind: "ambiguous", candidates: ready };
  }
  const target = ready[0];
  const transport = target === undefined ? undefined : readyTransports(target)[0];
  return target === undefined || transport === undefined
    ? { kind: "none" }
    : selection(target, transport, "only-ready");
}
