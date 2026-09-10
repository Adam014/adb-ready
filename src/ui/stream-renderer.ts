import { parseLogcatThreadtimeLine } from "../adb/parsers.js";
import { sanitizeTerminalText, style } from "./style.js";
import type { TerminalCapabilities } from "./terminal.js";

const ERROR_LINE = /(?:^|\s)(?:err!|error|fatal|exception|failed|failure|crash)(?::|\b)/iu;
const WARNING_LINE = /(?:^|\s)(?:warn|warning|deprecated|deprecation)(?::|\b)/iu;
const SUCCESS_LINE = /(?:^|\s)(?:ready|started|bundled|done|success|completed)(?::|\b)/iu;
const PROGRESS_LINE = /(?:^|\s)(?:starting|building|bundling|opening|waiting)(?::|\b)/iu;

export function renderLogStreamLine(line: string, capabilities: TerminalCapabilities): string {
  const safe = sanitizeTerminalText(line);
  const parsed = parseLogcatThreadtimeLine(safe);
  if (parsed?.priority === "E" || parsed?.priority === "F" || parsed?.priority === "A") {
    return style.failure(safe, capabilities);
  }
  if (parsed?.priority === "W") return style.warning(safe, capabilities);
  if (parsed?.priority === "D" || parsed?.priority === "V") {
    return style.dim(safe, capabilities);
  }
  if (parsed?.priority === "I") return style.accent(safe, capabilities);
  if (ERROR_LINE.test(safe)) return style.failure(safe, capabilities);
  if (WARNING_LINE.test(safe)) return style.warning(safe, capabilities);
  return safe;
}

export function renderChildStreamLine(
  stream: "stderr" | "stdout",
  line: string,
  capabilities: TerminalCapabilities,
): string {
  const safe = sanitizeTerminalText(line);
  const prefix = style.dim(stream === "stderr" ? "│" : " ", capabilities);
  const rendered = ERROR_LINE.test(safe)
    ? style.failure(safe, capabilities)
    : WARNING_LINE.test(safe)
      ? style.warning(safe, capabilities)
      : SUCCESS_LINE.test(safe)
        ? style.success(safe, capabilities)
        : PROGRESS_LINE.test(safe)
          ? style.accent(safe, capabilities)
          : safe;
  return `${prefix} ${rendered}`;
}
