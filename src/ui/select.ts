import type { TextSink } from "./spinner.js";
import { sanitizeTerminalText, style, symbols } from "./style.js";
import type { TerminalCapabilities } from "./terminal.js";

export interface SelectOption<T> {
  value: T;
  label: string;
  description?: string;
  recommended?: boolean;
  disabled?: boolean;
}

export type SelectResult<T> =
  | { kind: "selected"; value: T }
  | { kind: "cancelled"; reason: "escape" | "interrupt" | "signal" }
  | { kind: "unavailable" };

export interface SelectInput {
  isRaw?: boolean;
  setRawMode?(enabled: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
  off(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
}

export interface SelectOptions<T> {
  title: string;
  options: readonly SelectOption<T>[];
  input: SelectInput;
  sink: TextSink;
  capabilities: TerminalCapabilities;
  signal?: AbortSignal;
  preamble?: (frame: number) => readonly string[];
  refreshIntervalMs?: number;
  help?: string;
}

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  return width <= 3 ? value.slice(0, width) : `${value.slice(0, width - 3)}...`;
}

function wrap(value: string, width: number): string[] {
  const clean = sanitizeTerminalText(value);
  if (clean.length <= width) {
    return [clean];
  }
  const lines: string[] = [];
  let line = "";
  for (const word of clean.split(" ")) {
    if (word.length > width) {
      if (line !== "") {
        lines.push(line);
        line = "";
      }
      for (let start = 0; start < word.length; start += width) {
        lines.push(word.slice(start, start + width));
      }
      continue;
    }
    const candidate = line === "" ? word : `${line} ${word}`;
    if (candidate.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== "") {
    lines.push(line);
  }
  return lines;
}

function nextEnabled<T>(
  options: readonly SelectOption<T>[],
  current: number,
  direction: -1 | 1,
): number {
  for (let offset = 1; offset <= options.length; offset += 1) {
    const candidate = (current + direction * offset + options.length) % options.length;
    if (options[candidate]?.disabled !== true) {
      return candidate;
    }
  }
  return current;
}

function initialIndex<T>(options: readonly SelectOption<T>[]): number {
  const recommended = options.findIndex(
    (option) => option.recommended === true && option.disabled !== true,
  );
  if (recommended !== -1) {
    return recommended;
  }
  return options.findIndex((option) => option.disabled !== true);
}

function renderMenu<T>(
  options: SelectOptions<T>,
  selected: number,
  previousLineCount: number,
  frame: number,
): number {
  const { capabilities, sink } = options;
  const glyphs = symbols(capabilities);
  if (previousLineCount > 0) {
    sink.write(`\u001B[${String(previousLineCount)}F`);
  }
  const top = capabilities.unicode ? "╭─" : "+-";
  const bottom = capabilities.unicode ? "╰─" : "+-";
  const rail = capabilities.unicode ? "│" : "|";
  const compact = capabilities.columns < 60;
  const help =
    options.help ??
    (capabilities.unicode ? "↑↓ move · 1-9 jump · enter open" : "up/down · 1-9 jump · enter open");
  const lines = [...(options.preamble?.(frame) ?? [])];
  lines.push(
    `${style.dim(top, capabilities)} ${style.strong(
      truncate(sanitizeTerminalText(options.title), Math.max(8, capabilities.columns - 4)),
      capabilities,
    )}`,
  );
  options.options.forEach((option, index) => {
    const isSelected = index === selected;
    const pointer = isSelected
      ? style.accent(glyphs.active, capabilities)
      : style.dim(option.disabled === true ? glyphs.skipped : glyphs.pending, capabilities);
    const number = style.dim(`[${String(index + 1)}]`, capabilities);
    const disabled = option.disabled === true ? "  · unavailable" : "";
    const recommended = option.recommended === true ? "  · recommended" : "";
    const label = truncate(
      `${sanitizeTerminalText(option.label)}${disabled}${recommended}`,
      Math.max(8, capabilities.columns - 10),
    );
    const styledLabel =
      option.disabled === true
        ? style.dim(label, capabilities)
        : isSelected
          ? style.strong(label, capabilities)
          : label;
    lines.push(`  ${pointer} ${number}  ${styledLabel}`);
    if (isSelected && option.description !== undefined) {
      for (const description of wrap(option.description, Math.max(10, capabilities.columns - 9))) {
        lines.push(
          `  ${style.accent(rail, capabilities)}      ${style.dim(description, capabilities)}`,
        );
      }
    }
  });
  lines.push(`${style.dim(bottom, capabilities)} ${style.dim(help, capabilities)}`);
  if (compact) {
    lines.push(`   ${style.dim("esc close", capabilities)}`);
  } else {
    lines[lines.length - 1] += style.dim(" · esc close", capabilities);
  }

  for (const line of lines) {
    sink.write(`\u001B[2K${line}\n`);
  }
  return lines.length;
}

export async function selectOne<T>(options: SelectOptions<T>): Promise<SelectResult<T>> {
  if (!options.capabilities.interactive || options.input.setRawMode === undefined) {
    return { kind: "unavailable" };
  }
  let selected = initialIndex(options.options);
  if (selected === -1) {
    return { kind: "unavailable" };
  }

  return await new Promise<SelectResult<T>>((resolve) => {
    const wasRaw = options.input.isRaw === true;
    let lineCount = 0;
    let frame = 0;
    let settled = false;
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    let escapeTimer: ReturnType<typeof setTimeout> | undefined;
    let bufferedInput = "";

    const attempt = (operation: () => unknown) => {
      try {
        operation();
      } catch {
        // Terminal cleanup is best-effort; every independent restoration must still run.
      }
    };
    const cleanup = () => {
      attempt(() => options.input.off("data", onData));
      attempt(() => options.signal?.removeEventListener("abort", onAbort));
      if (refreshTimer !== undefined) {
        clearInterval(refreshTimer);
      }
      if (escapeTimer !== undefined) {
        clearTimeout(escapeTimer);
      }
      if (!wasRaw) {
        attempt(() => options.input.setRawMode?.(false));
      }
      attempt(() => options.input.pause());
      attempt(() => options.sink.write("\u001B[?25h"));
    };
    const settle = (result: SelectResult<T>) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const draw = () => {
      lineCount = renderMenu(options, selected, lineCount, frame);
    };
    const onAbort = () => settle({ kind: "cancelled", reason: "signal" });
    const cancelEscape = () => {
      escapeTimer = undefined;
      settle({ kind: "cancelled", reason: "escape" });
    };
    const processInput = () => {
      while (!settled && bufferedInput !== "") {
        if (bufferedInput.startsWith("\u0003")) {
          settle({ kind: "cancelled", reason: "interrupt" });
          return;
        }
        if (bufferedInput.startsWith("\u001B[A")) {
          bufferedInput = bufferedInput.slice(3);
          selected = nextEnabled(options.options, selected, -1);
          draw();
          continue;
        }
        if (bufferedInput.startsWith("\u001B[B")) {
          bufferedInput = bufferedInput.slice(3);
          selected = nextEnabled(options.options, selected, 1);
          draw();
          continue;
        }
        if (bufferedInput.startsWith("\u001B")) {
          if (bufferedInput.length === 1) {
            escapeTimer ??= setTimeout(cancelEscape, 25);
            return;
          }
          cancelEscape();
          return;
        }
        const character = bufferedInput[0];
        bufferedInput = bufferedInput.slice(1);
        if (character === "\r" || character === "\n") {
          const selectedOption = options.options[selected];
          if (selectedOption !== undefined && selectedOption.disabled !== true) {
            settle({ kind: "selected", value: selectedOption.value });
          }
          return;
        }
        if (character !== undefined && /^[1-9]$/u.test(character)) {
          const index = Number(character) - 1;
          if (options.options[index] !== undefined && options.options[index]?.disabled !== true) {
            selected = index;
            draw();
          }
        }
      }
    };
    const onData = (chunk: Uint8Array | string) => {
      if (escapeTimer !== undefined) {
        clearTimeout(escapeTimer);
        escapeTimer = undefined;
      }
      bufferedInput += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      processInput();
    };

    try {
      options.sink.write("\u001B[?25l");
      options.input.setRawMode?.(true);
      options.input.resume();
      options.input.on("data", onData);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      draw();
      if (options.preamble !== undefined && options.capabilities.animation) {
        refreshTimer = setInterval(
          () => {
            frame += 1;
            draw();
          },
          Math.max(32, options.refreshIntervalMs ?? 90),
        );
      }
    } catch {
      settle({ kind: "unavailable" });
      return;
    }

    if (options.signal?.aborted) {
      onAbort();
    }
  });
}
