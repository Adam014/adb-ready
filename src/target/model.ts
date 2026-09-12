import type { AdbDevice, AdbDeviceState, AdbMdnsService } from "../adb/parsers.js";
import { parseAdbNetworkEndpoint } from "../adb/parsers.js";

export type TargetTransportKind = "emulator" | "tcp" | "tls" | "usb" | "unknown";

export interface TargetObservation {
  device: AdbDevice;
  hardwareSerial?: string;
}

export interface TargetTransport {
  serial: string;
  state: AdbDeviceState;
  kind: TargetTransportKind;
  transportId?: string;
  endpoint?: string;
  stable: boolean;
}

export interface AndroidTarget {
  id: string;
  serial: string;
  state: AdbDeviceState;
  name: string;
  hardwareSerial?: string;
  product?: string;
  device?: string;
  transports: TargetTransport[];
}

export interface TargetInventory {
  targets: AndroidTarget[];
  services: AdbMdnsService[];
}

export function isMdnsServiceSerial(serial: string): boolean {
  return /\._adb(?:-tls-(?:connect|pairing))?\._tcp(?:\.|$)/iu.test(serial);
}

export function isStableAdbSerial(serial: string): boolean {
  if (
    serial.trim() !== serial ||
    serial === "" ||
    /\s/u.test(serial) ||
    isMdnsServiceSerial(serial)
  ) {
    return false;
  }
  if (serial.startsWith("0.0.0.0:") || serial.startsWith("[::]:")) {
    return false;
  }
  return true;
}

function normalizedServiceSerial(value: string): string {
  return value.trim().replace(/\.+$/u, "");
}

function serviceSerial(service: AdbMdnsService): string {
  return normalizedServiceSerial(`${service.instance}.${service.rawServiceType}`);
}

/**
 * Correlates transient mDNS transports only through the exact advertised
 * service and an endpoint whose hardware identity was observed directly.
 * Incomplete or ambiguous evidence is intentionally left unresolved.
 */
export function correlateMdnsTransportIdentities(
  observations: readonly TargetObservation[],
  services: readonly AdbMdnsService[],
): TargetObservation[] {
  const identityByEndpoint = new Map<string, Set<string>>();
  for (const observation of observations) {
    const hardwareSerial = observation.hardwareSerial?.trim();
    const endpoint = parseAdbNetworkEndpoint(observation.device.serial);
    if (hardwareSerial === undefined || hardwareSerial === "" || endpoint === undefined) continue;
    const identities = identityByEndpoint.get(endpoint.serial) ?? new Set<string>();
    identities.add(hardwareSerial);
    identityByEndpoint.set(endpoint.serial, identities);
  }

  return observations.map((observation) => {
    if (
      observation.hardwareSerial !== undefined ||
      !isMdnsServiceSerial(observation.device.serial)
    ) {
      return observation;
    }
    const matchingServices = services.filter(
      (service) => serviceSerial(service) === normalizedServiceSerial(observation.device.serial),
    );
    const identities = new Set<string>();
    for (const service of matchingServices) {
      const advertisedIdentity = service.hardwareSerial?.trim();
      if (advertisedIdentity !== undefined && advertisedIdentity !== "") {
        identities.add(advertisedIdentity);
      }
      for (const endpoint of [service.endpoint, ...(service.alternateEndpoints ?? [])]) {
        for (const identity of identityByEndpoint.get(endpoint.serial) ?? []) {
          identities.add(identity);
        }
      }
    }
    const [hardwareSerial] = identities;
    return identities.size === 1 && hardwareSerial !== undefined
      ? { ...observation, hardwareSerial }
      : observation;
  });
}

function transportKind(
  device: AdbDevice,
  services: readonly AdbMdnsService[],
): TargetTransportKind {
  if (/^emulator-\d+$/u.test(device.serial)) {
    return "emulator";
  }
  const endpoint = parseAdbNetworkEndpoint(device.serial);
  if (endpoint !== undefined) {
    return services.some(
      (service) => service.serviceType === "connect" && service.endpoint.serial === endpoint.serial,
    )
      ? "tls"
      : "tcp";
  }
  if (isMdnsServiceSerial(device.serial)) {
    if (/\._adb-tls-connect\._tcp(?:\.|$)/iu.test(device.serial)) return "tls";
    if (/\._adb\._tcp(?:\.|$)/iu.test(device.serial)) return "tcp";
    return "unknown";
  }
  if (device.usb !== undefined || device.serial !== "") {
    return "usb";
  }
  return "unknown";
}

const TRANSPORT_PRIORITY: Record<TargetTransportKind, number> = {
  usb: 0,
  emulator: 1,
  tls: 2,
  tcp: 3,
  unknown: 4,
};

function statePriority(state: AdbDeviceState): number {
  return state === "device" ? 0 : state === "unauthorized" ? 1 : state === "offline" ? 2 : 3;
}

function compareTransports(left: TargetTransport, right: TargetTransport): number {
  return (
    statePriority(left.state) - statePriority(right.state) ||
    Number(!left.stable) - Number(!right.stable) ||
    TRANSPORT_PRIORITY[left.kind] - TRANSPORT_PRIORITY[right.kind] ||
    left.serial.localeCompare(right.serial)
  );
}

function groupKey(observation: TargetObservation): string {
  const hardwareSerial = observation.hardwareSerial?.trim();
  return hardwareSerial === undefined || hardwareSerial === ""
    ? `adb:${observation.device.serial}`
    : `hardware:${hardwareSerial}`;
}

export function buildTargetInventory(
  observations: readonly TargetObservation[],
  services: readonly AdbMdnsService[] = [],
): TargetInventory {
  const groups = new Map<string, TargetObservation[]>();
  for (const observation of observations) {
    const key = groupKey(observation);
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }

  const targets = [...groups.entries()].map(([id, group]): AndroidTarget => {
    const transports = group
      .map(({ device }): TargetTransport => {
        const endpoint = parseAdbNetworkEndpoint(device.serial);
        return {
          serial: device.serial,
          state: device.state,
          kind: transportKind(device, services),
          stable: isStableAdbSerial(device.serial),
          ...(device.transportId === undefined ? {} : { transportId: device.transportId }),
          ...(endpoint === undefined ? {} : { endpoint: endpoint.serial }),
        };
      })
      .sort(compareTransports);
    const canonical = transports[0];
    const representative =
      group.find(({ device }) => device.serial === canonical?.serial)?.device ?? group[0]?.device;
    if (canonical === undefined || representative === undefined) {
      throw new Error("Target grouping produced an empty target");
    }
    const hardwareSerial = group
      .find(({ hardwareSerial }) => hardwareSerial?.trim())
      ?.hardwareSerial?.trim();
    return {
      id,
      serial: canonical.serial,
      state: canonical.state,
      name: representative.model ?? representative.product ?? hardwareSerial ?? canonical.serial,
      ...(hardwareSerial === undefined ? {} : { hardwareSerial }),
      ...(representative.product === undefined ? {} : { product: representative.product }),
      ...(representative.device === undefined ? {} : { device: representative.device }),
      transports,
    };
  });

  return {
    targets: targets.sort((left, right) => left.id.localeCompare(right.id)),
    services: [...services],
  };
}
