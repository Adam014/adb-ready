import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { DevPreset } from "../dev/project.js";

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_SCAN_ENTRIES = 5_000;
const MAX_SCAN_DEPTH = 8;

export type AndroidArtifactKind = "aab" | "apk" | "apks" | "split-apks";

export interface AndroidArtifactFilter {
  filterType: string;
  value: string;
}

export interface AndroidArtifact {
  kind: AndroidArtifactKind;
  files: string[];
  applicationId?: string;
  variant?: string;
  versionCode?: number;
  versionName?: string;
  filters: AndroidArtifactFilter[];
  provenance: {
    kind: "agp-output-metadata" | "bounded-output" | "explicit";
    source: string;
  };
}

export type ArtifactResolutionFailureCode =
  | "ARTIFACT_AMBIGUOUS"
  | "ARTIFACT_INVALID_INPUT"
  | "ARTIFACT_METADATA_INVALID"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_OUTSIDE_PROJECT"
  | "ARTIFACT_SCAN_LIMIT"
  | "ARTIFACT_UNREADABLE";

export interface ArtifactResolutionFailure {
  code: ArtifactResolutionFailureCode;
  summary: string;
  detail: string;
  next: string;
  candidates: string[];
}

export type ArtifactResolution =
  | { ok: true; artifact: AndroidArtifact }
  | { ok: false; failure: ArtifactResolutionFailure };

export interface ResolveAndroidArtifactOptions {
  root: string;
  preset?: DevPreset;
  explicitPaths?: string[];
  applicationId?: string;
  variant?: string;
  device?: {
    abis?: string[];
    density?: string;
    locales?: string[];
  };
}

interface MetadataElement {
  outputFile: string;
  type?: string;
  filters: AndroidArtifactFilter[];
  versionCode?: number;
  versionName?: string;
}

interface ParsedMetadata {
  applicationId?: string;
  variant?: string;
  elements: MetadataElement[];
}

function failure(
  code: ArtifactResolutionFailureCode,
  summary: string,
  detail: string,
  next: string,
  candidates: string[] = [],
): ArtifactResolution {
  return { ok: false, failure: { code, summary, detail, next, candidates } };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() === value && value.length > 0
    ? value
    : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function artifactExtension(file: string): ".aab" | ".apk" | ".apks" | undefined {
  const extension = path.extname(file).toLowerCase();
  return extension === ".aab" || extension === ".apk" || extension === ".apks"
    ? extension
    : undefined;
}

function parseMetadata(raw: string): ParsedMetadata | undefined {
  let document: Record<string, unknown> | undefined;
  try {
    document = record(JSON.parse(raw));
  } catch {
    return undefined;
  }
  if (document === undefined || !Array.isArray(document.elements) || document.elements.length === 0)
    return undefined;
  const artifactType = record(document.artifactType);
  if (artifactType !== undefined && artifactType.type !== "APK") return undefined;
  const elements: MetadataElement[] = [];
  for (const value of document.elements) {
    const element = record(value);
    const outputFile = safeString(element?.outputFile);
    if (
      element === undefined ||
      outputFile === undefined ||
      path.basename(outputFile) !== outputFile
    )
      return undefined;
    const filters: AndroidArtifactFilter[] = [];
    if (element.filters !== undefined) {
      if (!Array.isArray(element.filters)) return undefined;
      for (const value of element.filters) {
        const filter = record(value);
        const filterType = safeString(filter?.filterType);
        const filterValue = safeString(filter?.value);
        if (filterType === undefined || filterValue === undefined) return undefined;
        filters.push({ filterType, value: filterValue });
      }
    }
    const type = safeString(element.type);
    const versionCode = safeInteger(element.versionCode);
    const versionName = safeString(element.versionName);
    elements.push({
      outputFile,
      filters: filters.sort((left, right) =>
        `${left.filterType}:${left.value}`.localeCompare(`${right.filterType}:${right.value}`),
      ),
      ...(type === undefined ? {} : { type }),
      ...(versionCode === undefined ? {} : { versionCode }),
      ...(versionName === undefined ? {} : { versionName }),
    });
  }
  const applicationId = safeString(document.applicationId);
  const variant = safeString(document.variantName);
  return {
    elements,
    ...(applicationId === undefined ? {} : { applicationId }),
    ...(variant === undefined ? {} : { variant }),
  };
}

async function regularNonemptyFile(file: string): Promise<boolean> {
  try {
    const information = await stat(file);
    return information.isFile() && information.size > 0;
  } catch {
    return false;
  }
}

async function canonicalProjectFile(
  projectRoot: string,
  requested: string,
): Promise<{ ok: true; path: string } | { ok: false; outside: boolean }> {
  try {
    const canonical = await realpath(requested);
    return inside(projectRoot, canonical) && (await regularNonemptyFile(canonical))
      ? { ok: true, path: canonical }
      : { ok: false, outside: !inside(projectRoot, canonical) };
  } catch {
    return { ok: false, outside: false };
  }
}

function outputRoots(root: string, preset: DevPreset | undefined): string[] {
  const candidates =
    preset === "flutter"
      ? [path.join(root, "build", "app", "outputs")]
      : preset === "expo" || preset === "react-native" || preset === "capacitor"
        ? [path.join(root, "android", "app", "build", "outputs")]
        : preset === "gradle"
          ? [path.join(root, "app", "build", "outputs"), path.join(root, "build", "outputs")]
          : [
              path.join(root, "android", "app", "build", "outputs"),
              path.join(root, "app", "build", "outputs"),
              path.join(root, "build", "app", "outputs"),
              path.join(root, "build", "outputs"),
            ];
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))].sort();
}

