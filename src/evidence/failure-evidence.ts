import { context, finish, problem, readyTarget, runApp, succeeded } from "../app/app-commands.js";
import {
  type CommandConfig,
  type CommandDependencies,
  type CommandExecution,
  runLogs,
} from "../app/commands.js";
import { redactText } from "../core/redaction.js";
import type { Problem } from "../domain/contracts.js";

const DEFAULT_WINDOW_MS = 15 * 60_000;
const MAX_WINDOW_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_INCIDENT_LIMIT = 20;
const MAX_INCIDENT_LIMIT = 100;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const DROPBOX_TAGS = [
  "data_app_crash",
  "data_app_anr",
  "data_app_native_crash",
  "system_app_crash",
  "system_app_anr",
  "system_app_native_crash",
] as const;

export type FailureKind = "anr" | "java-crash" | "native-crash" | "react-native";

export interface FailureIncident {
  kind: FailureKind;
  source: "application-exit-info" | "dropbox" | "logcat";
  corroboratedBy?: ("application-exit-info" | "dropbox" | "logcat")[];
  observedAt?: string;
  process?: string;
  pid?: number;
  reason?: string;
  summary: string;
  evidence: string[];
}

export interface FailureSource {
  name: "application-exit-info" | "dropbox" | "logcat";
  available: boolean;
  records: number;
  truncated: boolean;
  limitation?: string;
}

export interface InspectFailuresRequest {
  cwd: string;
  applicationId?: string;
  configuredPackage?: { value: string; location?: string };
  sinceMs?: number;
  limit?: number;
}

export interface InspectFailuresData {
  kind: "failures";
  selected: import("../target/selection.js").SelectedTarget;
  applicationId: string;
  identity: { uid?: number; currentPid?: number };
  window: { since: string; until: string; durationMs: number; deviceUtcOffset: string };
  summary: Record<FailureKind, number>;
  incidents: FailureIncident[];
  sources: FailureSource[];
  truncated: boolean;
  sensitive: true;
}

interface ExitInfoRecord {
  timestamp: string;
  pid: number;
  process: string;
  reasonCode: number;
  reason: string;
  description?: string;
}

function offsetIso(timestamp: string, offset: string): string | undefined {
  const normalizedOffset = offset.replace(
    /^(?<sign>[+-])(?<hours>\d{2})(?<minutes>\d{2})$/u,
    "$<sign>$<hours>:$<minutes>",
  );
  const parsed = new Date(`${timestamp.replace(" ", "T")}${normalizedOffset}`);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
}

export function parseApplicationExitInfo(output: string, offset: string): ExitInfoRecord[] {
  const records: ExitInfoRecord[] = [];
  const blocks = output.matchAll(
    /ApplicationExitInfo #\d+:[\s\S]*?(?=\n\s*ApplicationExitInfo #\d+:|$)/gu,
  );
  for (const match of blocks) {
    const block = match[0];
    const identity = block.match(
      /timestamp=(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) pid=(\d+)[^\n]*\n\s*process=(\S+) reason=(\d+) \((.+?)\) subreason=/u,
    );
    if (identity === null) continue;
    const timestamp = offsetIso(identity[1] ?? "", offset);
    const pid = Number(identity[2]);
    const reasonCode = Number(identity[4]);
    if (
      timestamp === undefined ||
      !Number.isSafeInteger(pid) ||
      !Number.isSafeInteger(reasonCode)
    ) {
      continue;
    }
    const description = block.match(/\bdescription=(.*?)\s+state=/u)?.[1];
    records.push({
      timestamp,
      pid,
      process: identity[3] ?? "unknown",
      reasonCode,
      reason: identity[5] ?? "UNKNOWN",
      ...(description === undefined || description === "null" ? {} : { description }),
    });
  }
  return records;
}

function exitKind(reasonCode: number): FailureKind | undefined {
  if (reasonCode === 4 || reasonCode === 7) return "java-crash";
  if (reasonCode === 5) return "native-crash";
  if (reasonCode === 6) return "anr";
  return undefined;
}

