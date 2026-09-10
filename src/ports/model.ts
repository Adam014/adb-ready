import type { AdbPortMapping } from "../adb/parsers.js";

export type PortDirection = "forward" | "reverse";

export interface TcpPortMapping {
  direction: PortDirection;
  serial: string;
  host: string;
  device: string;
}

export type TcpPortInput = string | number;

export function parseTcpPort(value: TcpPortInput): number | undefined {
  const normalized = typeof value === "number" ? String(value) : value.trim();
  const portText = normalized.startsWith("tcp:") ? normalized.slice(4) : normalized;
  if (!/^\d+$/u.test(portText)) {
    return undefined;
  }
  const port = Number(portText);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

export function tcpEndpoint(value: TcpPortInput): string | undefined {
  const port = parseTcpPort(value);
  return port === undefined ? undefined : `tcp:${String(port)}`;
}

export function normalizePortMapping(
  direction: PortDirection,
  mapping: AdbPortMapping,
): TcpPortMapping {
  return direction === "forward"
    ? {
        direction,
        serial: mapping.serial,
        host: mapping.local,
        device: mapping.remote,
      }
    : {
        direction,
        serial: mapping.serial,
        host: mapping.remote,
        device: mapping.local,
      };
}

export function mappingArguments(
  direction: PortDirection,
  host: string,
  device: string,
): [string, string] {
  return direction === "forward" ? [host, device] : [device, host];
}

export function mappingKey(direction: PortDirection, host: string, device: string): string {
  return `${direction}\0${host}\0${device}`;
}
