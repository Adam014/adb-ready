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
