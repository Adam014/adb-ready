import { describe, expect, test } from "bun:test";
import type { AdbMdnsService } from "../../src/adb/parsers.js";
import { planTargetAcquisition } from "../../src/session/target-acquisition.js";

function service(
  serial: string,
  options: {
    hardwareSerial?: string;
    instance?: string;
    knownDevice?: boolean;
    alternateSerial?: string;
  } = {},
): AdbMdnsService {
  const [host, port] = serial.split(":");
  return {
    instance: options.instance ?? `adb-${host}`,
    rawServiceType: "_adb-tls-connect._tcp",
    serviceType: "connect",
    endpoint: { host: host as string, port: Number(port), serial, version: 4 },
    ...(options.alternateSerial === undefined
      ? {}
      : {
          alternateEndpoints: [
            {
              host: options.alternateSerial.split(":")[0] as string,
              port: Number(options.alternateSerial.split(":")[1]),
              serial: options.alternateSerial,
              version: 4 as const,
            },
          ],
        }),
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

  test("uses a remembered alternate endpoint and keeps all connection candidates", () => {
    expect(
      planTargetAcquisition({
        remembered: { serial: "device.local:42000" },
        services: [service("192.168.1.8:42000", { alternateSerial: "device.local:42000" })],
      }),
    ).toEqual({
      kind: "connect",
      endpoint: "192.168.1.8:42000",
      candidates: ["192.168.1.8:42000", "device.local:42000"],
      discovered: true,
      reason: "remembered-endpoint",
    });
  });

  test("falls back to a valid remembered endpoint when discovery finds nothing", () => {
    expect(
      planTargetAcquisition({
        remembered: { serial: "192.168.1.8:42000" },
        services: [],
      }),
    ).toEqual({
      kind: "connect",
      endpoint: "192.168.1.8:42000",
      candidates: ["192.168.1.8:42000"],
      discovered: false,
      reason: "remembered-endpoint",
    });
    expect(
      planTargetAcquisition({ remembered: { serial: "not-an-endpoint" }, services: [] }),
    ).toEqual({ kind: "none" });
  });

  test("does not guess when a remembered identity matches multiple services", () => {
    expect(
      planTargetAcquisition({
        remembered: { serial: "old.local:40000", hardwareSerial: "PHONE-1" },
        services: [
          service("192.168.1.8:42000", { hardwareSerial: "PHONE-1" }),
          service("192.168.1.9:43000", { hardwareSerial: "PHONE-1" }),
        ],
      }),
    ).toMatchObject({ kind: "ambiguous" });
  });

  test("deduplicates repeated records for one discovered service", () => {
    const first = service("192.168.1.8:42000", { instance: "adb-phone" });
    const duplicate = service("192.168.1.8:43000", { instance: "adb-phone" });

    expect(planTargetAcquisition({ services: [first, duplicate] })).toMatchObject({
      kind: "connect",
      endpoint: "192.168.1.8:42000",
      reason: "only-service",
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
