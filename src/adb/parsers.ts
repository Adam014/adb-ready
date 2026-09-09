import { isIP } from "node:net";

export type AdbDeviceState =
  | "bootloader"
  | "device"
  | "no-permissions"
  | "offline"
  | "recovery"
  | "sideload"
  | "unauthorized"
  | "unknown";

export interface AdbDevice {
  serial: string;
  state: AdbDeviceState;
  product?: string;
  model?: string;
  device?: string;
  transportId?: string;
  usb?: string;
  properties: Record<string, string>;
  unparsed: string[];
}

export interface AdbVersion {
  protocolVersion?: string;
  platformToolsVersion?: string;
  installedAs?: string;
  raw: string;
}

export type AdbMdnsServiceType = "connect" | "legacy" | "pairing" | "unknown";

export interface AdbNetworkEndpoint {
  host: string;
  port: number;
  serial: string;
  version: 4 | 6 | "hostname";
}

export interface AdbMdnsService {
  instance: string;
  rawServiceType: string;
  serviceType: AdbMdnsServiceType;
  endpoint: AdbNetworkEndpoint;
  alternateEndpoints?: AdbNetworkEndpoint[];
  deviceModel?: string;
  buildVersionSdkFull?: string;
  givenName?: string;
  hardwareSerial?: string;
  mdnsServiceVersion?: string;
  hostname?: string;
  knownDevice?: boolean;
}

export interface AdbConnectResult {
  status: "already-connected" | "connected" | "failed" | "unknown";
  endpoint?: string;
  message: string;
}

export interface AdbPairResult {
  paired: boolean;
  endpoint?: string;
  message: string;
}

export interface AdbPortMapping {
  serial: string;
  local: string;
  remote: string;
}

export interface AndroidPackage {
  name: string;
  sourcePath?: string;
}

export type AndroidLogPriority = "A" | "D" | "E" | "F" | "I" | "V" | "W";

export interface LogcatThreadtimeLine {
  timestamp: string;
  pid: number;
  tid: number;
  priority: AndroidLogPriority;
  tag: string;
  message: string;
  raw: string;
}

const KNOWN_STATES = new Set<AdbDeviceState>([
  "bootloader",
  "device",
  "offline",
  "recovery",
  "sideload",
  "unauthorized",
]);

function normalizeState(tokens: string[]): { state: AdbDeviceState; consumed: number } {
  if (tokens[0] === "no" && tokens[1] === "permissions") {
    return { state: "no-permissions", consumed: 2 };
  }
  const candidate = tokens[0] as AdbDeviceState | undefined;
  if (candidate !== undefined && KNOWN_STATES.has(candidate)) {
    return { state: candidate, consumed: 1 };
  }
  return { state: "unknown", consumed: candidate === undefined ? 0 : 1 };
}

export function parseAdbDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  let sawHeader = false;

  for (const rawLine of output.replaceAll("\r\n", "\n").split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    if (line.startsWith("List of devices attached")) {
      sawHeader = true;
      continue;
    }
    if (!sawHeader || line.startsWith("* daemon") || line.startsWith("adb server")) {
      continue;
    }

    const tokens = line.split(/\s+/u);
    const serial = tokens.shift();
    if (serial === undefined || serial === "") {
      continue;
    }

    const { state, consumed } = normalizeState(tokens);
    const details = tokens.slice(consumed);
    const properties: Record<string, string> = {};
    const unparsed: string[] = [];

    for (const token of details) {
      const separator = token.indexOf(":");
      if (separator <= 0) {
        unparsed.push(token);
        continue;
      }
      properties[token.slice(0, separator)] = token.slice(separator + 1);
    }

    devices.push({
      serial,
      state,
      ...(properties.product === undefined ? {} : { product: properties.product }),
      ...(properties.model === undefined ? {} : { model: properties.model.replaceAll("_", " ") }),
      ...(properties.device === undefined ? {} : { device: properties.device }),
      ...(properties.transport_id === undefined ? {} : { transportId: properties.transport_id }),
      ...(properties.usb === undefined ? {} : { usb: properties.usb }),
      properties,
      unparsed,
    });
  }

  return devices;
}

