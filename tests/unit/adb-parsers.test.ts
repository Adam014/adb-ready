import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  parseAdbDevices,
  parseAdbVersion,
  parseFeatureList,
  parseKeyValueLines,
} from "../../src/adb/parsers.js";

async function fixture(name: string): Promise<string> {
  return await readFile(new URL(`../fixtures/adb/${name}`, import.meta.url), "utf8");
}

describe("parseAdbDevices", () => {
  test("parses mixed transports and preserves unknown details", async () => {
    const devices = parseAdbDevices(await fixture("devices-mixed.txt"));

    expect(devices).toHaveLength(5);
    expect(devices[0]).toMatchObject({
      serial: "35121FDJH000R8",
      state: "device",
      product: "husky_beta",
      model: "Pixel 8 Pro",
      device: "husky",
      transportId: "1",
    });
    expect(devices[1]).toMatchObject({ serial: "emulator-5554", state: "device" });
    expect(devices[2]).toMatchObject({ serial: "192.0.2.42:37199", state: "offline" });
    expect(devices[3]).toMatchObject({
      serial: "adb-ABC123._adb-tls-connect._tcp",
      state: "unauthorized",
      model: "Wireless Device",
    });
    expect(devices[4]).toMatchObject({
      serial: "future-transport",
      state: "unknown",
      properties: { custom: "value" },
      unparsed: ["future-token"],
    });
  });

  test("normalizes the multi-token no-permissions state", async () => {
    const devices = parseAdbDevices(await fixture("devices-no-permissions.txt"));
    expect(devices).toHaveLength(1);
    expect(devices[0]?.state).toBe("no-permissions");
    expect(devices[0]?.unparsed.length).toBeGreaterThan(0);
  });

  test("returns an empty list for a valid empty response", async () => {
    expect(parseAdbDevices(await fixture("devices-empty.txt"))).toEqual([]);
  });

  test("accepts CRLF without changing values", async () => {
    const unix = await fixture("devices-mixed.txt");
    expect(parseAdbDevices(unix.replaceAll("\n", "\r\n"))).toEqual(parseAdbDevices(unix));
  });

  test("does not interpret arbitrary text without the ADB header", () => {
    expect(parseAdbDevices("serial device model:Not_A_Device\n")).toEqual([]);
  });
});

describe("parseAdbVersion", () => {
  test("extracts protocol, Platform-Tools, and installed path", async () => {
    expect(parseAdbVersion(await fixture("version-current.txt"))).toMatchObject({
      protocolVersion: "1.0.41",
      platformToolsVersion: "37.0.0-14910828",
      installedAs: "/opt/android-sdk/platform-tools/adb",
    });
  });

  test("preserves unknown version output", () => {
    expect(parseAdbVersion("future adb output")).toEqual({ raw: "future adb output" });
  });
});

describe("supporting parsers", () => {
  test("normalizes and deduplicates feature lists", () => {
    expect(parseFeatureList("shell_v2,cmd\nmdns,cmd\n")).toEqual(["cmd", "mdns", "shell_v2"]);
  });

  test("parses server status values at the first colon", () => {
    expect(
      parseKeyValueLines("USB backend: libusb\nmDNS backend: Bonjour: native\nignored\n"),
    ).toEqual({
      "USB backend": "libusb",
      "mDNS backend": "Bonjour: native",
    });
  });
});
