import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverExpoLocalServices } from "../../src/dev/local-services.js";

describe("Expo localhost service discovery", () => {
  test("uses Expo's development dotenv priority and keeps only public loopback URLs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-local-services-"));
    try {
      await writeFile(
        path.join(root, ".env"),
        [
          "API_SECRET=http://localhost:9999",
          "EXPO_PUBLIC_API_URL=http://localhost:7000",
          "EXPO_PUBLIC_REMOTE=https://example.com:7443",
          "EXPO_PUBLIC_DEFAULT=https://localhost",
        ].join("\n"),
      );
      await writeFile(
        path.join(root, ".env.local"),
        "EXPO_PUBLIC_API_URL='http://127.0.0.1:8000/v1'\n",
      );
      await writeFile(
        path.join(root, ".env.development.local"),
        [
          "EXPO_PUBLIC_API_URL=http://localhost:8100/v2",
          "EXPO_PUBLIC_SOCKET=ws://[::1]:9000/socket",
          "EXPO_PUBLIC_API_MIRROR=$" + "{EXPO_PUBLIC_API_URL}",
        ].join("\n"),
      );

      const services = discoverExpoLocalServices({ projectRoot: root, env: {} });

      expect(services).toEqual([
        {
          devicePort: 8100,
          hostPort: 8100,
          variables: ["EXPO_PUBLIC_API_MIRROR", "EXPO_PUBLIC_API_URL"],
          environmentFiles: [".env.development.local", ".env.local", ".env"],
        },
        {
          devicePort: 9000,
          hostPort: 9000,
          variables: ["EXPO_PUBLIC_SOCKET"],
          environmentFiles: [".env.development.local", ".env.local", ".env"],
        },
      ]);
      expect(JSON.stringify(services)).not.toContain("/v2");
      expect(JSON.stringify(services)).not.toContain("API_SECRET");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("lets the process environment override dotenv and deduplicates one port", () => {
    const services = discoverExpoLocalServices(
      {
        projectRoot: "/workspace/app",
        env: {
          EXPO_PUBLIC_API_URL: "http://localhost:8000",
          EXPO_PUBLIC_SECONDARY: "https://127.0.0.1:8000/path",
        },
      },
      {
        parseProjectEnvironment: () => ({
          env: { EXPO_PUBLIC_API_URL: "http://localhost:7000" },
          files: ["/workspace/app/.env"],
          sensitiveLoadedKeys: [],
        }),
      },
    );

    expect(services).toEqual([
      {
        devicePort: 8000,
        hostPort: 8000,
        variables: ["EXPO_PUBLIC_API_URL", "EXPO_PUBLIC_SECONDARY"],
        environmentFiles: [".env"],
      },
    ]);
  });

  test("honors Expo's dotenv opt-out while retaining explicit public environment values", () => {
    let parsed = false;
    const services = discoverExpoLocalServices(
      {
        projectRoot: "/workspace/app",
        env: {
          EXPO_NO_DOTENV: "1",
          EXPO_PUBLIC_API_URL: "http://localhost:8000",
        },
      },
      {
        parseProjectEnvironment: () => {
          parsed = true;
          throw new Error("must not parse");
        },
      },
    );

    expect(parsed).toBeFalse();
    expect(services).toEqual([
      {
        devicePort: 8000,
        hostPort: 8000,
        variables: ["EXPO_PUBLIC_API_URL"],
        environmentFiles: [],
      },
    ]);
  });

  test("fails closed when Expo env parsing fails", () => {
    expect(() =>
      discoverExpoLocalServices(
        { projectRoot: "/workspace/app", env: {} },
        {
          parseProjectEnvironment: () => {
            throw new Error("unreadable secret value");
          },
        },
      ),
    ).toThrow("Expo environment files could not be resolved safely.");
  });
});
