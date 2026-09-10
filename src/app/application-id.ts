import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export type ApplicationIdSource = "cli" | "config" | "expo" | "gradle" | "installed" | "manifest";

export interface ApplicationIdCandidate {
  value: string;
  source: ApplicationIdSource;
  location?: string;
  detail?: string;
}

export type ApplicationIdResolution =
  | {
      kind: "resolved";
      applicationId: string;
      provenance: ApplicationIdCandidate;
      considered: ApplicationIdCandidate[];
    }
  | {
      kind: "ambiguous";
      candidates: ApplicationIdCandidate[];
      considered: ApplicationIdCandidate[];
    }
  | { kind: "not-found"; considered: ApplicationIdCandidate[] };

export interface ResolveApplicationIdOptions {
  root: string;
  explicit?: string;
  configured?: { value: string; location?: string };
  installed?: readonly string[];
  fileExists?: (file: string) => Promise<boolean>;
  readText?: (file: string) => Promise<string>;
}

const APPLICATION_ID = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u;
const SOURCE_PRECEDENCE: readonly ApplicationIdSource[] = [
  "cli",
  "config",
  "gradle",
  "expo",
  "manifest",
  "installed",
];

export function isApplicationId(value: string): boolean {
  return APPLICATION_ID.test(value);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function defaultFileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function uniqueCandidates(candidates: readonly ApplicationIdCandidate[]): ApplicationIdCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.source}\0${candidate.value}\0${candidate.location ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function jsonPackage(raw: string): string | undefined {
  try {
    const document = object(JSON.parse(raw));
    const expo = object(document?.expo);
    const android = object(expo?.android);
    return typeof android?.package === "string" && isApplicationId(android.package)
      ? android.package
      : undefined;
  } catch {
    return undefined;
  }
}

function gradlePackages(raw: string): string[] {
  const matches = raw.matchAll(/\bapplicationId\s*(?:=\s*)?["']([^"']+)["']/gu);
  return [
    ...new Set(
      [...matches]
        .map((match) => match[1]?.trim())
        .filter((value): value is string => value !== undefined && isApplicationId(value)),
    ),
  ];
}

function manifestPackage(raw: string): string | undefined {
  const value = raw.match(/<manifest\b[^>]*\bpackage\s*=\s*["']([^"']+)["']/u)?.[1]?.trim();
  return value !== undefined && isApplicationId(value) ? value : undefined;
}

export async function discoverProjectApplicationIds(
  options: Pick<ResolveApplicationIdOptions, "fileExists" | "readText" | "root">,
): Promise<ApplicationIdCandidate[]> {
  const exists = options.fileExists ?? defaultFileExists;
  const readText = options.readText ?? (async (file: string) => await readFile(file, "utf8"));
  const candidates: ApplicationIdCandidate[] = [];
  const files = [
    { source: "gradle" as const, file: path.join(options.root, "android", "app", "build.gradle") },
    {
      source: "gradle" as const,
      file: path.join(options.root, "android", "app", "build.gradle.kts"),
    },
    { source: "expo" as const, file: path.join(options.root, "app.json") },
    { source: "expo" as const, file: path.join(options.root, "app.config.json") },
    { source: "expo" as const, file: path.join(options.root, "package.json") },
    {
      source: "manifest" as const,
      file: path.join(options.root, "android", "app", "src", "main", "AndroidManifest.xml"),
    },
  ];

  for (const entry of files) {
    if (!(await exists(entry.file))) continue;
    let raw: string;
    try {
      raw = await readText(entry.file);
    } catch {
      continue;
    }
    if (entry.source === "gradle") {
      for (const value of gradlePackages(raw)) {
        candidates.push({ value, source: entry.source, location: entry.file });
      }
    } else if (entry.source === "expo") {
      const value = jsonPackage(raw);
      if (value !== undefined)
        candidates.push({ value, source: entry.source, location: entry.file });
    } else {
      const value = manifestPackage(raw);
      if (value !== undefined)
        candidates.push({ value, source: entry.source, location: entry.file });
    }
  }
  return uniqueCandidates(candidates);
}

export async function resolveApplicationId(
  options: ResolveApplicationIdOptions,
): Promise<ApplicationIdResolution> {
  const considered: ApplicationIdCandidate[] = [];
  if (options.explicit !== undefined) {
    considered.push({ value: options.explicit, source: "cli" });
  }
  if (options.configured !== undefined) {
    considered.push({
      value: options.configured.value,
      source: "config",
      ...(options.configured.location === undefined
        ? {}
        : { location: options.configured.location }),
    });
  }
  considered.push(
    ...(await discoverProjectApplicationIds(options)),
    ...(options.installed ?? [])
      .filter(isApplicationId)
      .map((value) => ({ value, source: "installed" as const, detail: "selected target" })),
  );

  const normalized = uniqueCandidates(considered.filter(({ value }) => isApplicationId(value)));
  for (const source of SOURCE_PRECEDENCE) {
    const candidates = normalized.filter((candidate) => candidate.source === source);
    const values = [...new Set(candidates.map(({ value }) => value))];
    if (values.length === 1) {
      const applicationId = values[0];
      const provenance = candidates.find(({ value }) => value === applicationId);
      if (applicationId !== undefined && provenance !== undefined) {
        return { kind: "resolved", applicationId, provenance, considered: normalized };
      }
    }
    if (values.length > 1) return { kind: "ambiguous", candidates, considered: normalized };
  }
  return { kind: "not-found", considered: normalized };
}