async function scanOutputRoots(
  roots: readonly string[],
): Promise<{ ok: true; metadata: string[]; archives: string[] } | { ok: false; limit: string }> {
  const metadata: string[] = [];
  const archives: string[] = [];
  const queue = roots.map((root) => ({ directory: root, depth: 0 }));
  let entries = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    let children: Dirent[];
    try {
      children = await readdir(current.directory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      entries += 1;
      if (entries > MAX_SCAN_ENTRIES) return { ok: false, limit: current.directory };
      const candidate = path.join(current.directory, child.name);
      if (child.isDirectory()) {
        if (current.depth < MAX_SCAN_DEPTH)
          queue.push({ directory: candidate, depth: current.depth + 1 });
        continue;
      }
      if (!child.isFile()) continue;
      if (child.name === "output-metadata.json") metadata.push(candidate);
      else {
        const extension = artifactExtension(child.name);
        if (extension === ".aab" || extension === ".apks") archives.push(candidate);
      }
    }
  }
  return {
    ok: true,
    metadata: [...new Set(metadata)].sort(),
    archives: [...new Set(archives)].sort(),
  };
}

async function artifactFromMetadata(
  metadataPath: string,
  projectRoot: string,
): Promise<{ artifacts: AndroidArtifact[] } | ArtifactResolutionFailure> {
  const information = await stat(metadataPath).catch(() => undefined);
  if (information === undefined || !information.isFile() || information.size > MAX_METADATA_BYTES) {
    return {
      code: "ARTIFACT_METADATA_INVALID",
      summary: "Android build metadata is unreadable or too large.",
      detail: metadataPath,
      next: "Rebuild the selected variant and retry with fresh AGP output metadata.",
      candidates: [],
    };
  }
  const parsed = parseMetadata(await readFile(metadataPath, "utf8").catch(() => ""));
  if (parsed === undefined) {
    return {
      code: "ARTIFACT_METADATA_INVALID",
      summary: "Android build metadata is malformed.",
      detail: metadataPath,
      next: "Rebuild the selected variant; ADB Ready will not guess around invalid output metadata.",
      candidates: [],
    };
  }
  const directory = path.dirname(metadataPath);
  const files: string[] = [];
  const artifacts: AndroidArtifact[] = [];
  for (const element of parsed.elements) {
    const requested = path.resolve(directory, element.outputFile);
    const canonical = await canonicalProjectFile(projectRoot, requested);
    if (!canonical.ok) {
      return {
        code: canonical.outside ? "ARTIFACT_OUTSIDE_PROJECT" : "ARTIFACT_METADATA_INVALID",
        summary: "Android build metadata references an unsafe or missing APK.",
        detail: element.outputFile,
        next: "Rebuild the selected variant and keep every generated APK inside the project output directory.",
        candidates: [],
      };
    }
    if (artifactExtension(canonical.path) !== ".apk") {
      return {
        code: "ARTIFACT_METADATA_INVALID",
        summary: "Android build metadata references a non-APK output.",
        detail: element.outputFile,
        next: "Rebuild the APK variant and retry with its output metadata.",
        candidates: [],
      };
    }
    files.push(canonical.path);
    artifacts.push({
      kind: "apk",
      files: [canonical.path],
      filters: element.filters,
      provenance: { kind: "agp-output-metadata", source: metadataPath },
      ...(parsed.applicationId === undefined ? {} : { applicationId: parsed.applicationId }),
      ...(parsed.variant === undefined ? {} : { variant: parsed.variant }),
      ...(element.versionCode === undefined ? {} : { versionCode: element.versionCode }),
      ...(element.versionName === undefined ? {} : { versionName: element.versionName }),
    });
  }
  const uniqueFiles = [...new Set(files)];
  if (uniqueFiles.length !== parsed.elements.length) {
    return {
      code: "ARTIFACT_METADATA_INVALID",
      summary: "Android build metadata contains duplicate APK outputs.",
      detail: metadataPath,
      next: "Clean and rebuild the selected Android variant.",
      candidates: [],
    };
  }
  return { artifacts };
}

