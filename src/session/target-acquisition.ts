import type { AdbMdnsService } from "../adb/parsers.js";
import { parseAdbNetworkEndpoint } from "../adb/parsers.js";

export interface RememberedTargetIdentity {
  serial: string;
  hardwareSerial?: string;
}

export interface TargetAcquisitionRequest {
  selector?: string;
  aliases?: Readonly<Record<string, string>>;
  remembered?: RememberedTargetIdentity;
  services: readonly AdbMdnsService[];
}

export type TargetAcquisition =
  | {
      kind: "connect";
      endpoint: string;
      candidates: string[];
      discovered: boolean;
      reason: "explicit-endpoint" | "only-service" | "remembered-endpoint" | "remembered-identity";
    }
  | { kind: "ambiguous"; endpoints: string[] }
  | { kind: "none" };

function serviceCandidates(service: AdbMdnsService): string[] {
  return [
    ...new Set([
      service.endpoint.serial,
      ...(service.alternateEndpoints ?? []).map(({ serial }) => serial),
    ]),
  ].slice(0, 3);
}

function connectable(service: AdbMdnsService): boolean {
  return (
    service.serviceType === "legacy" ||
    (service.serviceType === "connect" && service.knownDevice !== false)
  );
}

function distinctServices(services: readonly AdbMdnsService[]): AdbMdnsService[] {
  const groups = new Map<string, AdbMdnsService>();
  for (const service of services.filter(connectable)) {
    const key = `${service.rawServiceType}\0${service.instance}`;
    groups.set(key, groups.get(key) ?? service);
  }
  return [...groups.values()];
}

export function planTargetAcquisition(request: TargetAcquisitionRequest): TargetAcquisition {
  const resolvedSelector =
    request.selector === undefined
      ? undefined
      : (request.aliases?.[request.selector] ?? request.selector);
  const explicitEndpoint =
    resolvedSelector === undefined ? undefined : parseAdbNetworkEndpoint(resolvedSelector)?.serial;
  if (explicitEndpoint !== undefined) {
    return {
      kind: "connect",
      endpoint: explicitEndpoint,
      candidates: [explicitEndpoint],
      discovered: false,
      reason: "explicit-endpoint",
    };
  }

  const services = distinctServices(request.services);
  const rememberedIdentity = request.remembered?.hardwareSerial;
  if (rememberedIdentity !== undefined) {
    const matches = services.filter(({ hardwareSerial }) => hardwareSerial === rememberedIdentity);
    if (matches.length === 1) {
      const candidates = serviceCandidates(matches[0] as AdbMdnsService);
      return {
        kind: "connect",
        endpoint: candidates[0] as string,
        candidates,
        discovered: true,
        reason: "remembered-identity",
      };
    }
  }

  const rememberedEndpoint = request.remembered?.serial;
  if (rememberedEndpoint !== undefined) {
    const service = services.find((candidate) =>
      serviceCandidates(candidate).includes(rememberedEndpoint),
    );
    if (service !== undefined) {
      const candidates = serviceCandidates(service);
      return {
        kind: "connect",
        endpoint: candidates[0] as string,
        candidates,
        discovered: true,
        reason: "remembered-endpoint",
      };
    }
  }

  if (services.length === 1) {
    const candidates = serviceCandidates(services[0] as AdbMdnsService);
    return {
      kind: "connect",
      endpoint: candidates[0] as string,
      candidates,
      discovered: true,
      reason: "only-service",
    };
  }
  if (services.length > 1) {
    return {
      kind: "ambiguous",
      endpoints: [...new Set(services.flatMap(serviceCandidates))].sort(),
    };
  }

  const parsedRemembered =
    rememberedEndpoint === undefined
      ? undefined
      : parseAdbNetworkEndpoint(rememberedEndpoint)?.serial;
  return parsedRemembered === undefined
    ? { kind: "none" }
    : {
        kind: "connect",
        endpoint: parsedRemembered,
        candidates: [parsedRemembered],
        discovered: false,
        reason: "remembered-endpoint",
      };
}
