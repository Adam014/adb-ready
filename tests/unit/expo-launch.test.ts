import { describe, expect, test } from "bun:test";
import { resolveExpoLaunch } from "../../src/dev/expo-launch.js";

describe("resolveExpoLaunch", () => {
  test("uses Expo's link endpoint and routes a LAN URL through adb reverse", async () => {
    const requested: string[] = [];
    const resolution = await resolveExpoLaunch({
      endpoint: "http://127.0.0.1:8081",
      runtime: "expo",
      devicePort: 8081,
      request: async (url) => {
        requested.push(url);
        return {
          status: 307,
          body: "",
          location: "exp://192.168.1.20:8081",
        };
      },
    });

    expect(resolution).toEqual({
      status: "resolved",
      target: {
        url: "exp://127.0.0.1:8081",
        runtime: "expo",
        source: "link",
      },
    });
    expect(requested).toHaveLength(1);
    const link = new URL(requested[0] ?? "");
    expect(link.pathname).toBe("/_expo/link");
    expect(link.searchParams.get("platform")).toBe("android");
    expect(link.searchParams.has("choice")).toBe(false);
  });

  test("rewrites the nested dev-client manifest URL but preserves its scheme", async () => {
    const resolution = await resolveExpoLaunch({
      endpoint: "http://127.0.0.1:19000",
      runtime: "custom",
      devicePort: 8081,
      request: async () => ({
        status: 307,
        body: "",
        location: "demo://expo-development-client/?url=http%3A%2F%2F10.0.0.8%3A19000",
      }),
    });

    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    const outer = new URL(resolution.target.url);
    expect(outer.protocol).toBe("demo:");
    expect(outer.searchParams.get("url")).toBe("http://127.0.0.1:8081/");
  });

  test("requests a development-client redirect without probing an unknown endpoint", async () => {
    const requested: string[] = [];
    const resolution = await resolveExpoLaunch({
      endpoint: "http://127.0.0.1:8081",
      runtime: "custom",
      devicePort: 8081,
      request: async (url) => {
        requested.push(url);
        return {
          status: 307,
          body: "",
          location: "demo://expo-development-client/?url=http%3A%2F%2F192.168.0.2%3A8081",
        };
      },
    });

    expect(resolution).toMatchObject({
      status: "resolved",
      target: { source: "link", runtime: "custom" },
    });
    expect(requested).toHaveLength(1);
    const link = new URL(requested[0] ?? "");
    expect(link.pathname).toBe("/_expo/link");
    expect(link.searchParams.get("choice")).toBe("expo-dev-client");
    expect(link.searchParams.get("platform")).toBe("android");
  });

  test("does not replace a public tunnel host", async () => {
    const resolution = await resolveExpoLaunch({
      endpoint: "http://127.0.0.1:8081",
      runtime: "expo",
      devicePort: 8081,
      request: async () => ({
        status: 307,
        body: "",
        location: "exp://demo.exp.direct:80",
      }),
    });

    expect(resolution).toMatchObject({
      status: "resolved",
      target: { url: "exp://demo.exp.direct:80" },
    });
  });

  test("fails closed on an invalid response and honors cancellation", async () => {
    const unavailable = await resolveExpoLaunch({
      endpoint: "http://127.0.0.1:8081",
      runtime: "expo",
      devicePort: 8081,
      request: async () => ({ status: 307, body: "", location: "file:///tmp/x" }),
    });
    expect(unavailable).toEqual({
      status: "unavailable",
      detail: "Expo /_expo/link returned an invalid or unsafe Android launch URL.",
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      resolveExpoLaunch({
        endpoint: "http://127.0.0.1:8081",
        runtime: "expo",
        devicePort: 8081,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ status: "aborted" });
  });

  test("uses the production HTTP adapter with bounded manual redirects", async () => {
    const requests: Array<{ path: string; platform: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push({ path: url.pathname, platform: request.headers.get("expo-platform") });
        return new Response(null, {
          status: 307,
          headers: { location: "exp://127.0.0.1:19000" },
        });
      },
    });
    try {
      const resolution = await resolveExpoLaunch({
        endpoint: `http://127.0.0.1:${String(server.port)}`,
        runtime: "expo",
        devicePort: 8081,
      });
      expect(resolution).toMatchObject({
        status: "resolved",
        target: { url: "exp://127.0.0.1:8081", source: "link" },
      });
      expect(requests).toEqual([{ path: "/_expo/link", platform: "android" }]);
    } finally {
      server.stop(true);
    }
  });

  test("classifies invalid endpoint responses and request failures", async () => {
    for (const response of [
      { status: 200, body: "" },
      { status: 307, body: "" },
      { status: 307, body: "", location: "not a URL" },
      { status: 307, body: "", location: "javascript:alert(1)" },
    ]) {
      const resolution = await resolveExpoLaunch({
        endpoint: "http://127.0.0.1:8081",
        runtime: "expo",
        devicePort: 8081,
        request: async () => response,
      });
      expect(resolution.status).toBe("unavailable");
    }

    await expect(
      resolveExpoLaunch({
        endpoint: "http://127.0.0.1:8081",
        runtime: "expo",
        devicePort: 8081,
        request: async () => {
          throw new Error("connection refused");
        },
      }),
    ).resolves.toEqual({
      status: "unavailable",
      detail: "Expo /_expo/link could not be reached.",
    });
  });

  test("validates bounds and distinguishes request timeout from caller cancellation", async () => {
    await expect(
      resolveExpoLaunch({
        endpoint: "http://127.0.0.1:8081",
        runtime: "expo",
        devicePort: 0,
      }),
    ).rejects.toThrow("devicePort");
    await expect(
      resolveExpoLaunch({
        endpoint: "http://127.0.0.1:8081",
        runtime: "expo",
        devicePort: 8081,
        timeoutMs: 0,
      }),
    ).rejects.toThrow("timeoutMs");

    const controller = new AbortController();
    const pending = resolveExpoLaunch({
      endpoint: "http://127.0.0.1:8081",
      runtime: "expo",
      devicePort: 8081,
      signal: controller.signal,
      request: async (_url, signal) =>
        await new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
    controller.abort();
    await expect(pending).resolves.toEqual({ status: "aborted" });

    await expect(
      resolveExpoLaunch({
        endpoint: "http://127.0.0.1:8081",
        runtime: "expo",
        devicePort: 8081,
        timeoutMs: 10,
        request: async (_url, signal) =>
          await new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
          }),
      }),
    ).resolves.toEqual({
      status: "unavailable",
      detail: "Expo /_expo/link did not respond within 10ms.",
    });
  });

  test("bounds untrusted response bodies", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("x".repeat(17 * 1024), { status: 200 });
      },
    });
    try {
      await expect(
        resolveExpoLaunch({
          endpoint: `http://127.0.0.1:${String(server.port)}`,
          runtime: "expo",
          devicePort: 8081,
        }),
      ).resolves.toMatchObject({ status: "unavailable" });
    } finally {
      server.stop(true);
    }
  });
});
