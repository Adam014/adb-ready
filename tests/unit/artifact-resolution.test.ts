import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAndroidArtifact } from "../../src/automation/artifact-resolution.js";

const temporary: string[] = [];

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "adb-ready-artifact-"));
  temporary.push(root);
  return await realpath(root);
}

async function file(name: string, content = "artifact"): Promise<void> {
  await mkdir(path.dirname(name), { recursive: true });
  await writeFile(name, content);
}

async function metadata(
  directory: string,
  value: {
    applicationId?: string;
    variantName?: string;
    elements: Array<{
      outputFile: string;
      type?: string;
      filters?: Array<{ filterType: string; value: string }>;
      versionCode?: number;
      versionName?: string;
    }>;
  },
): Promise<string> {
  const destination = path.join(directory, "output-metadata.json");
  await file(destination, JSON.stringify({ version: 3, artifactType: { type: "APK" }, ...value }));
  return destination;
}

afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("deterministic Android artifact resolution", () => {
  test("resolves one AGP APK with identity, version, variant, and provenance", async () => {
    const root = await project();
    const output = path.join(root, "android", "app", "build", "outputs", "apk", "debug");
    await file(path.join(output, "app-debug.apk"));
    const source = await metadata(output, {
      applicationId: "com.example.ready",
      variantName: "debug",
      elements: [
        {
          type: "SINGLE",
          filters: [],
          versionCode: 42,
          versionName: "1.2.3",
          outputFile: "app-debug.apk",
        },
      ],
    });

    const resolution = await resolveAndroidArtifact({ root });

    expect(resolution).toEqual({
      ok: true,
      artifact: {
        kind: "apk",
        files: [path.join(output, "app-debug.apk")],
        applicationId: "com.example.ready",
        variant: "debug",
        versionCode: 42,
        versionName: "1.2.3",
        filters: [],
        provenance: { kind: "agp-output-metadata", source },
      },
    });
  });

  test("treats AGP ONE_OF_MANY outputs as alternatives and uses target ABI preference", async () => {
    const root = await project();
    const output = path.join(root, "app", "build", "outputs", "apk", "release");
    await file(path.join(output, "app-arm64-v8a.apk"));
    await file(path.join(output, "app-x86_64.apk"));
    await metadata(output, {
      applicationId: "com.example.splits",
      variantName: "release",
      elements: [
        {
          type: "ONE_OF_MANY",
          outputFile: "app-arm64-v8a.apk",
          filters: [
            { filterType: "ABI", value: "arm64-v8a" },
            { filterType: "DENSITY", value: "480" },
            { filterType: "LANGUAGE", value: "en" },
          ],
          versionCode: 9,
        },
        {
          type: "ONE_OF_MANY",
          outputFile: "app-x86_64.apk",
          filters: [{ filterType: "ABI", value: "x86_64" }],
          versionCode: 9,
        },
      ],
    });

    expect(await resolveAndroidArtifact({ root, preset: "gradle" })).toMatchObject({
      ok: false,
      failure: { code: "ARTIFACT_AMBIGUOUS" },
    });
    const resolution = await resolveAndroidArtifact({
      root,
      preset: "gradle",
      device: { abis: ["arm64-v8a", "x86_64"], density: "480", locales: ["en"] },
    });

    expect(resolution).toMatchObject({
      ok: true,
      artifact: {
        kind: "apk",
        applicationId: "com.example.splits",
        variant: "release",
        versionCode: 9,
        filters: [
          { filterType: "ABI", value: "arm64-v8a" },
          { filterType: "DENSITY", value: "480" },
          { filterType: "LANGUAGE", value: "en" },
        ],
      },
    });
    if (resolution.ok)
      expect(resolution.artifact.files).toEqual([path.join(output, "app-arm64-v8a.apk")]);
    expect(
      await resolveAndroidArtifact({
        root,
        preset: "gradle",
        device: { abis: ["armeabi-v7a"] },
      }),
    ).toMatchObject({ ok: false, failure: { code: "ARTIFACT_NOT_FOUND" } });
    expect(
      await resolveAndroidArtifact({
        root,
        preset: "gradle",
        device: { abis: ["arm64-v8a"], density: "420", locales: ["en"] },
      }),
    ).toMatchObject({ ok: false, failure: { code: "ARTIFACT_NOT_FOUND" } });
    expect(
      await resolveAndroidArtifact({
        root,
        preset: "gradle",
        device: { abis: ["arm64-v8a"], density: "480", locales: ["cs"] },
      }),
    ).toMatchObject({ ok: false, failure: { code: "ARTIFACT_NOT_FOUND" } });
  });

  test("fails closed on ambiguous variants and resolves exact identity filters", async () => {
    const root = await project();
    for (const variant of ["debug", "release"]) {
      const output = path.join(root, "app", "build", "outputs", "apk", variant);
      await file(path.join(output, `app-${variant}.apk`));
      await metadata(output, {
        applicationId: "com.example.app",
        variantName: variant,
        elements: [{ outputFile: `app-${variant}.apk`, filters: [] }],
      });
    }

    const ambiguous = await resolveAndroidArtifact({ root, preset: "gradle" });
    expect(ambiguous).toMatchObject({
      ok: false,
      failure: { code: "ARTIFACT_AMBIGUOUS" },
    });
    if (!ambiguous.ok) {
      expect(ambiguous.failure.candidates).toHaveLength(2);
      expect(ambiguous.failure.detail).toContain("modification time");
    }

    const selected = await resolveAndroidArtifact({
      root,
      preset: "gradle",
      applicationId: "com.example.app",
      variant: "release",
    });
    expect(selected).toMatchObject({
      ok: true,
      artifact: { kind: "apk", variant: "release" },
    });
    expect(
      await resolveAndroidArtifact({ root, preset: "gradle", variant: "missing" }),
    ).toMatchObject({ ok: false, failure: { code: "ARTIFACT_NOT_FOUND" } });
  });

  test("accepts explicit project-local APK, split APK, AAB, and APK Set inputs", async () => {
    const root = await project();
    for (const name of ["app.apk", "base.apk", "config.apk", "app.aab", "app.apks"]) {
      await file(path.join(root, "artifacts", name));
    }
    const cases = [
      { paths: ["artifacts/app.apk"], kind: "apk" },
      { paths: ["artifacts/base.apk", "artifacts/config.apk"], kind: "split-apks" },
      { paths: ["artifacts/app.aab"], kind: "aab" },
      { paths: ["artifacts/app.apks"], kind: "apks" },
    ] as const;
    for (const fixture of cases) {
      const resolution = await resolveAndroidArtifact({
        root,
        explicitPaths: [...fixture.paths],
        applicationId: "com.example.explicit",
        variant: "debug",
      });
      expect(resolution).toMatchObject({
        ok: true,
        artifact: {
          kind: fixture.kind,
          applicationId: "com.example.explicit",
          variant: "debug",
          provenance: { kind: "explicit" },
        },
      });
    }
  });

  test("enriches one explicit APK from adjacent AGP metadata", async () => {
    const root = await project();
    const output = path.join(root, "artifacts");
    await file(path.join(output, "app.apk"));
    await metadata(output, {
      applicationId: "com.example.metadata",
      variantName: "benchmark",
      elements: [{ outputFile: "app.apk", filters: [], versionCode: 7 }],
    });
    expect(
      await resolveAndroidArtifact({ root, explicitPaths: ["artifacts/app.apk"] }),
    ).toMatchObject({
      ok: true,
      artifact: {
        applicationId: "com.example.metadata",
        variant: "benchmark",
        versionCode: 7,
        provenance: { kind: "explicit" },
      },
    });
    expect(
      await resolveAndroidArtifact({
        root,
        explicitPaths: ["artifacts/app.apk"],
        applicationId: "com.example.wrong",
      }),
    ).toMatchObject({ ok: false, failure: { code: "ARTIFACT_INVALID_INPUT" } });
    expect(
      await resolveAndroidArtifact({
        root,
        explicitPaths: ["artifacts/app.apk"],
        variant: "release",
      }),
    ).toMatchObject({ ok: false, failure: { code: "ARTIFACT_INVALID_INPUT" } });
  });

  test("rejects an explicit APK omitted by adjacent AGP metadata", async () => {
    const root = await project();
    const output = path.join(root, "artifacts");
    await file(path.join(output, "requested.apk"));
    await file(path.join(output, "declared.apk"));
    await metadata(output, {
      elements: [{ outputFile: "declared.apk", filters: [] }],
    });
    expect(
      await resolveAndroidArtifact({ root, explicitPaths: ["artifacts/requested.apk"] }),
    ).toMatchObject({
      ok: false,
      failure: { code: "ARTIFACT_METADATA_INVALID" },
    });
  });

  test("rejects unsafe, unreadable, duplicate, mixed, and over-specified explicit inputs", async () => {
    const root = await project();
    const outside = path.join(await project(), "outside.apk");
    await file(outside);
    await file(path.join(root, "app.apk"));
    await file(path.join(root, "split.apk"));
    await file(path.join(root, "app.aab"));
    await file(path.join(root, "app2.aab"));
    await file(path.join(root, "other", "config.apk"));

    const fixtures = [
      { paths: [], code: "ARTIFACT_INVALID_INPUT" },
      { paths: [" missing.apk"], code: "ARTIFACT_INVALID_INPUT" },
      { paths: ["missing.apk"], code: "ARTIFACT_UNREADABLE" },
      { paths: [outside], code: "ARTIFACT_OUTSIDE_PROJECT" },
      { paths: ["app.apk", "app.apk"], code: "ARTIFACT_INVALID_INPUT" },
      { paths: ["app.apk", "app.aab"], code: "ARTIFACT_INVALID_INPUT" },
      { paths: ["app.aab", "app.aab"], code: "ARTIFACT_INVALID_INPUT" },
      { paths: ["app.aab", "app2.aab"], code: "ARTIFACT_INVALID_INPUT" },
      { paths: ["app.apk", "other/config.apk"], code: "ARTIFACT_INVALID_INPUT" },
      { paths: ["app.apk", "split.apk"], code: "ARTIFACT_INVALID_INPUT" },
    ];
    for (const fixture of fixtures) {
      expect(await resolveAndroidArtifact({ root, explicitPaths: fixture.paths })).toMatchObject({
        ok: false,
        failure: { code: fixture.code },
      });
    }
  });

  test("rejects malformed, escaping, missing, duplicate, and non-APK AGP metadata", async () => {
    const cases: Array<{
      document: unknown;
      files?: Record<string, string>;
      code: string;
    }> = [
      { document: "not-json", code: "ARTIFACT_METADATA_INVALID" },
      {
        document: { elements: [{ outputFile: "../escape.apk", filters: [] }] },
        code: "ARTIFACT_METADATA_INVALID",
      },
      {
        document: { elements: [{ outputFile: "missing.apk", filters: [] }] },
        code: "ARTIFACT_METADATA_INVALID",
      },
      {
        document: {
          elements: [
            { outputFile: "same.apk", filters: [] },
            { outputFile: "same.apk", filters: [] },
          ],
        },
        files: { "same.apk": "apk" },
        code: "ARTIFACT_METADATA_INVALID",
      },
      {
        document: {
          artifactType: { type: "AAB" },
          elements: [{ outputFile: "app.apk", filters: [] }],
        },
        files: { "app.apk": "apk" },
        code: "ARTIFACT_METADATA_INVALID",
      },
      {
        document: { elements: [{ outputFile: "app.aab", filters: [] }] },
        files: { "app.aab": "bundle" },
        code: "ARTIFACT_METADATA_INVALID",
      },
    ];
    for (const fixture of cases) {
      const root = await project();
      const output = path.join(root, "app", "build", "outputs", "apk", "debug");
      for (const [name, contents] of Object.entries(fixture.files ?? {})) {
        await file(path.join(output, name), contents);
      }
      await file(
        path.join(output, "output-metadata.json"),
        typeof fixture.document === "string" ? fixture.document : JSON.stringify(fixture.document),
      );
      expect(await resolveAndroidArtifact({ root, preset: "gradle" })).toMatchObject({
        ok: false,
        failure: { code: fixture.code },
      });
    }
  });

  test("discovers bounded AAB and APK Set outputs but ignores unrelated project files", async () => {
    const root = await project();
    await file(path.join(root, "random", "ignored.apk"));
    const bundle = path.join(root, "build", "app", "outputs", "bundle", "release", "app.aab");
    await file(bundle);
    const resolution = await resolveAndroidArtifact({ root, preset: "flutter" });
    expect(resolution).toEqual({
      ok: true,
      artifact: {
        kind: "aab",
        files: [bundle],
        variant: "release",
        filters: [],
        provenance: { kind: "bounded-output", source: bundle },
      },
    });

    const archive = path.join(root, "build", "app", "outputs", "bundle", "release", "app.apks");
    await file(archive);
    expect(await resolveAndroidArtifact({ root, preset: "flutter" })).toMatchObject({
      ok: false,
      failure: { code: "ARTIFACT_AMBIGUOUS" },
    });
  });

  test("reports missing project roots and refuses oversized metadata", async () => {
    const root = await project();
    const output = path.join(root, "app", "build", "outputs", "apk", "debug");
    await file(path.join(output, "output-metadata.json"), "x".repeat(1024 * 1024 + 1));
    expect(await resolveAndroidArtifact({ root, preset: "gradle" })).toMatchObject({
      ok: false,
      failure: { code: "ARTIFACT_METADATA_INVALID" },
    });
    expect(
      await resolveAndroidArtifact({ root: path.join(root, "missing"), preset: "gradle" }),
    ).toMatchObject({ ok: false, failure: { code: "ARTIFACT_UNREADABLE" } });
  });
});
