import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectProject, packageScriptCommand } from "../../src/dev/project.js";

function fixture(files: Record<string, string>, executables: string[] = []) {
  return {
    fileExists: async (file: string) => Object.hasOwn(files, file),
    readText: async (file: string) => files[file] ?? "",
    locate: async (name: string) => (executables.includes(name) ? `/bin/${name}` : undefined),
  };
}

describe("project detection", () => {
  test("prefers explicit package manager over package metadata and lockfiles", async () => {
    const root = path.resolve("/workspace/app");
    const detected = await detectProject({
      cwd: root,
      explicitPackageManager: "bun",
      ...fixture(
        {
          [path.join(root, "package.json")]: JSON.stringify({
            packageManager: "pnpm@10.0.0",
            dependencies: { expo: "latest", "react-native": "latest" },
            scripts: { start: "expo start" },
          }),
          [path.join(root, "pnpm-lock.yaml")]: "",
        },
        ["bun", "pnpm"],
      ),
    });

    expect(detected).toMatchObject({
      root,
      preset: "expo",
      packageManager: { name: "bun", executable: "/bin/bun", source: "config" },
    });
  });

  test("uses packageManager before lockfiles", async () => {
    const root = path.resolve("/workspace/app");
    const detected = await detectProject({
      cwd: root,
      ...fixture(
        {
          [path.join(root, "package.json")]: JSON.stringify({ packageManager: "yarn@4.9.2" }),
          [path.join(root, "bun.lock")]: "",
        },
        ["yarn", "bun"],
      ),
    });
    expect(detected.packageManager).toMatchObject({ name: "yarn", source: "package-json" });
  });

  test("uses npm devEngines packageManager before lockfiles without guessing arrays", async () => {
    const root = path.resolve("/workspace/app");
    const detected = await detectProject({
      cwd: root,
      ...fixture(
        {
          [path.join(root, "package.json")]: JSON.stringify({
            devEngines: { packageManager: { name: "pnpm", version: ">=10" } },
          }),
          [path.join(root, "bun.lock")]: "",
        },
        ["pnpm", "bun"],
      ),
    });
    expect(detected.packageManager).toMatchObject({
      name: "pnpm",
      executable: "/bin/pnpm",
      source: "dev-engines",
    });

    const ambiguous = await detectProject({
      cwd: root,
      ...fixture({
        [path.join(root, "package.json")]: JSON.stringify({
          devEngines: { packageManager: [{ name: "npm" }, { name: "yarn" }] },
        }),
      }),
    });
    expect(ambiguous.packageManager).toEqual({ conflicts: ["npm", "yarn"] });
  });

  test("refuses to guess between conflicting lockfiles", async () => {
    const root = path.resolve("/workspace/app");
    const detected = await detectProject({
      cwd: root,
      ...fixture({
        [path.join(root, "package.json")]: "{}",
        [path.join(root, "bun.lock")]: "",
        [path.join(root, "pnpm-lock.yaml")]: "",
      }),
    });
    expect(detected.packageManager).toEqual({ conflicts: ["bun", "pnpm"] });
  });

  test("falls back to the first available standard manager only without project evidence", async () => {
    const root = path.resolve("/workspace/app");
    const detected = await detectProject({
      cwd: root,
      ...fixture({ [path.join(root, "package.json")]: "{}" }, ["pnpm", "bun"]),
    });
    expect(detected.packageManager).toEqual({
      name: "pnpm",
      executable: "/bin/pnpm",
      source: "executable",
      conflicts: [],
    });
  });

  test("detects React Native and native Gradle without inventing a preset", async () => {
    const reactRoot = path.resolve("/workspace/react");
    const nativeRoot = path.resolve("/workspace/native");
    const unknownRoot = path.resolve("/workspace/unknown");
    expect(
      (
        await detectProject({
          cwd: reactRoot,
          ...fixture({
            [path.join(reactRoot, "package.json")]: JSON.stringify({
              dependencies: { "react-native": "latest" },
            }),
          }),
        })
      ).preset,
    ).toBe("react-native");
    expect(
      (
        await detectProject({
          cwd: nativeRoot,
          ...fixture({ [path.join(nativeRoot, "gradlew")]: "" }),
        })
      ).preset,
    ).toBe("gradle");
    expect((await detectProject({ cwd: unknownRoot, ...fixture({}) })).preset).toBeUndefined();
  });

  test("detects Flutter and Capacitor before their generated Android Gradle projects", async () => {
    const flutterRoot = path.resolve("/workspace/flutter");
    const capacitorRoot = path.resolve("/workspace/capacitor");
    expect(
      (
        await detectProject({
          cwd: path.join(flutterRoot, "android"),
          ...fixture({
            [path.join(flutterRoot, "pubspec.yaml")]: "name: example",
            [path.join(flutterRoot, "android", "build.gradle")]: "",
          }),
        })
      ).preset,
    ).toBe("flutter");
    expect(
      (
        await detectProject({
          cwd: capacitorRoot,
          ...fixture({
            [path.join(capacitorRoot, "package.json")]: JSON.stringify({
              dependencies: { "@capacitor/android": "latest" },
            }),
            [path.join(capacitorRoot, "android", "build.gradle")]: "",
          }),
        })
      ).preset,
    ).toBe("capacitor");
  });

  test("finds the nearest package through the production filesystem adapters", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-project-detection-"));
    const nested = path.join(root, "packages", "mobile");
    try {
      await mkdir(nested, { recursive: true });
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ packageManager: "npm@11.0.0", dependencies: { expo: "latest" } }),
      );
      const detected = await detectProject({
        cwd: nested,
        locate: async () => undefined,
      });
      expect(detected).toMatchObject({
        root,
        preset: "expo",
        packageManager: { name: "npm", source: "package-json" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("package script commands", () => {
  test("keeps executable and arguments separate for every manager", () => {
    expect(packageScriptCommand("npm", "/bin/npm", "start", ["--port", "8082"])).toEqual({
      executable: "/bin/npm",
      args: ["run", "start", "--", "--port", "8082"],
    });
    expect(packageScriptCommand("pnpm", "/bin/pnpm", "start", ["--port", "8082"])).toEqual({
      executable: "/bin/pnpm",
      args: ["run", "start", "--port", "8082"],
    });
  });
});
