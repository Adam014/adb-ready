/**
 * @param {string} report
 * @returns {{ lines: { found: number; hit: number; ratio: number }; functions: { found: number; hit: number; ratio: number } }}
 */
export function summarizeLcov(report) {
  const totals = {
    lines: { found: 0, hit: 0 },
    functions: { found: 0, hit: 0 },
  };

  for (const line of report.split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const value = Number.parseInt(line.slice(separator + 1), 10);
    if (!Number.isSafeInteger(value) || value < 0) continue;

    if (key === "LF") totals.lines.found += value;
    if (key === "LH") totals.lines.hit += value;
    if (key === "FNF") totals.functions.found += value;
    if (key === "FNH") totals.functions.hit += value;
  }

  if (totals.lines.found === 0 || totals.functions.found === 0) {
    throw new Error("LCOV report contains no measurable lines or functions");
  }
  if (totals.lines.hit > totals.lines.found || totals.functions.hit > totals.functions.found) {
    throw new Error("LCOV hit counts exceed measurable totals");
  }

  return {
    lines: {
      ...totals.lines,
      ratio: totals.lines.hit / totals.lines.found,
    },
    functions: {
      ...totals.functions,
      ratio: totals.functions.hit / totals.functions.found,
    },
  };
}
