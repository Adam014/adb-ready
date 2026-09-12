import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  type AdbDevice,
  parseAdbDevices,
  parseAdbMdnsServices,
  parseAdbMdnsTrackServices,
  parseAdbNetworkEndpoint,
} from "../../src/adb/parsers.js";
import {
  buildTargetInventory,
  correlateMdnsTransportIdentities,
  isStableAdbSerial,
} from "../../src/target/model.js";
import { selectTarget } from "../../src/target/selection.js";

const fixture = (name: string) =>
  readFile(fileURLToPath(new URL(`../fixtures/adb/${name}`, import.meta.url)), "utf8");

function device(serial: string, overrides: Partial<AdbDevice> = {}): AdbDevice {
  return { serial, state: "device", properties: {}, unparsed: [], ...overrides };
}

describe("ADB network discovery", () => {
  test("parses legacy, pairing, connect, IPv4, and bracketed IPv6 services", async () => {
    const services = parseAdbMdnsServices(await fixture("mdns-services.txt"));

    expect(services).toHaveLength(4);
    expect(services.map(({ serviceType }) => serviceType)).toEqual([
      "connect",
      "connect",
      "legacy",
      "pairing",
    ]);
    expect(services.find(({ endpoint }) => endpoint.version === 6)?.endpoint.serial).toBe(
      "[fd00::1234]:37123",
    );
    expect(services.some(({ endpoint }) => endpoint.host === "0.0.0.0")).toBe(false);
  });

  test("rejects malformed, unspecified, and out-of-range endpoints", () => {
    expect(parseAdbNetworkEndpoint("0.0.0.0:1234")).toBeUndefined();
    expect(parseAdbNetworkEndpoint("[::]:1234")).toBeUndefined();
    expect(parseAdbNetworkEndpoint("192.168.1.300:1234")).toBeUndefined();
    expect(parseAdbNetworkEndpoint("192.168.1.2:70000")).toBeUndefined();
    expect(parseAdbNetworkEndpoint("[not-an-ipv6-address]:1234")).toBeUndefined();
    expect(parseAdbNetworkEndpoint("[fd00::1 value]:1234")).toBeUndefined();
    expect(parseAdbNetworkEndpoint("pixel.local:37123")).toEqual({
      host: "pixel.local",
      port: 37123,
      serial: "pixel.local:37123",
      version: "hostname",
    });
  });

  test("parses ADB 37 textproto discovery metadata with IPv6 alternatives", async () => {
    const services = parseAdbMdnsTrackServices(await fixture("mdns-track-services.txt"));

    expect(services).toHaveLength(2);
    expect(services[0]).toMatchObject({
      serviceType: "connect",
      endpoint: { serial: "192.168.84.23:37895" },
      alternateEndpoints: [
        { serial: "[fe80::fc7a:299d:8d38:6c1c]:37895" },
        { serial: "Android_CXUKYJY1.local:37895" },
      ],
      deviceModel: "Pixel 8",
      givenName: "Ada Pixel",
      hardwareSerial: "35121FDJH000R8",
      mdnsServiceVersion: "2.0",
      knownDevice: true,
    });
    expect(services[1]).toMatchObject({
      serviceType: "pairing",
      endpoint: { serial: "[fd00::1234]:41234" },
      deviceModel: "Pixel 8",
    });
  });
});

