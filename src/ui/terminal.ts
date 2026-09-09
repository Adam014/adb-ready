import type { OutputFormat } from "../cli/arguments.js";

export interface TerminalPreferences {
  format: OutputFormat;
  nonInteractive: boolean;
  color?: boolean;
  unicode?: boolean;
  animation?: boolean;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
  inputIsTTY: boolean;
  outputIsTTY: boolean;
  columns?: number;
}

export interface TerminalCapabilities {
  interactive: boolean;
  color: boolean;
  unicode: boolean;
  animation: boolean;
  columns: number;
}

function environmentFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export function resolveTerminalCapabilities(
  preferences: TerminalPreferences,
): TerminalCapabilities {
  const env = preferences.env ?? {};
  const human = preferences.format === "human";
  const dumb = env.TERM?.toLowerCase() === "dumb";
  const ci = environmentFlag(env.CI);
  const reducedMotion = environmentFlag(env.ADB_READY_REDUCED_MOTION);
  const noColorEnvironment = Object.hasOwn(env, "NO_COLOR");
  const locale = `${env.LC_ALL ?? ""} ${env.LC_CTYPE ?? ""} ${env.LANG ?? ""}`;
  const localeSupportsUnicode = /UTF-?8/iu.test(locale);
  const interactive =
    human &&
    preferences.nonInteractive === false &&
    preferences.interactive !== false &&
    preferences.inputIsTTY &&
    preferences.outputIsTTY &&
    !ci &&
    !dumb;
  const colorPreference = preferences.color ?? !noColorEnvironment;
  const unicodePreference = preferences.unicode ?? localeSupportsUnicode;

  return {
    interactive,
    color: human && preferences.outputIsTTY && !dumb && colorPreference,
    unicode: human && unicodePreference,
    animation:
      interactive && preferences.animation !== false && !reducedMotion && !environmentFlag(env.CI),
    columns: Math.max(20, preferences.columns ?? 80),
  };
}
