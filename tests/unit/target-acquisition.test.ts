import { describe, expect, test } from "bun:test";
import type { AdbMdnsService } from "../../src/adb/parsers.js";
import { planTargetAcquisition } from "../../src/session/target-acquisition.js";

function service(
  serial: string,
  options: { hardwareSerial?: string; instance?: string; knownDevice?: boolean } = {},
): AdbMdnsService {
  const [host, port] = serial.split(":");
  return {
    instance: options.instance ?? `adb-${host}`,
    rawServiceType: "_adb-tls-connect._tcp",
    serviceType: "connect",
    endpoint: { host: host as string, port: Number(port), serial, version: 4 },
    ...(options.hardwareSerial === undefined ? {} : { hardwareSerial: options.hardwareSerial }),
    ...(options.knownDevice === undefined ? {} : { knownDevice: options.knownDevice }),
  };
}

describe("target acquisition planning", () => {
  test("honors an explicit endpoint or endpoint alias before discovery", () => {
    expect(
      planTargetAcquisition({
        selector: "phone",
        aliases: { phone: "192.168.1.8:40404" },
        remembered: { serial: "192.168.1.9:50505" },
        services: [service("192.168.1.10:60606")],
      }),
    ).toMatchObject({
      kind: "connect",
      endpoint: "192.168.1.8:40404",
      discovered: false,
      reason: "explicit-endpoint",
    });
  });

  test("uses stable hardware identity across a rotated wireless port", () => {
    expect(
      planTargetAcquisition({
        remembered: { serial: "192.168.1.8:40000", hardwareSerial: "PHONE-1" },
        services: [
          service("192.168.1.9:41000", { hardwareSerial: "PHONE-2" }),
          service("192.168.1.8:42000", { hardwareSerial: "PHONE-1" }),
        ],
      }),
    ).toMatchObject({
      kind: "connect",
      endpoint: "192.168.1.8:42000",
      discovered: true,
      reason: "remembered-identity",
    });
  });

  test("connects one unambiguous known service but never an unknown pairing state", () => {
    expect(planTargetAcquisition({ services: [service("192.168.1.8:42000")] })).toMatchObject({
      kind: "connect",
      reason: "only-service",
    });
    expect(
      planTargetAcquisition({
        services: [service("192.168.1.8:42000", { knownDevice: false })],
      }),
    ).toEqual({ kind: "none" });
  });

  test("refuses to guess between distinct devices", () => {
    expect(
      planTargetAcquisition({
        services: [service("192.168.1.8:42000"), service("192.168.1.9:43000")],
      }),
    ).toEqual({
      kind: "ambiguous",
      endpoints: ["192.168.1.8:42000", "192.168.1.9:43000"],
    });
  });
});
