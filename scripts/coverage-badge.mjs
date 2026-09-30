import { readFile, writeFile } from "node:fs/promises";

import { summarizeLcov } from "./lib/lcov-summary.mjs";

const [, , input, output] = process.argv;

if (!input || !output) {
  process.stderr.write(
    "Usage: node scripts/coverage-badge.mjs <coverage/lcov.info|--fallback> <output.svg>\n",
  );
  process.exit(1);
}

const percentage =
  input === "--fallback"
    ? undefined
    : summarizeLcov(await readFile(input, "utf8")).lines.ratio * 100;
const message = percentage === undefined ? "≥95%" : `${percentage.toFixed(2)}%`;
const color =
  percentage === undefined || percentage >= 95
    ? "#2ea44f"
    : percentage >= 90
      ? "#d97706"
      : "#c43d3d";
const ariaLabel = `coverage: ${message}`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="119" height="20" role="img" aria-label="${ariaLabel}">
  <title>${ariaLabel}</title>
  <clipPath id="r"><rect width="119" height="20" rx="3"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="64" height="20" fill="#555"/>
    <rect x="64" width="55" height="20" fill="${color}"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="32" y="14">coverage</text>
    <text x="91.5" y="14">${message}</text>
  </g>
</svg>
`;

await writeFile(output, svg, "utf8");
process.stdout.write(`Coverage badge: ${message} -> ${output}\n`);
