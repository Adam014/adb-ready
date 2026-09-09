import type { AdbDevice } from "../adb/parsers.js";
import type { DevicesData, DoctorData } from "../app/commands.js";
import type { OutputFormat } from "../cli/arguments.js";
import type { EventBus } from "../core/event-bus.js";
import type { AdbReadyEvent, Problem, ResultEnvelope } from "../domain/contracts.js";
import type { AndroidTarget } from "../target/model.js";
import type { TextSink } from "./spinner.js";
import { sanitizeTerminalText, style, symbols } from "./style.js";
import type { TerminalCapabilities } from "./terminal.js";

export type CommandResult = ResultEnvelope<unknown>;

export interface ResultRenderOptions {
  format: OutputFormat;
  capabilities: TerminalCapabilities;
  sink: TextSink;
  verbose?: boolean;
}

function clean(value: unknown): string {
  return sanitizeTerminalText(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDoctorData(value: unknown): value is DoctorData {
  return (
    isRecord(value) &&
    isRecord(value.runtime) &&
    isRecord(value.adb) &&
    Array.isArray(value.devices)
  );
}

function hasDevices(value: unknown): value is DoctorData | DevicesData {
  return isRecord(value) && Array.isArray(value.devices);
}

function hasTargets(value: unknown): value is DoctorData | DevicesData {
  return isRecord(value) && Array.isArray(value.targets);
}

function deviceLabel(device: AdbDevice): string {
  const identity = device.model ?? device.product ?? device.device;
  return identity === undefined
    ? `${clean(device.serial)} · ${clean(device.state)}`
    : `${clean(identity)} · ${clean(device.serial)} · ${clean(device.state)}`;
}

function targetLabel(target: AndroidTarget): string {
  const transports = target.transports.map(({ kind }) => kind).join("+");
  const transportSummary = target.transports.length > 1 ? ` · ${transports}` : "";
  return `${clean(target.name)} · ${clean(target.serial)} · ${clean(target.state)}${clean(transportSummary)}`;
}

function problemLines(
  problem: Problem,
  capabilities: TerminalCapabilities,
  verbose: boolean,
): string[] {
  const glyphs = symbols(capabilities);
  const marker =
    problem.severity === "error"
      ? style.failure(glyphs.failure, capabilities)
      : style.warning(glyphs.warning, capabilities);
  const lines = [
    `${marker} ${style.strong(clean(problem.summary), capabilities)}`,
    `  ${clean(problem.detail)}`,
  ];
  const action = problem.actions[0];
  if (action !== undefined) {
    lines.push(`  ${style.accent("Next:", capabilities)} ${clean(action.title)}`);
  }
  if (verbose) {
    for (const evidence of problem.evidence) {
      const field =
        evidence.field === undefined ? evidence.source : `${evidence.source}.${evidence.field}`;
      lines.push(
        `  ${style.dim(`${clean(field)}: ${clean(JSON.stringify(evidence.value))}`, capabilities)}`,
      );
    }
  }
  return lines;
}

function renderHuman(result: CommandResult, options: ResultRenderOptions): void {
  const { capabilities, sink } = options;
  const glyphs = symbols(capabilities);
  const lines: string[] = [];
  lines.push(
    `${style.strong("ADB Ready", capabilities)} ${style.dim(`· ${clean(result.command)}`, capabilities)}`,
    "",
  );

  if (result.command === "doctor" && isDoctorData(result.data)) {
    const data = result.data;
    const runtime = `${data.runtime.name} ${data.runtime.version}`;
    const adbVersion = data.adb.version.platformToolsVersion ?? "unknown version";
    lines.push(
      `${style.success(glyphs.success, capabilities)} Runtime  ${clean(runtime)} · ${clean(data.runtime.platform)}/${clean(data.runtime.architecture)}`,
      `${style.success(glyphs.success, capabilities)} ADB      Platform-Tools ${clean(adbVersion)}`,
      `${style.success(glyphs.success, capabilities)} Path     ${clean(data.adb.path)}`,
      `${style.success(glyphs.success, capabilities)} Features ${String(data.adb.hostFeatures.length)} detected`,
      "",
    );
  }

  if (hasTargets(result.data)) {
    const targets = result.data.targets;
    lines.push(style.strong(`Targets (${String(targets.length)})`, capabilities));
    if (targets.length === 0) {
      lines.push(`${style.dim(glyphs.end, capabilities)} None visible`);
    } else {
      targets.forEach((target, index) => {
        const branch = index === targets.length - 1 ? glyphs.end : glyphs.branch;
        lines.push(`${style.dim(branch, capabilities)} ${targetLabel(target)}`);
      });
    }
    if ("selected" in result.data && result.data.selected !== undefined) {
      lines.push(
        `${style.accent(glyphs.active, capabilities)} Selected ${targetLabel(result.data.selected.target)}`,
      );
    }
  } else if (hasDevices(result.data)) {
    const devices = result.data.devices;
    lines.push(style.strong(`Targets (${String(devices.length)})`, capabilities));
    devices.forEach((device, index) => {
      const branch = index === devices.length - 1 ? glyphs.end : glyphs.branch;
      lines.push(`${style.dim(branch, capabilities)} ${deviceLabel(device)}`);
    });
  }

  if (result.problems.length > 0) {
    lines.push("", style.strong("Diagnostics", capabilities));
    for (const problem of result.problems) {
      lines.push(...problemLines(problem, capabilities, options.verbose ?? false));
    }
  }

  const status = result.ok
    ? `${style.success(glyphs.success, capabilities)} Completed in ${String(result.durationMs)}ms`
    : `${style.failure(glyphs.failure, capabilities)} Failed in ${String(result.durationMs)}ms`;
  lines.push("", status);
  sink.write(`${lines.join("\n")}\n`);
}

function renderPlain(result: CommandResult, sink: TextSink): void {
  sink.write(`command=${clean(result.command)}\n`);
  sink.write(`ok=${String(result.ok)}\n`);
  sink.write(`duration_ms=${String(result.durationMs)}\n`);
  if (isDoctorData(result.data)) {
    const data = result.data;
    sink.write(`runtime=${clean(data.runtime.name)}\n`);
    sink.write(`runtime_version=${clean(data.runtime.version)}\n`);
    sink.write(`adb_version=${clean(data.adb.version.platformToolsVersion ?? "unknown")}\n`);
  }
  if (hasTargets(result.data)) {
    sink.write(`target_count=${String(result.data.targets.length)}\n`);
    result.data.targets.forEach((target, index) => {
      sink.write(`target_${String(index)}=${targetLabel(target)}\n`);
    });
    if ("selected" in result.data && result.data.selected !== undefined) {
      sink.write(`selected=${targetLabel(result.data.selected.target)}\n`);
    }
  } else if (hasDevices(result.data)) {
    sink.write(`device_count=${String(result.data.devices.length)}\n`);
    result.data.devices.forEach((device, index) => {
      sink.write(`device_${String(index)}=${deviceLabel(device)}\n`);
    });
  }
  for (const problem of result.problems) {
    sink.write(`problem=${clean(problem.code)}:${clean(problem.summary)}\n`);
  }
}

export function renderResult(result: CommandResult, options: ResultRenderOptions): void {
  if (options.format === "json") {
    options.sink.write(`${JSON.stringify(result)}\n`);
  } else if (options.format === "ndjson") {
    options.sink.write(`${JSON.stringify({ kind: "result", ...result })}\n`);
  } else if (options.format === "plain") {
    renderPlain(result, options.sink);
  } else {
    renderHuman(result, options);
  }
}

export class NdjsonEventRenderer {
  readonly #unsubscribe: () => void;

  constructor(bus: EventBus, sink: TextSink) {
    this.#unsubscribe = bus.subscribe((event) => this.write(event, sink));
  }

  dispose(): void {
    this.#unsubscribe();
  }

  private write(event: AdbReadyEvent, sink: TextSink): void {
    sink.write(`${JSON.stringify({ kind: "event", ...event })}\n`);
  }
}
