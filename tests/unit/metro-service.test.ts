import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { probeMetroService } from "../../src/dev/metro-service.js";

describe("probeMetroService", () => {
  test("recognizes a real loopback Metro status endpoint", async () => {
    let port: number | undefined;
    const server = createServer((request, response) => {
      if (request.url === "/status") {
        response.writeHead(200, {
          "content-type": "text/plain",
          "x-react-native-project-root": encodeURI(process.cwd()),
        });
        response.end("packager-status:running");
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      port = address.port;
      expect(
        await probeMetroService({
          host: "127.0.0.1",
          port,
          expectedProjectRoot: process.cwd(),
        }),
      ).toMatchObject({ status: "available" });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
    if (port === undefined) throw new Error("missing closed test port");
    expect(await probeMetroService({ host: "127.0.0.1", port })).toMatchObject({
      status: "unavailable",
    });
  });

  test("attaches only to the exact Metro status contract", async () => {
    const result = await probeMetroService({
      host: "127.0.0.1",
      port: 8081,
      connectPort: async () => true,
      fetchStatus: async (url) => {
        expect(url).toBe("http://127.0.0.1:8081/status");
        return {
          status: 200,
          body: "packager-status:running\n",
          projectRoot: "/workspace/app",
        };
      },
      expectedProjectRoot: "/workspace/app",
    });

    expect(result).toEqual({ status: "available", endpoint: "http://127.0.0.1:8081" });
  });

  test("refuses to attach when Metro cannot prove the current project root", async () => {
    const base = {
      host: "127.0.0.1",
      port: 8081,
      expectedProjectRoot: "/workspace/current app",
      connectPort: async () => true,
    } as const;

    expect(
      await probeMetroService({
        ...base,
        fetchStatus: async () => ({ status: 200, body: "packager-status:running" }),
      }),
    ).toMatchObject({
      status: "occupied",
      detail: "Metro did not identify its project root, so ADB Ready cannot attach safely.",
    });
    expect(
      await probeMetroService({
        ...base,
        fetchStatus: async () => ({
          status: 200,
          body: "packager-status:running",
          projectRoot: "/workspace/another-app",
        }),
      }),
    ).toMatchObject({
      status: "occupied",
      detail: "Metro belongs to a different project root.",
    });
    expect(
      await probeMetroService({
        ...base,
        fetchStatus: async () => ({
          status: 200,
          body: "packager-status:running",
          projectRoot: "/workspace/current%20app",
        }),
      }),
    ).toMatchObject({ status: "available" });
  });

  test("distinguishes an unused port from a non-Metro service", async () => {
    const unavailable = await probeMetroService({
      host: "127.0.0.1",
      port: 8081,
      connectPort: async () => false,
      fetchStatus: async () => {
        throw new Error("must not fetch a closed port");
      },
    });
    const occupied = await probeMetroService({
      host: "127.0.0.1",
      port: 8081,
      connectPort: async () => true,
      fetchStatus: async () => ({ status: 200, body: "another-service" }),
    });

    expect(unavailable.status).toBe("unavailable");
    expect(occupied).toMatchObject({
      status: "occupied",
      detail: "The service did not return Metro's running status.",
    });
    expect(
      await probeMetroService({
        host: "127.0.0.1",
        port: 8081,
        connectPort: async () => true,
        fetchStatus: async () => ({ status: 503, body: "unavailable" }),
      }),
    ).toMatchObject({
      status: "occupied",
      detail: "The Metro status endpoint returned HTTP 503.",
    });
    expect(
      await probeMetroService({
        host: "127.0.0.1",
        port: 8081,
        connectPort: async () => true,
        fetchStatus: async () => {
          throw new Error("not HTTP");
        },
      }),
    ).toMatchObject({
      status: "occupied",
      detail: "The port is open, but its service did not complete the Metro status probe.",
    });
  });

  test("honors cancellation and validates its timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await probeMetroService({ host: "127.0.0.1", port: 8081, signal: controller.signal }),
    ).toMatchObject({ status: "aborted" });
    expect(probeMetroService({ host: "127.0.0.1", port: 8081, timeoutMs: 0 })).rejects.toThrow(
      "positive integer",
    );

    const duringConnect = new AbortController();
    const pending = probeMetroService({
      host: "127.0.0.1",
      port: 8081,
      signal: duringConnect.signal,
      connectPort: async (_host, _port, signal) =>
        await new Promise<boolean>((resolve) => {
          signal.addEventListener("abort", () => resolve(false), { once: true });
        }),
    });
    duringConnect.abort();
    expect(await pending).toMatchObject({ status: "aborted" });

    expect(
      await probeMetroService({
        host: "127.0.0.1",
        port: 8081,
        timeoutMs: 1,
        connectPort: async (_host, _port, signal) =>
          await new Promise<boolean>((resolve) => {
            signal.addEventListener("abort", () => resolve(false), { once: true });
          }),
      }),
    ).toMatchObject({ status: "unavailable" });
  });
});
