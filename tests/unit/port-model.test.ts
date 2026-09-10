import { describe, expect, test } from "bun:test";
import {
  mappingArguments,
  normalizePortMapping,
  parseTcpPort,
  tcpEndpoint,
} from "../../src/ports/model.js";

describe("TCP port model", () => {
  test("accepts safe numeric ports and canonical tcp endpoints", () => {
    expect(parseTcpPort("8081")).toBe(8081);
    expect(parseTcpPort("tcp:3000")).toBe(3000);
    expect(tcpEndpoint(9229)).toBe("tcp:9229");
  });

  test("rejects zero, overflow, whitespace, and non-TCP endpoint types", () => {
    for (const value of ["0", "65536", "8 081", "tcp:0", "udp:8081", "1.5", "-1"]) {
      expect(parseTcpPort(value)).toBeUndefined();
    }
  });

  test("keeps host and device meaning stable across ADB direction terminology", () => {
    const raw = { serial: "R5CT-001", local: "tcp:8081", remote: "tcp:3000" };
    expect(normalizePortMapping("forward", raw)).toEqual({
      direction: "forward",
      serial: "R5CT-001",
      host: "tcp:8081",
      device: "tcp:3000",
    });
    expect(normalizePortMapping("reverse", raw)).toEqual({
      direction: "reverse",
      serial: "R5CT-001",
      host: "tcp:3000",
      device: "tcp:8081",
    });
    expect(mappingArguments("forward", "tcp:8081", "tcp:3000")).toEqual(["tcp:8081", "tcp:3000"]);
    expect(mappingArguments("reverse", "tcp:8081", "tcp:3000")).toEqual(["tcp:3000", "tcp:8081"]);
  });
});
