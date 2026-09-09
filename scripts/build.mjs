import { chmod, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sourceDirectory = fileURLToPath(new URL("../src", import.meta.url));
const outputDirectory = fileURLToPath(new URL("../dist", import.meta.url));

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
  await chmod(fileURLToPath(new URL("../dist/cli.js", import.meta.url)), 0o755);
}
