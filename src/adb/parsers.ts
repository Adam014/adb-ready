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
    (bracketed && (host.includes("[") || host.includes("]"))) ||
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
  if (version === 4 && host.split(".").some((part) => Number(part) > 255)) {
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
