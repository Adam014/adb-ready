import type { AdbDevice, AdbMdnsService } from "../adb/parsers.js";
import type { AgentSetupData } from "../agent/setup.js";
import type { AppData, AppsData, OpenData } from "../app/app-commands.js";
import type {
  ConnectedData,
  DevData,
  DevicesData,
  DoctorData,
  LogsData,
  PairedData,
  PortsData,
  TargetDiscoveryData,
} from "../app/commands.js";
import type { ConfigReportData, InitData } from "../app/config-commands.js";
import type {
  ContextCommandData,
  ProblemsCommandData,
  SessionCommandData,
} from "../app/session-commands.js";
import type { OutputFormat } from "../cli/arguments.js";
import type { EventBus } from "../core/event-bus.js";
import type { AdbReadyEvent, OperationPlan, Problem, ResultEnvelope } from "../domain/contracts.js";
import { ProblemCode } from "../domain/problems.js";
import type { CaptureData } from "../evidence/capture.js";
import type { InspectAppData, InspectUiData } from "../evidence/inspect.js";
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

function hasDiscovery(value: unknown): value is { discovery: TargetDiscoveryData } {
  return isRecord(value) && isRecord(value.discovery) && isRecord(value.discovery.mdns);
}

function isConnectData(value: unknown): value is ConnectedData {
  return isRecord(value) && value.state === "device" && typeof value.serial === "string";
}

function isPairData(value: unknown): value is PairedData {
  return isRecord(value) && value.paired === true && typeof value.endpoint === "string";
}

function isPortsData(value: unknown): value is PortsData {
  return (
    isRecord(value) &&
    (value.direction === "forward" || value.direction === "reverse") &&
    Array.isArray(value.mappings) &&
    isRecord(value.selected)
  );
}

function isDevData(value: unknown): value is DevData {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    isRecord(value.selected) &&
    isRecord(value.project) &&
    isRecord(value.command) &&
    isRecord(value.ports) &&
    isRecord(value.journal)
  );
}

function isLogsData(value: unknown): value is LogsData {
  return (
    isRecord(value) &&
    isRecord(value.selected) &&
    Array.isArray(value.filters) &&
    Array.isArray(value.records) &&
    typeof value.dropped === "number"
  );
}

function isAppsData(value: unknown): value is AppsData {
  return (
    isRecord(value) &&
    isRecord(value.selected) &&
    (value.scope === "all" || value.scope === "system" || value.scope === "user") &&
    Array.isArray(value.packages)
  );
}

function isAppData(value: unknown): value is AppData {
  return (
    isRecord(value) &&
    isRecord(value.selected) &&
    typeof value.action === "string" &&
    (isRecord(value.resolution) || typeof value.applicationId === "string")
  );
}

function isOpenData(value: unknown): value is OpenData {
  return (
    isRecord(value) &&
    isRecord(value.selected) &&
    typeof value.url === "string" &&
    typeof value.verified === "boolean"
  );
}

function isCaptureData(value: unknown): value is CaptureData {
  return (
    isRecord(value) &&
    isRecord(value.selected) &&
    isRecord(value.evidence) &&
    (value.kind === "screenshot" || value.kind === "screen-record")
  );
}

function isInspectAppData(value: unknown): value is InspectAppData {
  return isRecord(value) && value.kind === "app" && isRecord(value.selected) && isRecord(value.app);
}

function isInspectUiData(value: unknown): value is InspectUiData {
  return (
    isRecord(value) && value.kind === "ui" && isRecord(value.selected) && isRecord(value.snapshot)
  );
}

function isSessionCommandData(value: unknown): value is SessionCommandData {
  if (!isRecord(value)) return false;
  if (value.action === "list") return Array.isArray(value.sessions);
  if (value.action === "show") return isRecord(value.session);
  return value.action === "events" && isRecord(value.session) && Array.isArray(value.events);
}

function isProblemsCommandData(value: unknown): value is ProblemsCommandData {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    typeof value.status === "string" &&
    Array.isArray(value.problems)
  );
}

function isContextCommandData(value: unknown): value is ContextCommandData {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    typeof value.markdown === "string" &&
    typeof value.characterCount === "number" &&
    typeof value.includedEvents === "number"
  );
}

