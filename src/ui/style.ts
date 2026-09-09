import type { TerminalCapabilities } from "./terminal.js";

const ANSI_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal sanitization intentionally matches ANSI control bytes.
  /[\x1B\x9B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\\/#&.:=?%@~_]+)*)?\x07)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: untrusted terminal text must not retain C0/C1 controls.
const CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/gu;

export interface Symbols {
  active: string;
  failure: string;
  pending: string;
  recovered: string;
  skipped: string;
  success: string;
  warning: string;
  branch: string;
  end: string;
}

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(ANSI_PATTERN, "")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("\t", " ")
    .replace(CONTROL_PATTERN, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

export function symbols(capabilities: TerminalCapabilities): Symbols {
  return capabilities.unicode
    ? {
        active: "◆",
        failure: "✕",
        pending: "○",
        recovered: "↻",
        skipped: "–",
        success: "✓",
        warning: "!",
        branch: "├─",
        end: "└─",
      }
    : {
        active: ">",
        failure: "x",
        pending: "o",
        recovered: "~",
        skipped: "-",
        success: "+",
        warning: "!",
        branch: "|-",
        end: "`-",
      };
}

function color(code: number, value: string, capabilities: TerminalCapabilities): string {
  return capabilities.color ? `\u001B[${String(code)}m${value}\u001B[0m` : value;
}

export const style = {
  accent: (value: string, capabilities: TerminalCapabilities) => color(36, value, capabilities),
  dim: (value: string, capabilities: TerminalCapabilities) => color(2, value, capabilities),
  failure: (value: string, capabilities: TerminalCapabilities) => color(31, value, capabilities),
  strong: (value: string, capabilities: TerminalCapabilities) => color(1, value, capabilities),
  success: (value: string, capabilities: TerminalCapabilities) => color(32, value, capabilities),
  warning: (value: string, capabilities: TerminalCapabilities) => color(33, value, capabilities),
};
