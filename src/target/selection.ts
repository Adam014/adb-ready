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
  | { kind: "duplicate"; target: AndroidTarget; transports: TargetTransport[] }
  | { kind: "none" };

export interface TargetSelectionOptions {
  selector?: string;
  transportId?: string;
  rememberedSerial?: string;
  aliases?: Readonly<Record<string, string>>;
  rememberedOnly?: boolean;
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
): { target: AndroidTarget; transports: TargetTransport[] } | undefined {
  for (const target of targets) {
    const transports = target.transports.filter((candidate) => candidate.serial === serial);
    if (transports.length > 0) {
      return { target, transports };
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
      const transports = readyTransports(exactTarget);
      const transport = transports[0];
      if (transports.length > 1 && new Set(transports.map(({ serial }) => serial)).size === 1) {
        return { kind: "duplicate", target: exactTarget, transports };
      }
      return transport === undefined
        ? { kind: "unavailable", target: exactTarget }
        : selection(exactTarget, transport, reason);
    }
    const match = findBySerial(targets, resolved);
    if (match === undefined) {
      return { kind: "not-found", selector: options.selector };
    }
    const readyMatches = match.transports.filter(
      ({ stable, state }) => stable && state === "device",
    );
    if (readyMatches.length > 1) {
      return { kind: "duplicate", target: match.target, transports: readyMatches };
    }
    const transport = match.transports[0];
    return transport !== undefined && transport.state === "device" && transport.stable
      ? selection(match.target, transport, reason)
      : { kind: "unavailable", target: match.target };
  }

  if (options.rememberedSerial !== undefined) {
    const remembered = findBySerial(targets, options.rememberedSerial);
    if (remembered !== undefined && remembered.transports.length > 1) {
      return { kind: "duplicate", target: remembered.target, transports: remembered.transports };
    }
    const transport = remembered?.transports[0];
    if (
      remembered !== undefined &&
      transport !== undefined &&
      transport.state === "device" &&
      transport.stable
    ) {
      return selection(remembered.target, transport, "remembered");
    }
    if (options.rememberedOnly) {
      return remembered === undefined
        ? { kind: "not-found", selector: "remembered target" }
        : { kind: "unavailable", target: remembered.target };
    }
  } else if (options.rememberedOnly) {
    return { kind: "not-found", selector: "remembered target" };
  }

  const ready = targets.filter((target) => readyTransports(target).length > 0);
  if (ready.length === 0) {
    return { kind: "none" };
  }
  if (ready.length > 1) {
    return { kind: "ambiguous", candidates: ready };
  }
  const target = ready[0];
  const transports = target === undefined ? [] : readyTransports(target);
  const transport = transports[0];
  if (
    target !== undefined &&
    transports.length > 1 &&
    new Set(transports.map(({ serial }) => serial)).size === 1
  ) {
    return { kind: "duplicate", target, transports };
  }
  return target === undefined || transport === undefined
    ? { kind: "none" }
    : selection(target, transport, "only-ready");
}
