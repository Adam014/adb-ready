/**
 * @typedef {{
 *   filename?: unknown,
 *   files?: unknown,
 *   name?: unknown,
 * }} NpmPackEntry
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize the npm 10 array report and the npm 12 package-keyed report.
 *
 * @param {unknown} report
 * @param {string} packageName
 * @returns {NpmPackEntry}
 */
export function readNpmPackEntry(report, packageName) {
  if (Array.isArray(report)) {
    const named = report.find((entry) => isRecord(entry) && entry.name === packageName);
    const candidate = named ?? (report.length === 1 ? report[0] : undefined);
    if (isRecord(candidate)) {
      return candidate;
    }
  } else if (isRecord(report)) {
    const candidate = report[packageName];
    if (isRecord(candidate)) {
      return candidate;
    }
  }

  throw new Error(`npm pack did not return a report for ${packageName}`);
}
