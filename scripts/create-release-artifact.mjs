import { createHash } from "node:crypto";
import { access, appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { xSync } from "tinyexec";
import { readNpmPackEntry } from "./lib/npm-pack-report.mjs";
import { createPackageConsumerEnvironment } from "./lib/package-manager-environment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputArgument = process.argv.indexOf("--output");
const outputValue = outputArgument === -1 ? undefined : process.argv[outputArgument + 1];

if (outputValue === undefined) {
  throw new Error("create-release-artifact requires --output PATH");
}

const outputDirectory = path.resolve(outputValue);
const artifact = path.join(outputDirectory, "adb-ready.tgz");
const npmConfig = path.join(outputDirectory, "consumer.npmrc");

await mkdir(outputDirectory, { recursive: true });
try {
  await access(artifact);
  throw new Error(`release artifact already exists: ${artifact}`);
} catch (caught) {
  if (!(caught instanceof Error && "code" in caught && caught.code === "ENOENT")) {
    throw caught;
  }
}

await writeFile(npmConfig, "registry=https://registry.npmjs.org/\n", { flag: "wx" });
const environment = createPackageConsumerEnvironment(process.env, npmConfig);
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const packed = xSync(
  "npm",
  ["pack", "--json", "--ignore-scripts", "--pack-destination", outputDirectory],
  {
    nodeOptions: {
      cwd: root,
      env: environment,
      shell: false,
      windowsHide: true,
    },
  },
);

if (packed.exitCode !== 0) {
  throw new Error(`npm pack failed with exit ${String(packed.exitCode)}\n${packed.stderr}`);
}

const report = JSON.parse(packed.stdout);
const filename = readNpmPackEntry(report, manifest.name).filename;
if (typeof filename !== "string") {
  throw new Error("npm pack did not return an artifact filename");
}

await rename(path.join(outputDirectory, filename), artifact);
const integrity = createHash("sha256")
  .update(await readFile(artifact))
  .digest("hex");
const githubOutput = process.env.GITHUB_OUTPUT;

if (githubOutput === undefined) {
  process.stdout.write(`${artifact}\nsha256 ${integrity}\n`);
} else {
  await appendFile(githubOutput, `tarball=${artifact}\nsha256=${integrity}\n`);
  process.stdout.write(`Created ${path.basename(artifact)} (${integrity})\n`);
}
