import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type Server } from "node:net";
import { adbProtocolVersion, probeRemoteAdbServer } from "../../src/adb/remote-server-probe.js";

async function listeningServer(
  response?: string,
): Promise<{ host: string; port: number; requests: string[]; server: Server }> {
  const requests: string[] = [];
  const server = createServer((socket) => {
    socket.once("data", (chunk) => {
      requests.push(chunk.toString("ascii"));
      if (response !== undefined) socket.end(response, "ascii");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("TCP fixture did not bind");
  return { host: "127.0.0.1", port: address.port, requests, server };
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

describe("remote ADB server safety preflight", () => {
  test("parses the local ADB protocol version without guessing unknown formats", () => {
    expect(adbProtocolVersion("1.0.41")).toBe(41);
    expect(adbProtocolVersion("37.0.0")).toBeUndefined();
    expect(adbProtocolVersion("1.0.999999")).toBeUndefined();
  });

  test("rejects invalid probe bounds before opening a socket", async () => {
    const base = {
      host: "127.0.0.1",
      port: 5037,
      expectedProtocolVersion: 41,
      timeoutMs: 1_000,
    };
    await expect(probeRemoteAdbServer({ ...base, host: " " })).rejects.toThrow("host");
    await expect(probeRemoteAdbServer({ ...base, port: 0 })).rejects.toThrow("port");
    await expect(probeRemoteAdbServer({ ...base, expectedProtocolVersion: -1 })).rejects.toThrow(
      "protocol",
    );
    await expect(probeRemoteAdbServer({ ...base, timeoutMs: 0 })).rejects.toThrow("timeout");
  });

  test("accepts one matching read-only host:version response", async () => {
    const fixture = await listeningServer("OKAY00040029");
    try {
      const result = await probeRemoteAdbServer({
        host: fixture.host,
        port: fixture.port,
        expectedProtocolVersion: 41,
        timeoutMs: 1_000,
      });
      expect(result).toEqual({ ok: true, protocolVersion: 41 });
      expect(fixture.requests).toEqual(["000chost:version"]);
    } finally {
      await close(fixture.server);
    }
  });

  test("refuses a mismatched server without sending host:kill", async () => {
    const fixture = await listeningServer("OKAY00040028");
    try {
      const result = await probeRemoteAdbServer({
        host: fixture.host,
        port: fixture.port,
        expectedProtocolVersion: 41,
        timeoutMs: 1_000,
      });
      expect(result).toMatchObject({
        ok: false,
        kind: "protocol-mismatch",
        expectedProtocolVersion: 41,
        actualProtocolVersion: 40,
      });
      expect(fixture.requests).toEqual(["000chost:version"]);
      expect(fixture.requests.join("")).not.toContain("host:kill");
    } finally {
      await close(fixture.server);
    }
  });

  test("classifies rejected, malformed, closed, and timed-out endpoints", async () => {
    for (const [response, kind] of [
      ["FAIL0004nope", "rejected"],
      ["NOPE", "invalid-response"],
      ["OKAYzzzz", "invalid-response"],
      ["OKAY0004nope", "invalid-response"],
      ["OKAY1001", "invalid-response"],
      [`OKAY1000${"x".repeat(4_097)}`, "invalid-response"],
      ["", "invalid-response"],
    ] as const) {
      const fixture = await listeningServer(response);
      try {
        expect(
          await probeRemoteAdbServer({
            host: fixture.host,
            port: fixture.port,
            expectedProtocolVersion: 41,
            timeoutMs: 1_000,
          }),
        ).toMatchObject({ ok: false, kind });
      } finally {
        await close(fixture.server);
      }
    }

    const fixture = await listeningServer();
    try {
      expect(
        await probeRemoteAdbServer({
          host: fixture.host,
          port: fixture.port,
          expectedProtocolVersion: 41,
          timeoutMs: 20,
        }),
      ).toMatchObject({ ok: false, kind: "timeout" });
    } finally {
      await close(fixture.server);
    }

    const activeFixture = await listeningServer();
    const controller = new AbortController();
    try {
      const pending = probeRemoteAdbServer({
        host: activeFixture.host,
        port: activeFixture.port,
        expectedProtocolVersion: 41,
        timeoutMs: 1_000,
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort();
      expect(await pending).toMatchObject({ ok: false, kind: "cancelled" });
    } finally {
      await close(activeFixture.server);
    }
  });

  test("distinguishes cancellation and an unreachable route before ADB runs", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    expect(
      await probeRemoteAdbServer({
        host: "127.0.0.1",
        port: 1,
        expectedProtocolVersion: 41,
        timeoutMs: 1_000,
        signal: cancelled.signal,
      }),
    ).toMatchObject({ ok: false, kind: "cancelled" });

    const fixture = await listeningServer("OKAY00040029");
    const port = fixture.port;
    await close(fixture.server);
    expect(
      await probeRemoteAdbServer({
        host: "127.0.0.1",
        port,
        expectedProtocolVersion: 41,
        timeoutMs: 1_000,
      }),
    ).toMatchObject({ ok: false, kind: "unreachable" });
  });
});
