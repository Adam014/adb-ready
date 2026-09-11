import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { xSync } from "tinyexec";

import { readNpmPackEntry } from "./lib/npm-pack-report.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const publishMode = process.argv[2] === "--publish";
const expectedTag = publishMode ? process.argv[3] : undefined;
/** @type {string[]} */
const errors = [];

/** @param {boolean} condition @param {string} message */
function requireCondition(condition, message) {
  if (!condition) errors.push(message);
}

/** @param {string} name */
async function requireFile(name) {
  try {
    await access(new URL(`../${name}`, import.meta.url));
  } catch {
    errors.push(`required release file is missing: ${name}`);
  }
}

requireCondition(manifest.name === "adb-ready", "package name must remain adb-ready");
requireCondition(
  typeof manifest.version === "string" &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version),
  "package version must be a valid release or prerelease version",
);
requireCondition(
  typeof manifest.description === "string" && manifest.description.trim().length >= 20,
  "package description must explain the product",
);
requireCondition(manifest.license === "MIT", "package license must match LICENSE (MIT)");
requireCondition(
  manifest.repository?.url === "git+https://github.com/Adam014/adb-ready.git",
  "repository URL must exactly identify the trusted-publishing repository",
);
requireCondition(
  manifest.bugs?.url === "https://github.com/Adam014/adb-ready/issues",
  "package bugs URL is missing or incorrect",
);
requireCondition(
  manifest.homepage === "https://github.com/Adam014/adb-ready#readme",
  "package homepage is missing or incorrect",
);
requireCondition(
  manifest.bin?.["adb-ready"] === "dist/cli.js" && manifest.bin?.adbr === "dist/cli.js",
  "both executable names must resolve to dist/cli.js",
);
requireCondition(manifest.engines?.node === ">=22", "the supported Node.js floor must be explicit");
requireCondition(manifest.publishConfig?.access === "public", "npm access must be public");
requireCondition(manifest.publishConfig?.provenance === true, "npm provenance must be enabled");

for (const name of [
  "CHANGELOG.md",
  "COMPATIBILITY.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "llms.txt",
  "README.md",
  "SECURITY.md",
]) {
  await requireFile(name);
}

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const security = await readFile(new URL("../SECURITY.md", import.meta.url), "utf8");
const markdownInventory = xSync("git", ["ls-files", "*.md"], {
  nodeOptions: { cwd: root, shell: false, windowsHide: true },
});
const publicMarkdown =
  markdownInventory.exitCode === 0
    ? await Promise.all(
        markdownInventory.stdout
          .split(/\r?\n/u)
          .filter(Boolean)
          .map(async (file) => ({
            file,
            value: await readFile(new URL(`../${file}`, import.meta.url), "utf8"),
          })),
      )
    : [{ file: "README.md", value: readme }];
const stableVersion = /^\d+\.\d+\.\d+$/u.test(manifest.version);
const releaseReady = publishMode || stableVersion;

if (releaseReady) {
  const [major, minor] = manifest.version.split(".");
  const supportedReleaseLine = `| \`${major}.${minor}.x\` | Yes |`;
  requireCondition(manifest.private === false, "remove the private publish guard before release");
  requireCondition(stableVersion, "public release version cannot be a prerelease");
  requireCondition(
    security.includes(supportedReleaseLine),
    `SECURITY.md must mark ${major}.${minor}.x as supported`,
  );
  if (publishMode) {
    requireCondition(
      expectedTag === `v${manifest.version}`,
      "Git tag must exactly match package version",
    );
  }
  requireCondition(
    changelog.includes(`## [${manifest.version}]`),
    `CHANGELOG.md needs a ${manifest.version} release section`,
  );
  const alphaDocuments = publicMarkdown
    .filter(({ value }) => value.includes("@alpha"))
    .map(({ file }) => file);
  requireCondition(
    alphaDocuments.length === 0,
    `public documentation still contains alpha install commands: ${alphaDocuments.join(", ")}`,
  );
  requireCondition(
    !/private during release-candidate|published npm tag is an early preview/iu.test(readme),
    "README.md still describes a private preview",
  );
} else {
  requireCondition(
    manifest.private === true,
    "pre-release work must retain the private publish guard",
  );
}

const packed = xSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  nodeOptions: { cwd: root, shell: false, windowsHide: true },
});
if (packed.exitCode !== 0) {
  errors.push(`npm pack failed: ${packed.stderr.trim()}`);
} else {
  try {
    const report = JSON.parse(packed.stdout);
    const packEntry = readNpmPackEntry(report, manifest.name);
    const files = Array.isArray(packEntry.files)
      ? packEntry.files
          .map((entry) => (typeof entry === "object" && entry !== null ? entry.path : undefined))
          .filter((entry) => typeof entry === "string")
      : [];
    for (const required of [
      "CHANGELOG.md",
      "COMPATIBILITY.md",
      "LICENSE",
      "llms.txt",
      "README.md",
      "dist/cli.js",
      "docs/getting-started.md",
      "examples/expo/adb-ready.config.json",
      "package.json",
      "schema/config-v1.schema.json",
      "schema/agent-tools-v1.json",
    ]) {
      requireCondition(files.includes(required), `packed artifact is missing ${required}`);
    }
    const forbidden = files.filter((file) =>
      /^(AGENTS\.md|context\/|scripts\/|src\/|tests\/|node_modules\/|bun\.lock$)/u.test(file),
    );
    requireCondition(
      forbidden.length === 0,
      `packed artifact contains private or development files: ${forbidden.join(", ")}`,
    );
  } catch {
    errors.push("npm pack did not return a valid JSON inventory");
  }
}

if (errors.length > 0) {
  process.stderr.write(
    `Release check failed:\n${errors.map((error) => `- ${error}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  publishMode
    ? `Release ${manifest.version} is structurally ready for npm publishing.\n`
    : `Release ${manifest.version} is structurally ready; tagged CI performs publishing.\n`,
);