function dropboxKind(tag: string): FailureKind {
  if (tag.includes("_anr")) return "anr";
  if (tag.includes("native")) return "native-crash";
  return "java-crash";
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function parseDropboxFailures(
  output: string,
  applicationId: string,
  offset: string,
): FailureIncident[] {
  const headers = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\S+) \([^\n]*\)$/gmu;
  const matches = [...output.matchAll(headers)];
  const incidents: FailureIncident[] = [];
  const packagePattern = new RegExp(
    `^(?:Package|Process):\\s*${escapePattern(applicationId)}(?::[^\\s]+)?\\s*$`,
    "mu",
  );
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (match === undefined) continue;
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? output.length;
    const block = output.slice(start, end).trim();
    if (!packagePattern.test(block)) continue;
    const tag = match[2] ?? "data_app_crash";
    const safe = redactText(block).value.split("\n").slice(0, 40);
    const observedAt = offsetIso(`${match[1] ?? ""}.000`, offset);
    incidents.push({
      kind: dropboxKind(tag),
      source: "dropbox",
      ...(observedAt === undefined ? {} : { observedAt }),
      reason: tag,
      summary: `Android DropBox retained ${tag} evidence for the selected application.`,
      evidence: safe,
    });
  }
  return incidents;
}

function sourceUnavailable(name: FailureSource["name"], limitation: string): FailureSource {
  return { name, available: false, records: 0, truncated: false, limitation };
}

function boundedIncidents(incidents: FailureIncident[], since: number, limit: number) {
  const inWindow = incidents.filter((incident) => {
    if (incident.observedAt === undefined) return true;
    const value = Date.parse(incident.observedAt);
    return Number.isFinite(value) && value >= since;
  });
  inWindow.sort((left, right) => (right.observedAt ?? "").localeCompare(left.observedAt ?? ""));
  return { incidents: inWindow.slice(0, limit), truncated: inWindow.length > limit };
}

function incidentSources(incident: FailureIncident): FailureIncident["source"][] {
  return [incident.source, ...(incident.corroboratedBy ?? [])];
}

export function correlateFailureIncidents(incidents: FailureIncident[]): FailureIncident[] {
  const correlated: FailureIncident[] = [];
  for (const incident of incidents) {
    const match = correlated.find((candidate) => {
      if (candidate.kind !== incident.kind) return false;
      if (incidentSources(candidate).includes(incident.source)) return false;
      if (
        candidate.process !== undefined &&
        incident.process !== undefined &&
        candidate.process !== incident.process
      ) {
        return false;
      }
      const samePid =
        candidate.pid !== undefined && incident.pid !== undefined && candidate.pid === incident.pid;
      const candidateTime =
        candidate.observedAt === undefined ? Number.NaN : Date.parse(candidate.observedAt);
      const incidentTime =
        incident.observedAt === undefined ? Number.NaN : Date.parse(incident.observedAt);
      const sameMoment =
        Number.isFinite(candidateTime) &&
        Number.isFinite(incidentTime) &&
        Math.abs(candidateTime - incidentTime) <= 5_000;
      return samePid || sameMoment;
    });
    if (match === undefined) {
      correlated.push({ ...incident, evidence: [...incident.evidence] });
      continue;
    }
    match.corroboratedBy = [
      ...new Set([
        ...(match.corroboratedBy ?? []),
        incident.source,
        ...(incident.corroboratedBy ?? []),
      ]),
    ];
    if (match.observedAt === undefined && incident.observedAt !== undefined) {
      match.observedAt = incident.observedAt;
    }
    if (match.process === undefined && incident.process !== undefined) {
      match.process = incident.process;
    }
    if (match.pid === undefined && incident.pid !== undefined) match.pid = incident.pid;
    match.evidence = [...new Set([...match.evidence, ...incident.evidence])].slice(0, 80);
  }
  return correlated;
}