describe("target inventory", () => {
  test("deduplicates transports only with observed hardware identity", async () => {
    const services = parseAdbMdnsServices(await fixture("mdns-services.txt"));
    const inventory = buildTargetInventory(
      [
        {
          device: device("R5CT-001", { model: "Pixel 9", usb: "1-1" }),
          hardwareSerial: "R5CT-001",
        },
        { device: device("192.168.86.38:33015", { model: "Pixel 9" }), hardwareSerial: "R5CT-001" },
        { device: device("emulator-5554", { model: "SDK phone" }) },
      ],
      services,
    );

    expect(inventory.targets).toHaveLength(2);
    const physical = inventory.targets.find(({ hardwareSerial }) => hardwareSerial === "R5CT-001");
    expect(physical?.serial).toBe("R5CT-001");
    expect(physical?.transports.map(({ kind }) => kind)).toEqual(["usb", "tls"]);
    expect(
      inventory.targets.find(({ serial }) => serial === "emulator-5554")?.transports[0]?.kind,
    ).toBe("emulator");
  });

  test("correlates an mDNS transport whose Bonjour instance has a collision suffix", async () => {
    const devices = parseAdbDevices(await fixture("devices-mdns-collision.txt"));
    const services = parseAdbMdnsServices(await fixture("mdns-collision.txt"));
    const correlated = correlateMdnsTransportIdentities(
      devices.map((observed) => ({
        device: observed,
        ...(observed.serial === "192.0.2.42:37199" ? { hardwareSerial: "PHONE-1" } : {}),
      })),
      services,
    );
    const inventory = buildTargetInventory(correlated, services);

    expect(inventory.targets).toHaveLength(1);
    expect(inventory.targets[0]).toMatchObject({
      hardwareSerial: "PHONE-1",
      serial: "192.0.2.42:37199",
      state: "device",
    });
    expect(inventory.targets[0]?.transports.map(({ serial }) => serial)).toEqual([
      "192.0.2.42:37199",
      "adb-EXAMPLE-random (2)._adb-tls-connect._tcp",
    ]);
    expect(inventory.targets[0]?.transports.map(({ kind }) => kind)).toEqual(["tls", "tls"]);
  });

  test("never treats mDNS service names or unspecified addresses as stable serials", () => {
    expect(isStableAdbSerial("adb-123._adb-tls-connect._tcp.")).toBe(false);
    expect(isStableAdbSerial("0.0.0.0:5555")).toBe(false);
    expect(isStableAdbSerial("[::]:5555")).toBe(false);
    expect(isStableAdbSerial("192.168.1.2:37123")).toBe(true);
  });
});