export function parseAdbVersion(output: string): AdbVersion {
  const normalized = output.replaceAll("\r\n", "\n").trim();
  const protocolVersion = normalized.match(/Android Debug Bridge version\s+([^\s]+)/iu)?.[1];
  const platformToolsVersion = normalized.match(/^Version\s+([^\s]+)/imu)?.[1];
  const installedAs = normalized.match(/^Installed as\s+(.+)$/imu)?.[1]?.trim();

  return {
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    ...(platformToolsVersion === undefined ? {} : { platformToolsVersion }),
    ...(installedAs === undefined ? {} : { installedAs }),
    raw: normalized,
  };
}

export function parseFeatureList(output: string): string[] {
  return [
    ...new Set(
      output
        .trim()
        .split(/[\s,]+/u)
        .map((feature) => feature.trim())
        .filter(Boolean),
    ),
  ].sort();
}

export function parseKeyValueLines(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of output.replaceAll("\r\n", "\n").split("\n")) {
    const separator = rawLine.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = rawLine.slice(0, separator).trim();
    const value = rawLine.slice(separator + 1).trim();
    if (key !== "") {
      values[key] = value;
    }
  }
  return values;
}

export function parseAdbNetworkEndpoint(value: string): AdbNetworkEndpoint | undefined {
  const normalized = value.trim();
  const bracketed = normalized.startsWith("[");
  const separator = bracketed ? normalized.lastIndexOf("]:") : normalized.lastIndexOf(":");
  const host = bracketed ? normalized.slice(1, separator) : normalized.slice(0, separator);
  const portText = normalized.slice(separator + (bracketed ? 2 : 1));
  const port = Number(portText);
  if (
    separator < 1 ||
    host === "" ||
    (!bracketed &&
      (host.includes(":") || host.includes("[") || host.includes("]") || /\s/u.test(host))) ||
    (bracketed && (host.includes("[") || host.includes("]") || /\s/u.test(host))) ||
    !/^\d+$/u.test(portText) ||
    host === "0.0.0.0" ||
    host === "::" ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    return undefined;
  }

  const version = bracketed ? 6 : /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) ? 4 : "hostname";
  if ((version === 6 && isIP(host) !== 6) || (version === 4 && isIP(host) !== 4)) {
    return undefined;
  }

  return {
    host,
    port,
    serial: version === 6 ? `[${host}]:${String(port)}` : `${host}:${String(port)}`,
    version,
  };
}

function mdnsServiceType(value: string): AdbMdnsServiceType {
  if (value === "_adb-tls-connect._tcp") {
    return "connect";
  }
  if (value === "_adb-tls-pairing._tcp") {
    return "pairing";
  }
  if (value === "_adb._tcp") {
    return "legacy";
  }
  return "unknown";
}