export async function runInspectFailures(
  request: InspectFailuresRequest,
  config: CommandConfig = {},
  dependencies: CommandDependencies = {},
  signal?: AbortSignal,
): Promise<CommandExecution<InspectFailuresData>> {
  const current = context("inspect failures", dependencies);
  const problems: Problem[] = [];
  const sinceMs = request.sinceMs ?? DEFAULT_WINDOW_MS;
  const limit = request.limit ?? DEFAULT_INCIDENT_LIMIT;
  if (!Number.isSafeInteger(sinceMs) || sinceMs < 1_000 || sinceMs > MAX_WINDOW_MS) {
    problems.push(
      problem(
        "FAILURE_WINDOW_INVALID",
        "input.failures.window",
        "Failure evidence window must be from 1 second to 7 days.",
        "Choose a bounded recent window such as --since 15m.",
        current.commandId,
      ),
    );
    return finish<InspectFailuresData>(current, null, problems);
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INCIDENT_LIMIT) {
    problems.push(
      problem(
        "FAILURE_LIMIT_INVALID",
        "input.failures.limit",
        "Failure incident limit must be from 1 to 100.",
        "Choose a bounded --max-records value.",
        current.commandId,
      ),
    );
    return finish<InspectFailuresData>(current, null, problems);
  }

  const appExecution = await runApp(
    {
      action: "info",
      cwd: request.cwd,
      ...(request.applicationId === undefined ? {} : { applicationId: request.applicationId }),
      ...(request.configuredPackage === undefined
        ? {}
        : { configuredPackage: request.configuredPackage }),
    },
    config,
    dependencies,
    signal,
  );
  const app = appExecution.result.data;
  if (!appExecution.result.ok || app === null || app.action !== "info") {
    problems.push(...appExecution.result.problems);
    return finish<InspectFailuresData>(current, null, problems);
  }
  const boundConfig: CommandConfig = {
    ...config,
    rememberedOnly: false,
    ...(app.selected.transport.transportId === undefined
      ? { targetSelector: app.selected.transport.serial }
      : { targetTransportId: app.selected.transport.transportId }),
  };
  if (app.selected.transport.transportId === undefined) delete boundConfig.targetTransportId;
  else delete boundConfig.targetSelector;
  const ready = await readyTarget(current, boundConfig, dependencies, problems, signal);
  if (ready === undefined) return finish<InspectFailuresData>(current, null, problems);

  const [epochResult, offsetResult] = await Promise.all([
    ready.client.targetCommand(
      ready.target,
      "failure-device-clock",
      "Reading Android failure clock",
      ["shell", "date", "+%s%3N"],
      (output) => Number(output.trim()),
      signal,
    ),
    ready.client.targetCommand(
      ready.target,
      "failure-device-timezone",
      "Reading Android failure timezone",
      ["shell", "date", "+%z"],
      (output) => output.trim(),
      signal,
    ),
  ]);
  const deviceNow = epochResult.value;
  const offset = offsetResult.value;
  if (
    !succeeded(epochResult.process) ||
    !succeeded(offsetResult.process) ||
    !Number.isSafeInteger(deviceNow) ||
    !/^[+-]\d{4}$/u.test(offset)
  ) {
    problems.push(
      problem(
        "FAILURE_CLOCK_UNAVAILABLE",
        "evidence.failures.clock",
        "Android did not provide a stable clock and UTC offset for the evidence window.",
        "Verify the target clock and retry; ADB Ready will not guess cross-timezone attribution.",
        current.commandId,
      ),
    );
    return finish<InspectFailuresData>(current, null, problems);
  }
  const sinceEpoch = deviceNow - sinceMs;
  const incidents: FailureIncident[] = [];
  const sources: FailureSource[] = [];

  const exits = await ready.client.targetCommand(
    ready.target,
    "failure-exit-info",
    `Reading exit history for ${app.package.applicationId}`,
    ["shell", "dumpsys", "activity", "exit-info", app.package.applicationId],
    (output) => output,
    signal,
    { acceptExitCodes: [1], maxBufferBytes: MAX_SOURCE_BYTES },
  );
  if (!succeeded(exits.process, [1])) {
    sources.push(
      sourceUnavailable("application-exit-info", "Android exit history is unavailable."),
    );
  } else if (!exits.value.includes("ACTIVITY MANAGER PROCESS EXIT INFO")) {
    sources.push(
      sourceUnavailable(
        "application-exit-info",
        "This Android build does not expose package-scoped ApplicationExitInfo through dumpsys.",
      ),
    );
  } else {
    const parsed = parseApplicationExitInfo(exits.value, offset);
    for (const record of parsed) {
      if (
        record.process !== app.package.applicationId &&
        !record.process.startsWith(`${app.package.applicationId}:`)
      ) {
        continue;
      }
      const kind = exitKind(record.reasonCode);
      if (kind === undefined) continue;
      incidents.push({
        kind,
        source: "application-exit-info",
        observedAt: record.timestamp,
        process: record.process,
        pid: record.pid,
        reason: `${String(record.reasonCode)} (${record.reason})`,
        summary: `${record.process} exited because Android classified ${record.reason}.`,
        evidence: [
          `reason=${String(record.reasonCode)} (${record.reason})`,
          ...(record.description === undefined
            ? []
            : [`description=${redactText(record.description).value}`]),
        ],
      });
    }
    sources.push({
      name: "application-exit-info",
      available: true,
      records: parsed.length,
      truncated: exits.process.stdoutTruncated,
    });
  }

  const logExecution = await runLogs(
    {
      packageName: app.package.applicationId,
      dump: true,
      buffers: ["main", "system", "crash"],
      since: formatLogcatSince(sinceEpoch, offset),
      maxRecords: Math.max(200, limit * 20),
    },
    boundConfig,
    dependencies,
    signal,
  );
  const logs = logExecution.result.data;
  if (logs === null) {
    sources.push(
      sourceUnavailable(
        "logcat",
        logExecution.result.problems[0]?.summary ?? "Package-scoped logcat is unavailable.",
      ),
    );
  } else {
    for (const finding of logs.findings) {
      const kind: FailureKind =
        finding.code === "ANDROID_ANR"
          ? "anr"
          : finding.code === "ANDROID_NATIVE_CRASH"
            ? "native-crash"
            : finding.code === "REACT_NATIVE_FATAL"
              ? "react-native"
              : "java-crash";
      const pid = logs.records.find((record) => record.message === finding.message)?.pid;
      incidents.push({
        kind,
        source: "logcat",
        ...(pid === undefined ? {} : { pid }),
        reason: finding.code,
        summary: finding.summary,
        evidence: [finding.message],
      });
    }
    sources.push({
      name: "logcat",
      available: true,
      records: logs.records.length,
      truncated: logs.dropped > 0 || logs.process.stdoutTruncated,
    });
  }

  let dropboxAvailable = false;
  let dropboxTruncated = false;
  let dropboxRecords = 0;
  let dropboxLimitation: string | undefined;
  for (const tag of DROPBOX_TAGS) {
    const observation = await ready.client.targetCommand(
      ready.target,
      `failure-dropbox-${tag}`,
      `Reading Android ${tag} evidence`,
      ["shell", "dumpsys", "dropbox", "--print", tag],
      (output) => output,
      signal,
      { acceptExitCodes: [1], maxBufferBytes: MAX_SOURCE_BYTES },
    );
    if (!succeeded(observation.process, [1])) {
      dropboxLimitation ??= "Android DropBox failure evidence is unavailable.";
      continue;
    }
    if (/Permission Denial|not allowed|SecurityException/iu.test(observation.value)) {
      dropboxLimitation ??= "Android denied shell access to DropBox failure evidence.";
      continue;
    }
    dropboxAvailable = true;
    dropboxTruncated ||= observation.process.stdoutTruncated;
    const parsed = parseDropboxFailures(observation.value, app.package.applicationId, offset);
    dropboxRecords += parsed.length;
    incidents.push(...parsed);
  }
  sources.push(
    dropboxAvailable
      ? {
          name: "dropbox",
          available: true,
          records: dropboxRecords,
          truncated: dropboxTruncated,
          ...(dropboxLimitation === undefined ? {} : { limitation: dropboxLimitation }),
        }
      : sourceUnavailable(
          "dropbox",
          dropboxLimitation ?? "No supported DropBox source is exposed.",
        ),
  );

  const bounded = boundedIncidents(correlateFailureIncidents(incidents), sinceEpoch, limit);
  const summary: Record<FailureKind, number> = {
    "java-crash": 0,
    "native-crash": 0,
    anr: 0,
    "react-native": 0,
  };
  for (const incident of bounded.incidents) summary[incident.kind] += 1;
  return finish(
    current,
    {
      kind: "failures",
      selected: ready.selected,
      applicationId: app.package.applicationId,
      identity: {
        ...(logs?.uid === undefined ? {} : { uid: logs.uid }),
        ...(logs?.pid === undefined ? {} : { currentPid: logs.pid }),
      },
      window: {
        since: new Date(sinceEpoch).toISOString(),
        until: new Date(deviceNow).toISOString(),
        durationMs: sinceMs,
        deviceUtcOffset: offset,
      },
      summary,
      incidents: bounded.incidents,
      sources,
      truncated: bounded.truncated,
      sensitive: true,
    },
    problems,
  );
}

function formatLogcatSince(epoch: number, offset: string): string {
  const sign = offset.startsWith("-") ? -1 : 1;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(3, 5));
  const local = new Date(epoch + sign * (hours * 60 + minutes) * 60_000);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}.${pad(local.getUTCMilliseconds(), 3)}`;
}
