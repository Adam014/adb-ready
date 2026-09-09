import { type SelectInput, selectOne } from "./select.js";
import type { TextSink } from "./spinner.js";
import { style } from "./style.js";
import type { TerminalCapabilities } from "./terminal.js";

export type HomeAction = "devices" | "doctor" | "exit" | "help" | "version";
export type HomeResult =
  | { kind: "action"; action: HomeAction }
  | { kind: "cancelled"; reason: "interrupt" | "signal" }
  | { kind: "unavailable" };

export interface HomeScreenOptions {
  version: string;
  input: SelectInput;
  sink: TextSink;
  capabilities: TerminalCapabilities;
  signal?: AbortSignal;
  sleep?: (milliseconds: number) => Promise<void>;
}

const WIDE_LOGO = [
  "    _    ____  ____    ____  _____    _    ______   __",
  "   / \\  |  _ \\| __ )  |  _ \\| ____|  / \\  |  _ \\ \\ / /",
  "  / _ \\ | | | |  _ \\  | |_) |  _|   / _ \\ | | | | \\ V / ",
  " / ___ \\| |_| | |_) | |  _ <| |___ / ___ \\| |_| |  | |  ",
  "/_/   \\_\\____/|____/  |_| \\_\\_____/_/   \\_\\____/   |_|  ",
];

const COMPACT_LOGO = [
  "+----------------------+",
  "|  [>]  ADB READY     |",
  "|  ANDROID DEV LINK   |",
  "+----------------------+",
];

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function clearInteractiveScreen(sink: TextSink, capabilities: TerminalCapabilities): void {
  if (capabilities.interactive) {
    sink.write("\u001B[2J\u001B[H");
  }
}

async function renderSplash(options: HomeScreenOptions): Promise<void> {
  const { capabilities, sink } = options;
  const logo = capabilities.columns >= 64 ? WIDE_LOGO : COMPACT_LOGO;
  const sleep = options.sleep ?? defaultSleep;
  const delay = capabilities.animation ? 28 : 0;
  let cursorHidden = false;

  try {
    if (capabilities.animation) {
      sink.write("\u001B[?25l");
      cursorHidden = true;
    }
    for (const line of logo) {
      sink.write(`${style.accent(line, capabilities)}\n`);
      if (delay > 0) {
        await sleep(delay);
      }
    }

    if (capabilities.animation) {
      for (const frame of ["[·]", "[◆]", "[◈]"]) {
        sink.write(
          `\r\u001B[2K  ${style.accent(frame, capabilities)} establishing development link`,
        );
        await sleep(65);
      }
      sink.write("\r\u001B[2K");
    }
    sink.write(
      `  ${style.strong("ADB READY", capabilities)} ${style.dim("// Android target control, diagnostics, and dev sessions", capabilities)}\n\n`,
    );
  } finally {
    if (cursorHidden) {
      sink.write("\u001B[?25h");
    }
  }
}

export async function showHomeScreen(options: HomeScreenOptions): Promise<HomeResult> {
  if (!options.capabilities.interactive) {
    return { kind: "unavailable" };
  }

  clearInteractiveScreen(options.sink, options.capabilities);
  await renderSplash(options);
  const selection = await selectOne({
    title: `ADB Ready ${options.version} · choose a workflow`,
    options: [
      {
        value: "dev" as const,
        label: "Start development session",
        description: "Prepare target, ports, and app command · coming in Phase 1",
        disabled: true,
      },
      {
        value: "doctor" as const,
        label: "Run environment doctor",
        description: "Inspect runtime, ADB capabilities, server, and targets",
        recommended: true,
      },
      {
        value: "devices" as const,
        label: "Browse Android targets",
        description: "List visible devices and emulators",
      },
      {
        value: "pair" as const,
        label: "Connect or pair wirelessly",
        description: "Guided Wireless debugging setup · coming in Phase 1",
        disabled: true,
      },
      { value: "version" as const, label: "Show version", description: options.version },
      {
        value: "help" as const,
        label: "Command reference",
        description: "Flags and automation modes",
      },
      { value: "exit" as const, label: "Exit", description: "Return to your shell" },
    ],
    input: options.input,
    sink: options.sink,
    capabilities: options.capabilities,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (selection.kind === "unavailable") {
    return selection;
  }
  if (selection.kind === "cancelled") {
    return selection.reason === "escape"
      ? { kind: "action", action: "exit" }
      : { kind: "cancelled", reason: selection.reason };
  }
  if (selection.value === "dev" || selection.value === "pair") {
    return { kind: "unavailable" };
  }
  return { kind: "action", action: selection.value };
}