describe("target selection", () => {
  const inventory = buildTargetInventory([
    { device: device("USB-1", { model: "Pixel" }) },
    { device: device("emulator-5554", { model: "Emulator" }) },
  ]);

  test("requires a decision when multiple ready targets exist", () => {
    const result = selectTarget(inventory.targets);
    expect(result.kind).toBe("ambiguous");
  });

  test("honors explicit serial, alias, transport ID, then remembered serial", () => {
    const withTransport = buildTargetInventory([
      { device: device("USB-1", { transportId: "7" }) },
      { device: device("emulator-5554") },
    ]);
    expect(selectTarget(withTransport.targets, { selector: "USB-1" })).toMatchObject({
      kind: "selected",
      selection: { reason: "explicit", transport: { serial: "USB-1" } },
    });
    expect(
      selectTarget(withTransport.targets, { selector: "phone", aliases: { phone: "USB-1" } }),
    ).toMatchObject({ kind: "selected", selection: { reason: "alias" } });
    expect(selectTarget(withTransport.targets, { transportId: "7" })).toMatchObject({
      kind: "selected",
      selection: { reason: "transport-id" },
    });
    expect(
      selectTarget(withTransport.targets, { rememberedSerial: "emulator-5554" }),
    ).toMatchObject({
      kind: "selected",
      selection: { reason: "remembered" },
    });
  });

  test("does not select offline or unstable explicit transports", () => {
    const unavailable = buildTargetInventory([
      { device: device("192.168.1.2:37123", { state: "offline" }) },
    ]);
    expect(selectTarget(unavailable.targets, { selector: "192.168.1.2:37123" }).kind).toBe(
      "unavailable",
    );

    const unstable = buildTargetInventory([{ device: device("adb-123._adb-tls-connect._tcp.") }]);
    expect(selectTarget(unstable.targets).kind).toBe("none");
  });

  test("never falls back when remembered-only selection cannot be satisfied", () => {
    expect(
      selectTarget(inventory.targets, {
        rememberedSerial: "missing",
        rememberedOnly: true,
      }),
    ).toMatchObject({ kind: "not-found", selector: "remembered target" });
    expect(selectTarget(inventory.targets, { rememberedOnly: true })).toMatchObject({
      kind: "not-found",
    });
  });

  test("recovers a remembered wireless target after its port rotates", () => {
    const targets = buildTargetInventory([
      {
        device: device("192.168.86.38:44191", { transportId: "9" }),
        hardwareSerial: "PHONE-1",
      },
      {
        device: device("USB-1", { transportId: "10", usb: "1-1" }),
        hardwareSerial: "PHONE-1",
      },
    ]).targets;

    const selection = selectTarget(targets, {
      rememberedSerial: "192.168.86.38:33015",
      rememberedHardwareSerial: "PHONE-1",
      rememberedOnly: true,
    });

    expect(selection).toMatchObject({
      kind: "selected",
      selection: {
        reason: "remembered-identity",
        transport: { serial: "192.168.86.38:44191", kind: "tcp" },
      },
    });
  });

  test("requires transport ID when one serial has duplicate ready transports", () => {
    const duplicate = buildTargetInventory([
      { device: device("USB-1", { transportId: "7" }) },
      { device: device("USB-1", { transportId: "9" }) },
    ]);

    expect(selectTarget(duplicate.targets)).toMatchObject({ kind: "duplicate" });
    expect(selectTarget(duplicate.targets, { selector: "USB-1" })).toMatchObject({
      kind: "duplicate",
    });
    expect(selectTarget(duplicate.targets, { transportId: "9" })).toMatchObject({
      kind: "selected",
      selection: { transport: { transportId: "9" } },
    });
  });

  test("fails closed across transport, target-id, and remembered-identity edge cases", () => {
    const ready = buildTargetInventory([
      {
        device: device("USB-1", { transportId: "7" }),
        hardwareSerial: "PHONE-1",
      },
    ]).targets[0];
    const offline = buildTargetInventory([
      {
        device: device("USB-2", { state: "offline", transportId: "8" }),
        hardwareSerial: "PHONE-2",
      },
    ]).targets[0];
    expect(ready).toBeDefined();
    expect(offline).toBeDefined();
    if (ready === undefined || offline === undefined) throw new Error("Expected target fixtures");

    expect(selectTarget([offline], { transportId: "8" })).toMatchObject({ kind: "unavailable" });
    expect(selectTarget([ready], { transportId: "missing" })).toEqual({
      kind: "not-found",
      selector: "missing",
    });
    expect(selectTarget([ready], { selector: ready.id })).toMatchObject({
      kind: "selected",
      selection: { reason: "explicit" },
    });
    expect(selectTarget([offline], { selector: offline.id })).toMatchObject({
      kind: "unavailable",
    });

    const duplicate = buildTargetInventory([
      { device: device("USB-3", { transportId: "11" }) },
      { device: device("USB-3", { transportId: "12" }) },
    ]).targets;
    expect(selectTarget(duplicate, { rememberedSerial: "USB-3" })).toMatchObject({
      kind: "duplicate",
    });
    const duplicateTarget = duplicate[0];
    expect(duplicateTarget).toBeDefined();
    if (duplicateTarget === undefined) throw new Error("Expected duplicate target fixture");
    expect(selectTarget(duplicate, { selector: duplicateTarget.id })).toMatchObject({
      kind: "duplicate",
    });

    const sameIdentity = [
      { ...ready, id: "ready-copy", serial: "USB-4" },
      { ...ready, id: "ready-copy-2", serial: "USB-5" },
    ];
    expect(
      selectTarget(sameIdentity, {
        rememberedSerial: "missing",
        rememberedHardwareSerial: "PHONE-1",
      }),
    ).toMatchObject({ kind: "ambiguous" });
    expect(selectTarget(sameIdentity, { rememberedHardwareSerial: "PHONE-1" })).toMatchObject({
      kind: "ambiguous",
    });

    expect(
      selectTarget([offline], {
        rememberedSerial: "missing",
        rememberedHardwareSerial: "PHONE-2",
        rememberedOnly: true,
      }),
    ).toMatchObject({ kind: "unavailable" });
    expect(
      selectTarget([offline], { rememberedSerial: "USB-2", rememberedOnly: true }),
    ).toMatchObject({ kind: "unavailable" });
    expect(selectTarget([ready], { rememberedHardwareSerial: "PHONE-1" })).toMatchObject({
      kind: "selected",
      selection: { reason: "remembered-identity" },
    });
    expect(
      selectTarget([offline], { rememberedHardwareSerial: "PHONE-2", rememberedOnly: true }),
    ).toMatchObject({ kind: "unavailable" });
    expect(
      selectTarget([ready], { rememberedHardwareSerial: "missing", rememberedOnly: true }),
    ).toEqual({ kind: "not-found", selector: "remembered target" });
    expect(selectTarget([ready])).toMatchObject({
      kind: "selected",
      selection: { reason: "only-ready" },
    });
  });
});
