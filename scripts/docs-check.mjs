import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const topLevel = [
  "CHANGELOG.md",
  "COMPATIBILITY.md",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
];

/** @param {string} directory */
async function markdownBelow(directory) {
  const absolute = path.join(root, directory);
  const entries = await readdir(absolute, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => path.join(directory, entry));
}

const files = [
  ...topLevel,
  ...(await markdownBelow("docs")),
  ...(await markdownBelow("examples")),
].sort();
/** @type {Map<string, string>} */
const documents = new Map();
/** @type {string[]} */
const errors = [];

/** @param {string} value */
function anchor(value) {
  return value
    .toLowerCase()
    .replace(/<[^>]+>/gu, "")
    .replace(/[`*_~]/gu, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/gu, "-");
}

/** @param {string} markdown */
function anchorsFor(markdown) {
  return new Set(
    markdown.split(/\r?\n/u).flatMap((line) => {
      const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/u)?.[1];
      return heading === undefined ? [] : [anchor(heading)];
    }),
  );
}

for (const file of files) {
  documents.set(file, await readFile(path.join(root, file), "utf8"));
}

for (const [file, markdown] of documents) {
  if (/\]\((?:file|vscode):\/\//u.test(markdown)) {
    errors.push(`${file}: local URI schemes are not public links`);
  }
  if (/\]\((?:\.\.\/)*context(?:\/|\)|#)/u.test(markdown)) {
    errors.push(`${file}: public documentation links to private context`);
  }

  for (const match of markdown.matchAll(/```json\s*\n([\s\S]*?)```/gu)) {
    try {
      JSON.parse(match[1] ?? "");
    } catch (error) {
      errors.push(
        `${file}: invalid fenced JSON (${error instanceof Error ? error.message : "unknown error"})`,
      );
    }
  }

  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const destination = match[1]?.trim();
    if (
      destination === undefined ||
      destination === "" ||
      destination.startsWith("#") ||
      /^(?:https?|mailto):/u.test(destination)
    ) {
      continue;
    }
    const [rawFile, rawAnchor] = destination.split("#", 2);
    const target = path.normalize(path.join(path.dirname(file), decodeURIComponent(rawFile ?? "")));
    if (path.isAbsolute(target) || target.startsWith(`..${path.sep}`)) {
      errors.push(`${file}: link escapes the repository (${destination})`);
      continue;
    }
    try {
      await access(path.join(root, target));
    } catch {
      errors.push(`${file}: missing link target (${destination})`);
      continue;
    }
    if (rawAnchor !== undefined && target.endsWith(".md")) {
      const targetMarkdown =
        documents.get(target) ?? (await readFile(path.join(root, target), "utf8"));
      if (!anchorsFor(targetMarkdown).has(rawAnchor)) {
        errors.push(`${file}: missing heading anchor (${destination})`);
      }
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(
    `Public documentation check failed:\n${errors.map((error) => `- ${error}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Public documentation: ${String(files.length)} files, valid JSON examples, valid local links.\n`,
);
