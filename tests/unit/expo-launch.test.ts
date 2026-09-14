import { describe, expect, test } from "bun:test";
import { resolveExpoLaunch } from "../../src/dev/expo-launch.js";

describe("resolveExpoLaunch", () => {
  test("uses the public open endpoint and routes a LAN URL through adb reverse", async () => {
    const requested: string[] = [];
    const resolution = await resolveExpoLaunch({
      endpoint: "http://127.0.0.1:8081",
      runtime: "expo",
      devicePort: 8081,
      request: async (url) => {
        requested.push(url);
        return {
          status: 200,
          body: JSON.stringify({
            runtime: "expo",
            url: "exp://192.168.1.20:8081",
            scheme: "demo",
            availableRuntimes: ["expo"],
            appId: "com.example.demo",
          }),
        };
      },
    });

    expect(resolution).toEqual({
      status: "resolved",
      target: {
        url: "exp://127.0.0.1:8081",
        runtime: "expo",
        source: "open",
        applicationId: "com.example.demo",
      },
    });
    expect(requested).toHaveLength(1);
    expect(new URL(requested[0] ?? "").pathname).toBe("/_expo/open");
  });

  test("rewrites the nested dev-client manifest URL but preserves its scheme", async () => {
    const resolution = await resolveExpoLaunch({
      endpoint: "http://127.0.0.1:19000",
      runtime: "custom",
      devicePort: 8081,
      request: async () => ({
        status: 200,
        body: JSON.stringify({
          runtime: "custom",
          url: "demo://expo-development-client/?url=http%3A%2F%2F10.0.0.8%3A19000",
          appId: "com.example.demo",
        }),
      }),
    });

    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    const outer = new URL(resolution.target.url);
    expect(outer.protocol).toBe("demo:");
    expect(outer.searchParams.get("url")).toBe("http://127.0.0.1:8081/");
  });

  test("falls back to Expo 55's legacy redirect without following the deep link", async () => {
    const requested: string[] = [];
    const resolution = await resolveExpoLaunch({
      endpoint: "http://127.0.0.1:8081",
      runtime: "custom",
      devicePort: 8081,
      request: async (url) => {
        requested.push(url);
        return requested.length === 1
          ? { status: 404, body: "" }
          : {
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
    const legacy = new URL(requested[1] ?? "");
    expect(legacy.pathname).toBe("/_expo/link");
    expect(legacy.searchParams.get("choice")).toBe("expo-dev-client");
    expect(legacy.searchParams.get("platform")).toBe("android");
  });

  test("does not replace a public tunnel host", async () => {
    const resolution = await resolveExpoLaunch({
      endpoint: "http://127.0.0.1:8081",
      runtime: "expo",
      devicePort: 8081,
      request: async () => ({
        status: 200,
        body: JSON.stringify({ runtime: "expo", url: "exp://demo.exp.direct:80" }),
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
      request: async () => ({ status: 200, body: '{"runtime":"expo","url":"file:///tmp/x"}' }),
    });
    expect(unavailable.status).toBe("unavailable");

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
});
