import { describe, expect, test } from "bun:test";
import { connect, createServer } from "node:net";
import { ensureLoopbackBridge } from "../../src/dev/loopback-bridge.js";

describe("IPv6 loopback bridge", () => {
  test("does nothing when IPv4 is already reachable", async () => {
    const hosts: string[] = [];
    const result = await ensureLoopbackBridge({
      port: 8081,
      connectPort: async (host) => {
        hosts.push(host);
        return host === "127.0.0.1";
      },
    });
    expect(result).toEqual({ status: "not-needed" });
    expect(hosts).toEqual(["127.0.0.1"]);
  });

  test("does nothing when neither loopback family is reachable", async () => {
    const hosts: string[] = [];
    const result = await ensureLoopbackBridge({
      port: 8081,
      connectPort: async (host) => {
        hosts.push(host);
        return false;
      },
    });
    expect(result).toEqual({ status: "unavailable" });
    expect(hosts).toEqual(["127.0.0.1", "::1"]);
  });

  test("reuses an IPv4 listener that wins the bridge startup race", async () => {
    const existing = createServer();
    await new Promise<void>((resolve) => existing.listen(0, "127.0.0.1", resolve));
    const address = existing.address();
    if (address === null || typeof address === "string") throw new Error("missing test port");
    let probes = 0;

    try {
      const result = await ensureLoopbackBridge({
        port: address.port,
        connectPort: async () => {
          probes += 1;
          return probes > 1;
        },
      });
      expect(result).toEqual({ status: "not-needed" });
      expect(probes).toBe(3);

      probes = 0;
      const opaqueContention = await ensureLoopbackBridge({
        port: address.port,
        connectPort: async () => {
          probes += 1;
          return probes === 2;
        },
      });
      expect(opaqueContention).toEqual({
        status: "failed",
        detail: `The IPv4 loopback bridge could not listen on port ${String(address.port)}.`,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        existing.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  test("forwards an IPv4 client to an IPv6-only service and closes cleanly", async () => {
    const upstream = createServer((socket) => socket.end("bridge-ok"));
    await new Promise<void>((resolve) => upstream.listen(0, "::1", resolve));
    const address = upstream.address();
    if (address === null || typeof address === "string") throw new Error("missing test port");

    const result = await ensureLoopbackBridge({ port: address.port });
    try {
      expect(result.status).toBe("bridged");
      if (result.status !== "bridged") return;
      const body = await new Promise<string>((resolve, reject) => {
        const connection = connect(address.port, "127.0.0.1");
        let value = "";
        connection.setEncoding("utf8");
        connection.on("data", (chunk) => (value += chunk));
        connection.once("end", () => resolve(value));
        connection.once("error", reject);
      });
      expect(body).toBe("bridge-ok");
      await result.bridge.close();
      await result.bridge.close();
    } finally {
      if (result.status === "bridged") await result.bridge.close();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });
});