export function parseAdbMdnsServices(output: string): AdbMdnsService[] {
  const services: AdbMdnsService[] = [];
  const seen = new Set<string>();

  for (const rawLine of output.replaceAll("\r\n", "\n").split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line === "List of discovered mdns services") {
      continue;
    }

    const match = line.match(/^(.*?)\s+(_adb(?:-tls-(?:pairing|connect))?\._tcp)\s+(\S+)$/u);
    if (match === null) {
      continue;
    }
    const instance = match[1]?.trim();
    const rawServiceType = match[2];
    const endpoint = parseAdbNetworkEndpoint(match[3] ?? "");
    if (
      instance === undefined ||
      instance === "" ||
      rawServiceType === undefined ||
      endpoint === undefined
    ) {
      continue;
    }

    const key = `${rawServiceType}\0${instance}\0${endpoint.serial}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    services.push({
      instance,
      rawServiceType,
      serviceType: mdnsServiceType(rawServiceType),
      endpoint,
    });
  }

  return services.sort((left, right) =>
    `${left.serviceType}\0${left.instance}\0${left.endpoint.serial}`.localeCompare(
      `${right.serviceType}\0${right.instance}\0${right.endpoint.serial}`,
    ),
  );
}

function decodeTextProtoString(value: string): string | undefined {
  if (!value.startsWith('"') || !value.endsWith('"')) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function parseAdbMdnsTrackServices(output: string): AdbMdnsService[] {
  const services: AdbMdnsService[] = [];
  const seen = new Set<string>();
  const stack: string[] = [];
  let current:
    | {
        kind: "pair" | "tcp" | "tls";
        fields: Map<string, string[]>;
        knownDevice?: boolean;
      }
    | undefined;

  const finish = () => {
    if (current === undefined) {
      return;
    }
    const first = (key: string) => current?.fields.get(key)?.[0];
    const instance = first("instance");
    const rawServiceType =
      first("service") ??
      (current.kind === "pair"
        ? "_adb-tls-pairing._tcp"
        : current.kind === "tls"
          ? "_adb-tls-connect._tcp"
          : "_adb._tcp");
    const portText = first("port");
    const port = portText === undefined ? undefined : Number(portText);
    const hosts = [
      ...(current.fields.get("ipv4") ?? []),
      ...(current.fields.get("ipv6") ?? []),
      ...(current.fields.get("hostname") ?? []),
    ];
    const endpoints =
      port === undefined || !Number.isSafeInteger(port)
        ? []
        : [
            ...new Map(
              hosts
                .map((host) =>
                  parseAdbNetworkEndpoint(
                    host.includes(":") ? `[${host}]:${String(port)}` : `${host}:${String(port)}`,
                  ),
                )
                .filter((endpoint): endpoint is AdbNetworkEndpoint => endpoint !== undefined)
                .map((endpoint) => [endpoint.serial, endpoint]),
            ).values(),
          ];
    const endpoint = endpoints[0];
    if (instance !== undefined && endpoint !== undefined) {
      const key = `${rawServiceType}\0${instance}\0${endpoint.serial}`;
      if (!seen.has(key)) {
        seen.add(key);
        const deviceModel = first("product_model") ?? first("device_model");
        const buildVersionSdkFull = first("build_version_sdk_full");
        const givenName = first("given_name");
        const hardwareSerial = first("serial");
        const mdnsServiceVersion = first("mdns_service_version");
        const hostname = first("hostname");
        services.push({
          instance,
          rawServiceType,
          serviceType: mdnsServiceType(rawServiceType),
          endpoint,
          ...(endpoints.length < 2 ? {} : { alternateEndpoints: endpoints.slice(1) }),
          ...(deviceModel === undefined ? {} : { deviceModel }),
          ...(buildVersionSdkFull === undefined ? {} : { buildVersionSdkFull }),
          ...(givenName === undefined ? {} : { givenName }),
          ...(hardwareSerial === undefined ? {} : { hardwareSerial }),
          ...(mdnsServiceVersion === undefined ? {} : { mdnsServiceVersion }),
          ...(hostname === undefined ? {} : { hostname }),
          ...(current.knownDevice === undefined ? {} : { knownDevice: current.knownDevice }),
        });
      }
    }
    current = undefined;
  };

  for (const rawLine of output.replaceAll("\r\n", "\n").split("\n")) {
    const line = rawLine.trim();
    const opening = line.match(/^(\w+)\s*\{$/u)?.[1];
    if (opening !== undefined) {
      stack.push(opening);
      if (opening === "pair" || opening === "tcp" || opening === "tls") {
        current = { kind: opening, fields: new Map() };
      }
      continue;
    }
    if (line === "}") {
      const closing = stack.pop();
      if (closing === "pair" || closing === "tcp" || closing === "tls") {
        finish();
      }
      continue;
    }
    if (current === undefined) {
      continue;
    }
    const scalar = line.match(/^(\w+):\s*(.+)$/u);
    const key = scalar?.[1];
    const rawValue = scalar?.[2];
    if (key === undefined || rawValue === undefined) {
      continue;
    }
    if (key === "known_device" && stack.at(-1) !== "service") {
      if (rawValue === "true" || rawValue === "false") {
        current.knownDevice = rawValue === "true";
      }
      continue;
    }
    if (stack.at(-1) !== "service") {
      continue;
    }
    const value = /^\d+$/u.test(rawValue) ? rawValue : decodeTextProtoString(rawValue);
    if (value !== undefined) {
      const values = current.fields.get(key) ?? [];
      values.push(value);
      current.fields.set(key, values);
    }
  }
  finish();

  return services.sort((left, right) =>
    `${left.serviceType}\0${left.instance}\0${left.endpoint.serial}`.localeCompare(
      `${right.serviceType}\0${right.instance}\0${right.endpoint.serial}`,
    ),
  );
}

export function parseAdbConnectResult(output: string): AdbConnectResult {
  const message = output.replaceAll("\r\n", "\n").trim();
  const already = message.match(/already connected to\s+(\S+)/iu);
  if (already !== null) {
    return {
      status: "already-connected",
      ...(already[1] === undefined ? {} : { endpoint: already[1] }),
      message,
    };
  }
  const connected = message.match(/(?:^|\n)connected to\s+(\S+)/iu);
  if (connected !== null) {
    return {
      status: "connected",
      ...(connected[1] === undefined ? {} : { endpoint: connected[1] }),
      message,
    };
  }
  return {
    status: /failed|cannot|unable|error/iu.test(message) ? "failed" : "unknown",
    message,
  };
}

export function parseAdbPairResult(output: string): AdbPairResult {
  const message = output.replaceAll("\r\n", "\n").trim();
  const success = message.match(/successfully paired to\s+(\S+)/iu);
  return {
    paired: success !== null,
    ...(success?.[1] === undefined ? {} : { endpoint: success[1] }),
    message,
  };
}

export function parseSingleLine(output: string): string | undefined {
  return output
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

export function parseAdbPortMappings(output: string): AdbPortMapping[] {
  const mappings: AdbPortMapping[] = [];
  for (const rawLine of output.replaceAll("\r\n", "\n").split("\n")) {
    const fields = rawLine.trim().split(/\s+/u);
    if (fields.length !== 3) {
      continue;
    }
    const [serial, local, remote] = fields;
    if (serial !== undefined && local !== undefined && remote !== undefined) {
      mappings.push({ serial, local, remote });
    }
  }
  return mappings;
}

export function parseAndroidPackages(output: string): AndroidPackage[] {
  const packages: AndroidPackage[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.replaceAll("\r\n", "\n").split("\n")) {
    const match = rawLine
      .trim()
      .match(/^package:(?:(\S+)=)?([a-zA-Z0-9_][a-zA-Z0-9_.]*)(?:\s+.*)?$/u);
    const name = match?.[2];
    if (name === undefined || seen.has(name)) {
      continue;
    }
    seen.add(name);
    packages.push({ name, ...(match?.[1] === undefined ? {} : { sourcePath: match[1] }) });
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

export function parseLogcatThreadtimeLine(raw: string): LogcatThreadtimeLine | undefined {
  const line = raw.replace(/\r?\n$/u, "");
  const match = line.match(
    /^((?:\d{4}-)?\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.+?)\s*:\s(.*)$/u,
  );
  if (match === null) {
    return undefined;
  }
  const pid = Number(match[2]);
  const tid = Number(match[3]);
  const timestamp = match[1];
  const priority = match[4] as AndroidLogPriority | undefined;
  const tag = match[5]?.trim();
  const message = match[6];
  if (
    timestamp === undefined ||
    priority === undefined ||
    tag === undefined ||
    tag === "" ||
    message === undefined ||
    !Number.isSafeInteger(pid) ||
    !Number.isSafeInteger(tid)
  ) {
    return undefined;
  }
  return { timestamp, pid, tid, priority, tag, message, raw: line };
}
