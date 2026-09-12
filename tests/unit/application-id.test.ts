import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveApplicationId } from "../../src/app/application-id.js";

function files(entries: Record<string, string>) {
  return {
    fileExists: async (file: string) => Object.hasOwn(entries, file),
    readText: async (file: string) => entries[file] ?? "",
  };
}

describe("application ID resolution", () => {
  test("uses explicit and configured values before discovered project metadata", async () => {
    const root = "/project";
    const fixture = files({
      [path.join(root, "android", "app", "build.gradle")]:
        'android { defaultConfig { applicationId "com.example.gradle" } }',
      [path.join(root, "app.json")]: '{"expo":{"android":{"package":"com.example.expo"}}}',
    });
    const explicit = await resolveApplicationId({
      root,
      explicit: "com.example.explicit",
      configured: { value: "com.example.config", location: "/project/adb-ready.config.json" },
      ...fixture,
    });
    expect(explicit).toMatchObject({
      kind: "resolved",
      applicationId: "com.example.explicit",
      provenance: { source: "cli" },
    });

    const configured = await resolveApplicationId({
      root,
      configured: { value: "com.example.config", location: "/project/adb-ready.config.json" },
      ...fixture,
    });
    expect(configured).toMatchObject({
      kind: "resolved",
      applicationId: "com.example.config",
      provenance: { source: "config" },
    });
  });

  test("resolves Gradle before static Expo and manifest metadata", async () => {
    const root = "/project";
    const fixture = files({
      [path.join(root, "android", "app", "build.gradle.kts")]:
        'defaultConfig { applicationId = "com.example.gradle" }',
      [path.join(root, "app.json")]: '{"expo":{"android":{"package":"com.example.expo"}}}',
      [path.join(root, "android", "app", "src", "main", "AndroidManifest.xml")]:
        '<manifest package="com.example.manifest" />',
    });
    expect(await resolveApplicationId({ root, ...fixture })).toMatchObject({
      kind: "resolved",
      applicationId: "com.example.gradle",
      provenance: { source: "gradle" },
    });
  });

  test("reports same-precedence ambiguity instead of selecting the first candidate", async () => {
    const root = "/project";
    const fixture = files({
      [path.join(root, "android", "app", "build.gradle")]:
        'applicationId "com.example.one"\napplicationId "com.example.two"',
    });
    expect(await resolveApplicationId({ root, ...fixture })).toMatchObject({
      kind: "ambiguous",
      candidates: [
        { value: "com.example.one", source: "gradle" },
        { value: "com.example.two", source: "gradle" },
      ],
    });
  });

  test("uses an installed package only when it is unambiguous", async () => {
    const one = await resolveApplicationId({
      root: "/empty",
      installed: ["com.example.app"],
      ...files({}),
    });
    expect(one).toMatchObject({
      kind: "resolved",
      applicationId: "com.example.app",
      provenance: { source: "installed" },
    });

    const many = await resolveApplicationId({
      root: "/empty",
      installed: ["com.example.one", "com.example.two"],
      ...files({}),
    });
    expect(many).toMatchObject({ kind: "ambiguous" });
  });

  test("discovers application metadata through the production filesystem adapters", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-application-id-"));
    try {
      await writeFile(
        path.join(root, "app.json"),
        JSON.stringify({ expo: { android: { package: "com.example.filesystem" } } }),
      );
      expect(await resolveApplicationId({ root })).toMatchObject({
        kind: "resolved",
        applicationId: "com.example.filesystem",
        provenance: { source: "expo" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
