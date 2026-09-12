import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  parseAdbDevices,
  parseAdbPortMappings,
  parseAdbVersion,
  parseAndroidPackages,
  parseFeatureList,
  parseKeyValueLines,
  parseLogcatThreadtimeLine,
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

  test("preserves a Bonjour collision suffix inside an mDNS transport serial", async () => {
    const devices = parseAdbDevices(await fixture("devices-mdns-collision.txt"));

    expect(devices).toHaveLength(2);
    expect(devices[1]).toMatchObject({
      serial: "adb-EXAMPLE-random (2)._adb-tls-connect._tcp",
      state: "device",
      model: "Example Phone",
      transportId: "1",
      unparsed: [],
    });
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

describe("future command boundary parsers", () => {
  test("parses the documented forward and reverse list shape", async () => {
    expect(parseAdbPortMappings(await fixture("port-mappings.txt"))).toEqual([
      { serial: "R5CT-001", local: "tcp:8081", remote: "tcp:8081" },
      {
        serial: "emulator-5554",
        local: "tcp:9229",
        remote: "localabstract:chrome_devtools_remote",
      },
      { serial: "host", local: "tcp:3000", remote: "tcp:3000" },
    ]);
  });

  test("parses package names with and without source paths", async () => {
    expect(parseAndroidPackages(await fixture("packages.txt"))).toEqual([
      { name: "com.example.alpha" },
      {
        name: "com.example.beta",
        sourcePath: "/data/app/~~token/com.example.beta/base.apk",
      },
    ]);
  });

  test("parses threadtime log records while preserving unmatched raw lines", async () => {
    const lines = (await fixture("logcat-threadtime.txt")).trimEnd().split("\n");
    expect(parseLogcatThreadtimeLine(lines[0] ?? "")).toMatchObject({
      timestamp: "09-10 08:15:30.123",
      pid: 1234,
      tid: 1250,
      priority: "I",
      tag: "ActivityManager",
      message: "Start proc com.example.alpha",
    });
    expect(parseLogcatThreadtimeLine(lines[1] ?? "")).toMatchObject({
      timestamp: "2026-09-10 08:15:31.456",
      priority: "E",
      tag: "ReactNativeJS",
    });
    expect(parseLogcatThreadtimeLine(lines[2] ?? "")).toBeUndefined();
  });
});
