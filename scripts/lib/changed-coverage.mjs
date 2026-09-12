const TRACKED_PATHS = /^(?:src\/.*\.ts|scripts\/lib\/.*\.mjs)$/u;

/** @param {string} value */
function normalizePath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

/**
 * @param {string} report
 * @returns {Map<string, Map<number, number>>}
 */
export function parseLcovLineHits(report) {
  const files = new Map();
  /** @type {Map<number, number> | undefined} */
  let current;

  for (const line of report.split(/\r?\n/u)) {
    if (line.startsWith("SF:")) {
      const source = normalizePath(line.slice(3));
      current = new Map();
      files.set(source, current);
      continue;
    }
    if (line === "end_of_record") {
      current = undefined;
      continue;
    }
    if (current === undefined || !line.startsWith("DA:")) continue;
    const [lineText, hitsText] = line.slice(3).split(",", 2);
    const lineNumber = Number(lineText);
    const hits = Number(hitsText);
    if (
      Number.isSafeInteger(lineNumber) &&
      lineNumber > 0 &&
      Number.isSafeInteger(hits) &&
      hits >= 0
    ) {
      current.set(lineNumber, hits);
    }
  }

  return files;
}

/**
 * Parse the zero-context unified diff produced by the coverage workflow.
 * Each new hunk range contains only added or replaced lines.
 * @param {string} diff
 * @returns {Map<string, Set<number>>}
 */
export function parseAddedLines(diff) {
  const files = new Map();
  /** @type {Set<number> | undefined} */
  let current;

  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      if (path === "/dev/null") {
        current = undefined;
        continue;
      }
      const normalized = normalizePath(path.startsWith("b/") ? path.slice(2) : path);
      current = files.get(normalized) ?? new Set();
      files.set(normalized, current);
      continue;
    }
    if (current === undefined || !line.startsWith("@@ ")) continue;
    const range = line.match(/\+(\d+)(?:,(\d+))?\s/u);
    if (range === null) continue;
    const start = Number(range[1]);
    const count = range[2] === undefined ? 1 : Number(range[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 1) continue;
    for (let offset = 0; offset < count; offset += 1) current.add(start + offset);
  }

  return files;
}

/**
 * @param {string} report
 * @param {string} diff
 * @returns {{ found: number; hit: number; ratio: number; files: number; missingFiles: string[] }}
 */
export function changedLineCoverage(report, diff) {
  const coverage = parseLcovLineHits(report);
  const changed = parseAddedLines(diff);
  let found = 0;
  let hit = 0;
  let files = 0;
  const missingFiles = [];

  for (const [file, lines] of changed) {
    if (!TRACKED_PATHS.test(file) || lines.size === 0) continue;
    files += 1;
    const absoluteSuffix = `/${file}`;
    const lineHits =
      coverage.get(file) ??
      [...coverage.entries()].find(([source]) => source.endsWith(absoluteSuffix))?.[1];
    if (lineHits === undefined) {
      missingFiles.push(file);
      continue;
    }
    for (const line of lines) {
      const hits = lineHits.get(line);
      if (hits === undefined) continue;
      found += 1;
      if (hits > 0) hit += 1;
    }
  }

  return {
    found,
    hit,
    ratio: found === 0 ? 1 : hit / found,
    files,
    missingFiles: missingFiles.sort(),
  };
}
