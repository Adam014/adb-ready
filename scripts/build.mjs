import { chmod, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { generateAgentContract } from "./lib/generate-agent-contract.mjs";

const sourceDirectory = fileURLToPath(new URL("../src", import.meta.url));
const outputDirectory = fileURLToPath(new URL("../dist", import.meta.url));
const root = fileURLToPath(new URL("../", import.meta.url));

await rm(outputDirectory, { force: true, recursive: true });

const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../src/cli.ts", import.meta.url))],
  format: "esm",
  minify: false,
  outdir: outputDirectory,
  root: sourceDirectory,
  sourcemap: "external",
  target: "node",
});

if (!result.success) {
  for (const message of result.logs) {
    console.error(message);
  }
  process.exitCode = 1;
} else {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  await chmod(cli, 0o755);
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  await generateAgentContract({ cli, root, version: manifest.version });
}