function isInitData(value: unknown): value is InitData {
  return (
    isRecord(value) &&
    (value.status === "created" || value.status === "planned" || value.status === "replaced") &&
    typeof value.path === "string" &&
    isRecord(value.document)
  );
}

function isConfigReportData(value: unknown): value is ConfigReportData {
  return (
    isRecord(value) &&
    (value.action === "validate" || value.action === "explain") &&
    value.valid === true &&
    isRecord(value.files)
  );
}

function isAgentSetupData(value: unknown): value is AgentSetupData {
  return (
    isRecord(value) &&
    typeof value.client === "string" &&
    typeof value.status === "string" &&
    typeof value.path === "string" &&
    typeof value.content === "string" &&
    typeof value.next === "string"
  );
}

function hasPlan(value: unknown): value is { plan: OperationPlan } {
  return isRecord(value) && isRecord(value.plan) && Array.isArray(value.plan.steps);
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

function wirelessServiceLabel(service: AdbMdnsService): string {
  const identity = service.givenName ?? service.deviceModel ?? service.instance;
  const pairingState =
    service.serviceType !== "connect" || service.knownDevice === undefined
      ? ""
      : service.knownDevice
        ? " · paired"
        : " · pair first";
  return `${clean(identity)} · ${clean(service.endpoint.serial)} · ${clean(service.serviceType)}${pairingState}`;
}

function problemLines(
  problem: Problem,
  capabilities: TerminalCapabilities,
  verbose: boolean,
): string[] {
  const glyphs = symbols(capabilities);
  const marker =
    problem.severity === "error" && problem.code !== ProblemCode.OperationInterrupted
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

  if (result.command === "connect" && isConnectData(result.data)) {
    lines.push(
      `${style.success(glyphs.success, capabilities)} Connected ${clean(result.data.endpoint)}`,
      `${style.success(glyphs.success, capabilities)} Verified  ${clean(result.data.serial)} · device`,
    );
    if (result.data.hardwareSerial !== undefined) {
      lines.push(
        `${style.success(glyphs.success, capabilities)} Identity  ${clean(result.data.hardwareSerial)}`,
      );
    }
  }

  if (result.command === "dev" && isDevData(result.data)) {
    const data = result.data;
    const sessionMarker =
      data.status === "interrupted"
        ? style.warning(glyphs.warning, capabilities)
        : data.status === "failed"
          ? style.failure(glyphs.failure, capabilities)
          : style.success(glyphs.success, capabilities);
    lines.push(
      `${style.success(glyphs.success, capabilities)} Target   ${clean(data.selected.target.name)} · ${clean(data.selected.transport.serial)}`,
      `${style.success(glyphs.success, capabilities)} Project  ${clean(data.project.name ?? data.project.root)} · ${clean(data.preset)}`,
      `${style.success(glyphs.success, capabilities)} Ports    ${String(data.ports.requested.length)} ready · ${String(data.ports.created.length)} created · ${String(data.ports.reused.length)} reused`,
      `${style.success(glyphs.success, capabilities)} Command  ${clean(data.command.executable)} ${data.command.args.map(clean).join(" ")}`,
    );
    if (data.child !== undefined) {
      const childMarker =
        data.status === "interrupted"
          ? style.warning(glyphs.warning, capabilities)
          : data.child.exitCode === 0
            ? style.success(glyphs.success, capabilities)
            : style.failure(glyphs.failure, capabilities);
      lines.push(
        `${childMarker} Child    ${data.child.exitCode === null ? clean(data.child.signal) : `exit ${String(data.child.exitCode)}`}`,
      );
    }
    lines.push(
      `${style.success(glyphs.success, capabilities)} Journal  ${String(data.journal.events.length)} events${data.journal.dropped === 0 ? "" : ` · ${String(data.journal.dropped)} dropped`}`,
      `${data.recovery.failed ? style.failure(glyphs.failure, capabilities) : style.success(glyphs.success, capabilities)} Recovery ${data.recovery.failed ? "failed" : data.recovery.recoveries === 0 ? "healthy" : `${String(data.recovery.recoveries)} verified repair(s)`}`,
      `${sessionMarker} Session  ${clean(data.sessionId)} · ${clean(data.status)}`,
    );
  }

  if (result.command === "logs" && isLogsData(result.data)) {
    const data = result.data;
    lines.push(
      `${style.success(glyphs.success, capabilities)} Target   ${clean(data.selected.target.name)} · ${clean(data.selected.transport.serial)}`,
      `${style.success(glyphs.success, capabilities)} Filter   ${data.filters.map(clean).join(" ")}${data.packageName === undefined ? "" : ` · ${clean(data.packageName)}`}${data.uid === undefined ? "" : ` · UID ${String(data.uid)}`}${data.pid === undefined ? "" : ` · PID ${String(data.pid)}`}`,
      `${style.success(glyphs.success, capabilities)} Buffers  ${data.buffers.length === 0 ? "device default" : data.buffers.map(clean).join(", ")}`,
      `${style.success(glyphs.success, capabilities)} Records  ${String(data.records.length)} retained${data.dropped === 0 ? "" : ` · ${String(data.dropped)} dropped`}`,
    );
    if (data.findings.length > 0) {
      lines.push("", style.strong(`Findings (${String(data.findings.length)})`, capabilities));
      data.findings.forEach((finding, index) => {
        const branch = index === data.findings.length - 1 ? glyphs.end : glyphs.branch;
        lines.push(
          `${style.dim(branch, capabilities)} ${style.failure(clean(finding.code), capabilities)} · ${clean(finding.summary)}`,
        );
      });
    }
  }

  if (result.command === "apps list" && isAppsData(result.data)) {
    const data = result.data;
    const visible = data.packages.slice(0, 50);
    const filter = data.filter === undefined ? "" : ` · filter ${clean(data.filter)}`;
    lines.push(
      `${style.success(glyphs.success, capabilities)} Target    ${clean(data.selected.target.name)} · ${clean(data.selected.transport.serial)}`,
      `${style.success(glyphs.success, capabilities)} Packages  ${String(data.packages.length)} · ${clean(data.scope)}${filter}`,
    );
    visible.forEach((item, index) => {
      const branch = index === visible.length - 1 ? glyphs.end : glyphs.branch;
      lines.push(`${style.dim(branch, capabilities)} ${clean(item.name)}`);
    });
    if (data.packages.length > visible.length) {
      lines.push(
        style.dim(
          `  ${String(data.packages.length - visible.length)} more; use --filter or --json`,
          capabilities,
        ),
      );
    }
  }

  if (result.command.startsWith("app ") && isAppData(result.data)) {
    const data = result.data;
    lines.push(
      `${style.success(glyphs.success, capabilities)} Target   ${clean(data.selected.target.name)} · ${clean(data.selected.transport.serial)}`,
    );
    if (data.action === "resolve") {
      if (data.resolution.kind === "resolved") {
        lines.push(
          `${style.success(glyphs.success, capabilities)} App      ${clean(data.resolution.applicationId)}`,
          `${style.success(glyphs.success, capabilities)} Source   ${clean(data.resolution.provenance.source)}${data.resolution.provenance.location === undefined ? "" : ` · ${clean(data.resolution.provenance.location)}`}`,
        );
      }
    } else if (data.action === "info") {
      lines.push(
        `${style.success(glyphs.success, capabilities)} App      ${clean(data.package.applicationId)}`,
        `${data.package.installed ? style.success(glyphs.success, capabilities) : style.failure(glyphs.failure, capabilities)} Install  ${data.package.installed ? "installed" : "not installed"}${data.package.versionName === undefined ? "" : ` · ${clean(data.package.versionName)}`}`,
        `${style.success(glyphs.success, capabilities)} Debug    ${data.package.debuggable === true ? "debuggable" : data.package.debuggable === false ? "not debuggable" : "unknown"}`,
      );
      if (data.foreground !== undefined) {
        lines.push(
          `${style.success(glyphs.success, capabilities)} Foreground ${clean(data.foreground.applicationId)}/${clean(data.foreground.activity)}`,
        );
      }
    } else {
      const planned = data.status === "planned";
      const marker = planned
        ? style.accent(glyphs.active, capabilities)
        : data.verified
          ? style.success(glyphs.success, capabilities)
          : style.failure(glyphs.failure, capabilities);
      lines.push(
        `${marker} App      ${clean(data.applicationId)}`,
        `${marker} Status   ${clean(data.status)} · ${planned ? "no changes made" : data.verified ? "verified" : "not verified"}`,
      );
      if (data.activity !== undefined) {
        lines.push(
          `${style.success(glyphs.success, capabilities)} Activity ${clean(data.activity)}`,
        );
      }
    }
  }

  if (result.command === "open" && isOpenData(result.data)) {
    const planned = result.data.status === "planned";
    const marker = planned
      ? style.accent(glyphs.active, capabilities)
      : result.data.verified
        ? style.success(glyphs.success, capabilities)
        : style.failure(glyphs.failure, capabilities);
    lines.push(
      `${style.success(glyphs.success, capabilities)} Target  ${clean(result.data.selected.target.name)} · ${clean(result.data.selected.transport.serial)}`,
      `${marker} URL     ${clean(result.data.url)}`,
      `${marker} Status  ${planned ? "planned · no changes made" : result.data.verified ? "opened · verified" : "not verified"}`,
    );
  }

  if (result.command.startsWith("capture ") && isCaptureData(result.data)) {
    lines.push(
      `${style.success(glyphs.success, capabilities)} Target  ${clean(result.data.selected.target.name)} · ${clean(result.data.selected.transport.serial)}`,
      `${style.success(glyphs.success, capabilities)} File    ${clean(result.data.evidence.path)}`,
      `${style.success(glyphs.success, capabilities)} Type    ${clean(result.data.evidence.mediaType)} · ${String(result.data.evidence.bytes)} bytes`,
      `${style.success(glyphs.success, capabilities)} SHA-256 ${clean(result.data.evidence.sha256)}`,
    );
  }

  if (result.command === "inspect app" && isInspectAppData(result.data)) {
    const data = result.data;
    lines.push(
      `${style.success(glyphs.success, capabilities)} Target     ${clean(data.selected.target.name)} · ${clean(data.selected.transport.serial)}`,
      `${style.success(glyphs.success, capabilities)} App        ${clean(data.app.package.applicationId)}${data.app.package.versionName === undefined ? "" : ` · ${clean(data.app.package.versionName)}`}`,
      `${style.success(glyphs.success, capabilities)} Foreground ${data.app.foreground === undefined ? "not observed" : `${clean(data.app.foreground.applicationId)}/${clean(data.app.foreground.activity)}`}`,
      `${data.logs.available ? style.success(glyphs.success, capabilities) : style.warning(glyphs.warning, capabilities)} Logs       ${data.logs.available ? `${String(data.logs.records.length)} records · ${String(data.logs.findings.length)} findings` : clean(data.logs.reason)}`,
      `${style.warning(glyphs.warning, capabilities)} Screenshot explicit capture required · adb-ready capture screenshot`,
      `${style.warning(glyphs.warning, capabilities)} Privacy    sensitive device evidence`,
    );
  }

  if (result.command === "inspect ui" && isInspectUiData(result.data)) {
    const data = result.data;
    lines.push(
      `${style.success(glyphs.success, capabilities)} Target    ${clean(data.selected.target.name)} · ${clean(data.selected.transport.serial)}`,
      `${style.success(glyphs.success, capabilities)} Snapshot  ${clean(data.snapshot.digest)}`,
      `${data.snapshot.complete ? style.success(glyphs.success, capabilities) : style.warning(glyphs.warning, capabilities)} Nodes     ${String(data.snapshot.returnedNodes)} returned · ${String(data.snapshot.totalNodes)} observed${data.snapshot.truncated ? " · truncated" : ""}`,
      `${style.warning(glyphs.warning, capabilities)} Privacy   UI text and hierarchy are sensitive`,
    );
    data.snapshot.nodes.slice(0, 20).forEach((node, index) => {
      const branch =
        index === Math.min(data.snapshot.nodes.length, 20) - 1 ? glyphs.end : glyphs.branch;
      const label =
        node.resourceId ?? node.contentDescription ?? node.text ?? node.className ?? "node";
      lines.push(`${style.dim(branch, capabilities)} ${clean(node.ref)} · ${clean(label)}`);
    });
  }

  if (result.command.startsWith("sessions ") && isSessionCommandData(result.data)) {
    const data = result.data;
    if (data.action === "list") {
      lines.push(style.strong(`Sessions (${String(data.sessions.length)})`, capabilities));
      if (data.sessions.length === 0) {
        lines.push(`${style.dim(glyphs.end, capabilities)} No saved sessions`);
      }
      data.sessions.forEach((session, index) => {
        const branch = index === data.sessions.length - 1 ? glyphs.end : glyphs.branch;
        const context = [session.preset, session.projectFingerprint].filter(Boolean).join(" · ");
        lines.push(
          `${style.dim(branch, capabilities)} ${clean(session.sessionId)} · ${clean(session.status)} · ${clean(session.updatedAt)}${context === "" ? "" : ` · ${clean(context)}`}`,
        );
      });
    } else {
      const session = data.session;
      lines.push(
        `${style.success(glyphs.success, capabilities)} Session  ${clean(session.sessionId)}`,
        `${style.success(glyphs.success, capabilities)} Status   ${clean(session.status)}`,
        `${style.success(glyphs.success, capabilities)} Started  ${clean(session.startedAt)}`,
        `${style.success(glyphs.success, capabilities)} Events   ${String(session.eventCount)} · ${String(session.eventBytes)} bytes`,
      );
      if (data.action === "events") {
        lines.push("", style.strong(`Timeline (${String(data.events.length)})`, capabilities));
        data.events.forEach((event, index) => {
          const branch = index === data.events.length - 1 ? glyphs.end : glyphs.branch;
          lines.push(
            `${style.dim(branch, capabilities)} ${clean(event.timestamp)} · ${clean(event.severity)} · ${clean(event.type)} · ${clean(event.message)}`,
          );
        });
      }
    }
  }

  if (result.command === "problems" && isProblemsCommandData(result.data)) {
    const data = result.data;
    lines.push(
      `${style.success(glyphs.success, capabilities)} Session  ${clean(data.sessionId)}`,
      `${style.success(glyphs.success, capabilities)} Status   ${clean(data.status)}`,
      "",
      style.strong(`Problems (${String(data.problems.length)})`, capabilities),
    );
    if (data.problems.length === 0) {
      lines.push(`${style.dim(glyphs.end, capabilities)} No recorded problems`);
    } else {
      data.problems.forEach((problem, index) => {
        const branch = index === data.problems.length - 1 ? glyphs.end : glyphs.branch;
        lines.push(
          `${style.dim(branch, capabilities)} ${style.failure(clean(problem.code), capabilities)} · ${clean(problem.summary)}`,
          `  ${clean(problem.detail)}`,
        );
      });
    }
  }

  if (result.command === "context" && isContextCommandData(result.data)) {
    lines.push(
      `${style.success(glyphs.success, capabilities)} Session   ${clean(result.data.sessionId)}`,
      `${style.success(glyphs.success, capabilities)} Context   ${String(result.data.characterCount)} characters`,
      `${style.success(glyphs.success, capabilities)} Evidence  ${String(result.data.includedEvents)} included · ${String(result.data.omittedEvents)} omitted`,
      `${style.success(glyphs.success, capabilities)} Privacy   pseudonymized · redacted · local only`,
    );
  }

  if (result.command === "init" && isInitData(result.data)) {
    lines.push(
      `${style.success(glyphs.success, capabilities)} Config   ${clean(result.data.path)}`,
      `${style.success(glyphs.success, capabilities)} Status   ${clean(result.data.status)}`,
      ...(result.data.detectedPreset === undefined
        ? []
        : [
            `${style.success(glyphs.success, capabilities)} Preset   ${clean(result.data.detectedPreset)}`,
          ]),
    );
  }

  if (result.command === "agent setup" && isAgentSetupData(result.data)) {
    const data = result.data;
    lines.push(
      `${style.success(glyphs.success, capabilities)} Client  ${clean(data.client)}`,
      `${style.success(glyphs.success, capabilities)} Config  ${clean(data.path)}`,
      `${style.success(glyphs.success, capabilities)} Status  ${clean(data.status)}`,
      "",
      style.strong(
        data.status === "manual" ? "Merge this configuration" : "Configuration",
        capabilities,
      ),
      ...data.content.trimEnd().split("\n").map(clean),
      "",
      `${style.accent("Next:", capabilities)} ${clean(data.next)}`,
    );
  }

  if (result.command.startsWith("config ") && isConfigReportData(result.data)) {
    lines.push(
      `${style.success(glyphs.success, capabilities)} Config   valid`,
      `${style.success(glyphs.success, capabilities)} Project  ${clean(result.data.files.project ?? "not found")}`,
      `${style.success(glyphs.success, capabilities)} User     ${clean(result.data.files.user ?? "not found")}`,
    );
    if (result.data.action === "explain") {
      const values = result.data.values ?? [];
      lines.push("", style.strong(`Resolved values (${String(values.length)})`, capabilities));
      values.forEach((value, index) => {
        const branch = index === values.length - 1 ? glyphs.end : glyphs.branch;
        lines.push(
          `${style.dim(branch, capabilities)} ${clean(value.key)} = ${clean(JSON.stringify(value.value))} · ${clean(value.source)}${value.location === undefined ? "" : ` · ${clean(value.location)}`}`,
        );
      });
    }
  }

  if (result.command === "pair" && isPairData(result.data)) {
    lines.push(
      `${style.success(glyphs.success, capabilities)} Paired ${clean(result.data.endpoint)}`,
      style.dim("Run adb-ready connect to verify the final device transport.", capabilities),
    );
  }
  if (result.command.startsWith("ports ") && isPortsData(result.data)) {
    const data = result.data;
    lines.push(
      `${style.success(glyphs.success, capabilities)} Target   ${clean(data.selected.transport.serial)}`,
      `${style.success(glyphs.success, capabilities)} Action   ${clean(data.status)} · ${clean(data.direction)}`,
      "",
      style.strong(`Mappings (${String(data.mappings.length)})`, capabilities),
    );
    if (data.mappings.length === 0) {
      lines.push(`${style.dim(glyphs.end, capabilities)} None`);
    } else {
      data.mappings.forEach((mapping, index) => {
        const branch = index === data.mappings.length - 1 ? glyphs.end : glyphs.branch;
        const arrow = mapping.direction === "reverse" ? "device → host" : "host → device";
        lines.push(
          `${style.dim(branch, capabilities)} ${clean(arrow)} · ${clean(mapping.device)} ↔ ${clean(mapping.host)}`,
        );
      });
    }
  }
  if (hasPlan(result.data)) {
    const steps = result.data.plan.steps;
    lines.push(style.strong("Dry-run plan", capabilities));
    steps.forEach((step, index) => {
      const branch = index === steps.length - 1 ? glyphs.end : glyphs.branch;
      lines.push(`${style.dim(branch, capabilities)} ${clean(step.title)} · ${clean(step.risk)}`);
    });
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

  if (hasDiscovery(result.data) && result.data.discovery.mdns.services.length > 0) {
    const services = result.data.discovery.mdns.services;
    lines.push("", style.strong(`Wireless discovery (${String(services.length)})`, capabilities));
    services.forEach((service, index) => {
      const branch = index === services.length - 1 ? glyphs.end : glyphs.branch;
      lines.push(`${style.dim(branch, capabilities)} ${wirelessServiceLabel(service)}`);
    });
  }

  if (result.problems.length > 0) {
    lines.push("", style.strong("Diagnostics", capabilities));
    for (const problem of result.problems) {
      lines.push(...problemLines(problem, capabilities, options.verbose ?? false));
    }
  }

  const interrupted =
    result.problems.some(({ code }) => code === ProblemCode.OperationInterrupted) &&
    !result.problems.some(
      ({ code, severity }) => severity === "error" && code !== ProblemCode.OperationInterrupted,
    );
  const status = result.ok
    ? `${style.success(glyphs.success, capabilities)} Completed in ${String(result.durationMs)}ms`
    : interrupted
      ? `${style.warning(glyphs.warning, capabilities)} Interrupted safely in ${String(result.durationMs)}ms`
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
  if (isConnectData(result.data)) {
    sink.write(`endpoint=${clean(result.data.endpoint)}\n`);
    sink.write(`serial=${clean(result.data.serial)}\n`);
    sink.write(`state=${clean(result.data.state)}\n`);
    if (result.data.hardwareSerial !== undefined) {
      sink.write(`hardware_serial=${clean(result.data.hardwareSerial)}\n`);
    }
  }
  if (isDevData(result.data)) {
    sink.write(`session_id=${clean(result.data.sessionId)}\n`);
    sink.write(`status=${clean(result.data.status)}\n`);
    sink.write(`preset=${clean(result.data.preset)}\n`);
    sink.write(`serial=${clean(result.data.selected.transport.serial)}\n`);
    sink.write(`project_root=${clean(result.data.project.root)}\n`);
    sink.write(`port_count=${String(result.data.ports.requested.length)}\n`);
    sink.write(`journal_event_count=${String(result.data.journal.events.length)}\n`);
    sink.write(`journal_dropped=${String(result.data.journal.dropped)}\n`);
    if (result.data.child !== undefined) {
      sink.write(`child_exit_code=${String(result.data.child.exitCode)}\n`);
    }
  }
  if (isLogsData(result.data)) {
    sink.write(`serial=${clean(result.data.selected.transport.serial)}\n`);
    sink.write(`filters=${result.data.filters.map(clean).join(",")}\n`);
    if (result.data.packageName !== undefined) {
      sink.write(`package=${clean(result.data.packageName)}\n`);
    }
    if (result.data.pid !== undefined) sink.write(`pid=${String(result.data.pid)}\n`);
    if (result.data.uid !== undefined) sink.write(`uid=${String(result.data.uid)}\n`);
    sink.write(`buffers=${result.data.buffers.map(clean).join(",")}\n`);
    sink.write(`record_count=${String(result.data.records.length)}\n`);
    sink.write(`record_dropped=${String(result.data.dropped)}\n`);
    sink.write(`finding_count=${String(result.data.findings.length)}\n`);
    result.data.findings.forEach((finding) => {
      sink.write(`finding=${clean(finding.code)}:${clean(finding.summary)}\n`);
    });
    result.data.records.forEach((record, index) => {
      sink.write(`record_${String(index)}=${clean(record.raw)}\n`);
    });
  }
  if (isCaptureData(result.data)) {
    sink.write(`kind=${clean(result.data.kind)}\n`);
    sink.write(`serial=${clean(result.data.selected.transport.serial)}\n`);
    sink.write(`path=${clean(result.data.evidence.path)}\n`);
    sink.write(`media_type=${clean(result.data.evidence.mediaType)}\n`);
    sink.write(`bytes=${String(result.data.evidence.bytes)}\n`);
    sink.write(`sha256=${clean(result.data.evidence.sha256)}\n`);
  }
  if (isInspectAppData(result.data)) {
    sink.write("kind=app\n");
    sink.write(`serial=${clean(result.data.selected.transport.serial)}\n`);
    sink.write(`package=${clean(result.data.app.package.applicationId)}\n`);
    sink.write(`logs_available=${String(result.data.logs.available)}\n`);
    if (result.data.logs.available) {
      sink.write(`record_count=${String(result.data.logs.records.length)}\n`);
      sink.write(`finding_count=${String(result.data.logs.findings.length)}\n`);
    }
    sink.write("sensitive=true\n");
  }
  if (isInspectUiData(result.data)) {
    sink.write("kind=ui\n");
    sink.write(`serial=${clean(result.data.selected.transport.serial)}\n`);
    sink.write(`digest=${clean(result.data.snapshot.digest)}\n`);
    sink.write(`node_count=${String(result.data.snapshot.returnedNodes)}\n`);
    sink.write(`truncated=${String(result.data.snapshot.truncated)}\n`);
    sink.write("sensitive=true\n");
  }
  if (isSessionCommandData(result.data)) {
    sink.write(`action=${clean(result.data.action)}\n`);
    if (result.data.action === "list") {
      sink.write(`session_count=${String(result.data.sessions.length)}\n`);
      result.data.sessions.forEach((session, index) => {
        sink.write(
          `session_${String(index)}=${clean(session.sessionId)}:${clean(session.status)}:${clean(session.updatedAt)}\n`,
        );
      });
    } else {
      sink.write(`session_id=${clean(result.data.session.sessionId)}\n`);
      sink.write(`status=${clean(result.data.session.status)}\n`);
      sink.write(`event_count=${String(result.data.session.eventCount)}\n`);
      if (result.data.action === "events") {
        result.data.events.forEach((event, index) => {
          sink.write(
            `event_${String(index)}=${clean(event.timestamp)}:${clean(event.severity)}:${clean(event.type)}:${clean(event.message)}\n`,
          );
        });
      }
    }
  }
  if (isProblemsCommandData(result.data)) {
    sink.write(`session_id=${clean(result.data.sessionId)}\n`);
    sink.write(`status=${clean(result.data.status)}\n`);
    sink.write(`problem_count=${String(result.data.problems.length)}\n`);
    result.data.problems.forEach((problem) => {
      sink.write(`problem=${clean(problem.code)}:${clean(problem.summary)}\n`);
    });
  }
  if (isContextCommandData(result.data)) {
    sink.write(`session_id=${clean(result.data.sessionId)}\n`);
    sink.write(`status=${clean(result.data.status)}\n`);
    sink.write(`character_count=${String(result.data.characterCount)}\n`);
    sink.write(`included_events=${String(result.data.includedEvents)}\n`);
    sink.write(`omitted_events=${String(result.data.omittedEvents)}\n`);
    sink.write(`filtered_events=${String(result.data.filteredEvents)}\n`);
  }
  if (isInitData(result.data)) {
    sink.write(`status=${clean(result.data.status)}\n`);
    sink.write(`path=${clean(result.data.path)}\n`);
    if (result.data.detectedPreset !== undefined) {
      sink.write(`detected_preset=${clean(result.data.detectedPreset)}\n`);
    }
  }
  if (isAgentSetupData(result.data)) {
    sink.write(`client=${clean(result.data.client)}\n`);
    sink.write(`status=${clean(result.data.status)}\n`);
    sink.write(`path=${clean(result.data.path)}\n`);
    sink.write(`scope=${clean(result.data.scope)}\n`);
  }
  if (isConfigReportData(result.data)) {
    sink.write(`action=${clean(result.data.action)}\n`);
    sink.write("valid=true\n");
    if (result.data.files.project !== undefined) {
      sink.write(`project_config=${clean(result.data.files.project)}\n`);
    }
    if (result.data.files.user !== undefined) {
      sink.write(`user_config=${clean(result.data.files.user)}\n`);
    }
    for (const value of result.data.values ?? []) {
      sink.write(
        `value=${clean(value.key)}:${clean(JSON.stringify(value.value))}:${clean(value.source)}\n`,
      );
    }
  }
  if (isPairData(result.data)) {
    sink.write(`endpoint=${clean(result.data.endpoint)}\n`);
    sink.write("paired=true\n");
  }
  if (isPortsData(result.data)) {
    sink.write(`direction=${clean(result.data.direction)}\n`);
    sink.write(`action=${clean(result.data.action)}\n`);
    sink.write(`status=${clean(result.data.status)}\n`);
    sink.write(`serial=${clean(result.data.selected.transport.serial)}\n`);
    sink.write(`mapping_count=${String(result.data.mappings.length)}\n`);
    result.data.mappings.forEach((mapping, index) => {
      sink.write(
        `mapping_${String(index)}=${clean(mapping.direction)}:${clean(mapping.device)}:${clean(mapping.host)}\n`,
      );
    });
  }
  if (hasPlan(result.data)) {
    sink.write("dry_run=true\n");
    sink.write(`step_count=${String(result.data.plan.steps.length)}\n`);
    result.data.plan.steps.forEach((step, index) => {
      sink.write(`step_${String(index)}=${clean(step.id)}:${clean(step.title)}\n`);
    });
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
  if (hasDiscovery(result.data)) {
    const services = result.data.discovery.mdns.services;
    sink.write(`wireless_service_count=${String(services.length)}\n`);
    services.forEach((service, index) => {
      sink.write(`wireless_service_${String(index)}=${wirelessServiceLabel(service)}\n`);
    });
  }
  for (const problem of result.problems) {
    sink.write(`problem=${clean(problem.code)}:${clean(problem.summary)}\n`);
  }
}

export function renderResult(result: CommandResult, options: ResultRenderOptions): void {
  if (options.format === "markdown" && isContextCommandData(result.data)) {
    options.sink.write(result.data.markdown);
  } else if (options.format === "json") {
    options.sink.write(`${JSON.stringify(result)}\n`);
  } else if (options.format === "ndjson") {
    if (isSessionCommandData(result.data) && result.data.action === "events") {
      for (const event of result.data.events) {
        options.sink.write(`${JSON.stringify({ kind: "event", ...event })}\n`);
      }
      options.sink.write(
        `${JSON.stringify({
          kind: "result",
          ...result,
          data: {
            action: result.data.action,
            session: result.data.session,
            eventCount: result.data.events.length,
          },
        })}\n`,
      );
    } else {
      options.sink.write(`${JSON.stringify({ kind: "result", ...result })}\n`);
    }
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