function candidateLabel(root: string, artifact: AndroidArtifact): string {
  const files = artifact.files.map((file) => path.relative(root, file)).join(", ");
  const filters = artifact.filters
    .map(({ filterType, value }) => `${filterType}=${value}`)
    .join(",");
  return [artifact.variant, artifact.applicationId, filters, files].filter(Boolean).join(" · ");
}

function matchesSelection(
  artifact: AndroidArtifact,
  options: Pick<ResolveAndroidArtifactOptions, "applicationId" | "device" | "variant">,
): boolean {
  if (options.applicationId !== undefined && artifact.applicationId !== options.applicationId)
    return false;
  if (options.variant !== undefined && artifact.variant !== options.variant) return false;
  for (const filter of artifact.filters) {
    const kind = filter.filterType.toUpperCase();
    if (kind === "ABI" && options.device?.abis !== undefined) {
      if (!options.device.abis.includes(filter.value)) return false;
    } else if (kind === "DENSITY" && options.device?.density !== undefined) {
      if (options.device.density !== filter.value) return false;
    } else if (kind === "LANGUAGE" && options.device?.locales !== undefined) {
      if (!options.device.locales.includes(filter.value)) return false;
    }
  }
  return true;
}

function compatibilityRank(
  artifact: AndroidArtifact,
  options: ResolveAndroidArtifactOptions,
): number {
  const abi = artifact.filters.find(({ filterType }) => filterType.toUpperCase() === "ABI")?.value;
  if (abi === undefined) return options.device?.abis?.length ?? 0;
  const index = options.device?.abis?.indexOf(abi) ?? -1;
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

async function resolveExplicit(
  options: ResolveAndroidArtifactOptions,
  projectRoot: string,
): Promise<ArtifactResolution> {
  const requested = options.explicitPaths ?? [];
  if (requested.length === 0)
    return failure(
      "ARTIFACT_INVALID_INPUT",
      "No explicit artifact path was provided.",
      "The explicit artifact list is empty.",
      "Provide one .apk, .aab, or .apks file, or a complete split APK set.",
    );
  const files: string[] = [];
  for (const value of requested) {
    if (value.trim() !== value || value.length === 0)
      return failure(
        "ARTIFACT_INVALID_INPUT",
        "An explicit artifact path is invalid.",
        value,
        "Pass non-empty paths without surrounding whitespace.",
      );
    const canonical = await canonicalProjectFile(projectRoot, path.resolve(options.root, value));
    if (!canonical.ok)
      return failure(
        canonical.outside ? "ARTIFACT_OUTSIDE_PROJECT" : "ARTIFACT_UNREADABLE",
        canonical.outside
          ? "An explicit artifact is outside the project."
          : "An explicit artifact is missing or empty.",
        value,
        "Use a non-empty project-local Android build artifact.",
      );
    files.push(canonical.path);
  }
  const unique = [...new Set(files)];
  if (unique.length !== files.length)
    return failure(
      "ARTIFACT_INVALID_INPUT",
      "The explicit artifact list contains duplicates.",
      requested.join(", "),
      "Pass each APK exactly once.",
    );
  const extensions = new Set(unique.map(artifactExtension));
  if (extensions.has(undefined) || extensions.size !== 1)
    return failure(
      "ARTIFACT_INVALID_INPUT",
      "The explicit artifact set mixes unsupported file types.",
      requested.join(", "),
      "Use one .aab, one .apks, one .apk, or only APK files from one split set.",
    );
  const extension = [...extensions][0];
  if (extension !== ".apk" && unique.length !== 1)
    return failure(
      "ARTIFACT_INVALID_INPUT",
      "AAB and APK Set inputs must contain exactly one file.",
      requested.join(", "),
      "Pass exactly one archive.",
    );
  if (extension === ".apk" && unique.length > 1) {
    if (new Set(unique.map((file) => path.dirname(file))).size !== 1)
      return failure(
        "ARTIFACT_INVALID_INPUT",
        "A split APK set must come from one output directory.",
        requested.join(", "),
        "Pass every split from the same generated APK set.",
      );
    if (options.applicationId === undefined)
      return failure(
        "ARTIFACT_INVALID_INPUT",
        "A split APK set requires an expected application ID.",
        requested.join(", "),
        "Pass the project's application ID so deployment can verify the complete set.",
      );
  }
  if (extension === ".apk" && unique.length === 1) {
    const explicit = unique[0];
    if (explicit === undefined) throw new Error("Explicit APK selection unexpectedly became empty");
    const metadataPath = path.join(path.dirname(explicit), "output-metadata.json");
    if (await regularNonemptyFile(metadataPath)) {
      const parsed = await artifactFromMetadata(metadataPath, projectRoot);
      if ("code" in parsed) return { ok: false, failure: parsed };
      const matched = parsed.artifacts.find(({ files }) => files[0] === explicit);
      if (matched === undefined)
        return failure(
          "ARTIFACT_METADATA_INVALID",
          "The explicit APK is not declared by its adjacent Android build metadata.",
          explicit,
          "Choose an APK listed by output-metadata.json or rebuild the variant.",
        );
      if (
        options.applicationId !== undefined &&
        matched.applicationId !== undefined &&
        options.applicationId !== matched.applicationId
      )
        return failure(
          "ARTIFACT_INVALID_INPUT",
          "The expected application ID conflicts with Android build metadata.",
          `${options.applicationId} != ${matched.applicationId}`,
          "Use the application ID declared by the selected build variant.",
        );
      if (
        options.variant !== undefined &&
        matched.variant !== undefined &&
        options.variant !== matched.variant
      )
        return failure(
          "ARTIFACT_INVALID_INPUT",
          "The requested variant conflicts with Android build metadata.",
          `${options.variant} != ${matched.variant}`,
          "Choose the variant declared by output-metadata.json.",
        );
      const applicationId = matched.applicationId ?? options.applicationId;
      const variant = matched.variant ?? options.variant;
      return {
        ok: true,
        artifact: {
          ...matched,
          provenance: { kind: "explicit", source: explicit },
          ...(applicationId === undefined ? {} : { applicationId }),
          ...(variant === undefined ? {} : { variant }),
        },
      };
    }
  }
  const kind =
    extension === ".aab"
      ? "aab"
      : extension === ".apks"
        ? "apks"
        : unique.length === 1
          ? "apk"
          : "split-apks";
  return {
    ok: true,
    artifact: {
      kind,
      files: unique.sort(),
      filters: [],
      provenance: { kind: "explicit", source: unique.join(path.delimiter) },
      ...(options.applicationId === undefined ? {} : { applicationId: options.applicationId }),
      ...(options.variant === undefined ? {} : { variant: options.variant }),
    },
  };
}

export async function resolveAndroidArtifact(
  options: ResolveAndroidArtifactOptions,
): Promise<ArtifactResolution> {
  let projectRoot: string;
  try {
    projectRoot = await realpath(path.resolve(options.root));
  } catch {
    return failure(
      "ARTIFACT_UNREADABLE",
      "The project root is unavailable.",
      options.root,
      "Run from an existing project directory or pass the correct project root.",
    );
  }
  if (options.explicitPaths !== undefined) return await resolveExplicit(options, projectRoot);

  const scan = await scanOutputRoots(outputRoots(projectRoot, options.preset));
  if (!scan.ok)
    return failure(
      "ARTIFACT_SCAN_LIMIT",
      "Android output discovery exceeded its safety limit.",
      scan.limit,
      "Remove stale build outputs or pass one explicit artifact path.",
    );
  const artifacts: AndroidArtifact[] = [];
  for (const metadataPath of scan.metadata) {
    const parsed = await artifactFromMetadata(metadataPath, projectRoot);
    if ("code" in parsed) return { ok: false, failure: parsed };
    artifacts.push(...parsed.artifacts);
  }
  for (const archive of scan.archives) {
    const canonical = await canonicalProjectFile(projectRoot, archive);
    if (!canonical.ok) continue;
    const extension = artifactExtension(canonical.path);
    if (extension !== ".aab" && extension !== ".apks") continue;
    artifacts.push({
      kind: extension === ".aab" ? "aab" : "apks",
      files: [canonical.path],
      variant: path.basename(path.dirname(canonical.path)),
      filters: [],
      provenance: { kind: "bounded-output", source: canonical.path },
    });
  }
  const unique = new Map<string, AndroidArtifact>();
  for (const artifact of artifacts) {
    const key = artifact.files.join("\u0000");
    const current = unique.get(key);
    if (current === undefined || current.provenance.kind === "bounded-output")
      unique.set(key, artifact);
  }
  const compatible = [...unique.values()]
    .filter((artifact) => matchesSelection(artifact, options))
    .sort((left, right) => {
      const rank = compatibilityRank(left, options) - compatibilityRank(right, options);
      return rank === 0
        ? candidateLabel(projectRoot, left).localeCompare(candidateLabel(projectRoot, right))
        : rank;
    });
  const bestRank =
    compatible[0] === undefined ? undefined : compatibilityRank(compatible[0], options);
  const selected = compatible.filter(
    (artifact) => compatibilityRank(artifact, options) === bestRank,
  );
  if (selected.length === 0)
    return failure(
      "ARTIFACT_NOT_FOUND",
      "No deterministic Android install artifact was found.",
      "No complete artifact matched the requested project, application, and variant filters.",
      "Build one Android variant, choose --variant/--app, or pass an explicit artifact path.",
    );
  if (selected.length > 1)
    return failure(
      "ARTIFACT_AMBIGUOUS",
      "Multiple Android install artifacts match this run.",
      "ADB Ready will not choose by filesystem order or modification time.",
      "Select an exact variant/application or pass one explicit artifact path.",
      selected.map((artifact) => candidateLabel(projectRoot, artifact)),
    );
  const artifact = selected[0];
  if (artifact === undefined) throw new Error("Artifact selection unexpectedly returned no result");
  return { ok: true, artifact };
}
