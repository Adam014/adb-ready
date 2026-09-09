import { homedir } from "node:os";

export interface RedactionResult {
  value: string;
  replacements: number;
}

export interface RedactionOptions {
  homeDirectory?: string;
  additionalLiterals?: readonly string[];
}

const REDACTED = "[REDACTED]";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceAndCount(
  input: string,
  expression: RegExp,
  replacement: string | ((substring: string, ...args: string[]) => string),
): RedactionResult {
  let replacements = 0;
  const value = input.replace(expression, (...args: [string, ...string[]]) => {
    replacements += 1;
    return typeof replacement === "string" ? replacement : replacement(...args);
  });
  return { value, replacements };
}

export function redactText(input: string, options: RedactionOptions = {}): RedactionResult {
  let value = input;
  let replacements = 0;

  const patterns: Array<{
    expression: RegExp;
    replacement: string | ((substring: string, ...args: string[]) => string);
  }> = [
    {
      expression: /\b((?:authorization\s*[:=]\s*)?Bearer)\s+[^\s,;]+/giu,
      replacement: (_match, prefix) => `${prefix} ${REDACTED}`,
    },
    {
      expression:
        /\b(api[_-]?key|access[_-]?token|auth|password|passwd|secret)\b(\s*[:=]\s*)(["']?)[^\s,"';]+\3/giu,
      replacement: (_match, name, separator) => `${name}${separator}${REDACTED}`,
    },
    {
      expression: /\b(authorization)(\s*[:=]\s*)(?!Bearer\b)(["']?)[^\s,"';]+\3/giu,
      replacement: (_match, name, separator) => `${name}${separator}${REDACTED}`,
    },
    {
      expression: /\b(pair(?:ing)?(?:\s+code)?)(\s*[:=]\s*)\d{6}\b/giu,
      replacement: (_match, name, separator) => `${name}${separator}${REDACTED}`,
    },
    {
      expression: /([?&](?:access_token|api_key|apikey|auth|password|secret|token)=)[^&#\s]*/giu,
      replacement: (_match, prefix) => `${prefix}${REDACTED}`,
    },
  ];

  for (const pattern of patterns) {
    const result = replaceAndCount(value, pattern.expression, pattern.replacement);
    value = result.value;
    replacements += result.replacements;
  }

  const homeDirectory = options.homeDirectory ?? homedir();
  if (homeDirectory.length > 1) {
    const result = replaceAndCount(value, new RegExp(escapeRegExp(homeDirectory), "gu"), "~");
    value = result.value;
    replacements += result.replacements;
  }

  for (const literal of options.additionalLiterals ?? []) {
    if (literal === "") {
      continue;
    }
    const result = replaceAndCount(value, new RegExp(escapeRegExp(literal), "gu"), REDACTED);
    value = result.value;
    replacements += result.replacements;
  }

  return { value, replacements };
}
