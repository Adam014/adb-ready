import { renderLinkCoreFrame } from "./ascii-scene.js";
import { type SelectInput, selectOne } from "./select.js";
import type { TextSink } from "./spinner.js";
import { style } from "./style.js";
import type { TerminalCapabilities } from "./terminal.js";

export type HomeAction =
  | "connect"
  | "context"
  | "dev"
  | "devices"
  | "doctor"
  | "exit"
  | "help"
  | "init"
  | "logs"
  | "pair"
  | "sessions"
  | "version";
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
  refreshIntervalMs?: number;
  presentation?: "full" | "menu";
}

function fit(value: string, width: number): string {
  if (value.length <= width) {
    return value.padEnd(width);
  }
  return width <= 3 ? value.slice(0, width) : `${value.slice(0, width - 3)}...`;
}

function productPanel(version: string, capabilities: TerminalCapabilities): string[] {
  const unicode = capabilities.unicode;
  const width = 36;
  const inner = width - 4;
  const top = unicode ? `╭─${"─".repeat(width - 4)}╮` : `+-${"-".repeat(width - 4)}+`;
  const bottom = unicode ? `╰${"─".repeat(width - 2)}╯` : `+${"-".repeat(width - 2)}+`;
  const side = unicode ? "│" : "|";
  const rows = [
    "ADB READY",
    "Android sessions. Kept ready.",
    "",
    "RUN    one target and dev command",
    "WATCH  ports, target, and logs",
    "SHARE  redacted AI context",
    "",
    `adb-ready  v${version}`,
  ];
  return [
    style.dim(top, capabilities),
    ...rows.map((row, index) => {
      const content = fit(row, inner);
      const styled =
        index === 0
          ? style.strong(content, capabilities)
          : index === 1
            ? style.accent(content, capabilities)
            : style.dim(content, capabilities);
      return `${style.dim(side, capabilities)} ${styled} ${style.dim(side, capabilities)}`;
    }),
    style.dim(bottom, capabilities),
  ];
}

function center(value: string, width: number): string {
  const padding = Math.max(0, Math.floor((width - value.length) / 2));
  return `${" ".repeat(padding)}${value}`;
}

function homePreamble(
  frame: number,
  version: string,
  capabilities: TerminalCapabilities,
): string[] {
  const angleX = 0.38 + Math.sin(frame * 0.035) * 0.12;
  const angleY = frame * 0.045;

  if (capabilities.columns < 76) {
    const width = Math.max(20, Math.min(34, capabilities.columns - 4));
    const core = renderLinkCoreFrame({ angleX, angleY, width, height: 12 });
    return [
      ...core.map((line) => style.accent(center(line, capabilities.columns), capabilities)),
      "",
      style.strong(center("ADB READY", capabilities.columns), capabilities),
      style.dim(center("Android sessions. Kept ready.", capabilities.columns), capabilities),
      style.dim(center(`v${version}`, capabilities.columns), capabilities),
      "",
    ];
  }

  const coreWidth = 36;
  const core = renderLinkCoreFrame({ angleX, angleY, width: coreWidth, height: 14 });
  const panel = productPanel(version, capabilities);
  const panelOffset = 2;
  return core
    .map((line, index) => {
      const left = style.accent(line.padEnd(coreWidth), capabilities);
      const right = index >= panelOffset ? (panel[index - panelOffset] ?? "") : "";
      return `${left}    ${right}`.trimEnd();
    })
    .concat("");
}

const COMPACT_WORDMARK = [
  " ##  ###  ###    ###  ####  ##  ###  #  #",
  "#  # #  # #  #   #  # #    #  # #  # #  #",
  "#### #  # ###    ###  ###  #### #  #  ## ",
  "#  # #  # #  #   # #  #    #  # #  #  #  ",
  "#  # ###  ###    #  # #### #  # ###   #  ",
];

function compactSessionPreamble(capabilities: TerminalCapabilities): string[] {
  const unicode = capabilities.unicode;
  const width = Math.max(20, Math.min(45, capabilities.columns));
  const inner = width - 4;
  const top = unicode ? `╭${"─".repeat(width - 2)}╮` : `+${"-".repeat(width - 2)}+`;
  const bottom = unicode ? `╰${"─".repeat(width - 2)}╯` : `+${"-".repeat(width - 2)}+`;
  const side = unicode ? "│" : "|";
  const wordmark = width >= 45 ? COMPACT_WORDMARK : ["ADB READY"];
  const rows = wordmark.map((line) => {
    const content = fit(center(line, inner), inner);
    return `${style.dim(side, capabilities)} ${style.accent(content, capabilities)} ${style.dim(side, capabilities)}`;
  });

  return ["", style.dim(top, capabilities), ...rows, style.dim(bottom, capabilities), ""];
}

export function clearInteractiveScreen(sink: TextSink, capabilities: TerminalCapabilities): void {
  if (capabilities.interactive) {
    sink.write("\u001B[2J\u001B[H");
  }
}

export async function showHomeScreen(options: HomeScreenOptions): Promise<HomeResult> {
  if (!options.capabilities.interactive) {
    return { kind: "unavailable" };
  }

  const presentation = options.presentation ?? "full";
  if (presentation === "full") {
    clearInteractiveScreen(options.sink, options.capabilities);
  }
  const selection = await selectOne({
    title: presentation === "full" ? "WHAT DO YOU WANT TO DO?" : "ACTIONS",
    options: [
      {
        value: "dev" as const,
        label: "Start development session",
        description: "Prepare one target, ports, logs, and your project command",
        recommended: true,
      },
      {
        value: "logs" as const,
        label: "Inspect app logs",
        description: "Stream or dump redacted logs by package, PID, tag, and level",
      },
      {
        value: "doctor" as const,
        label: "Check my setup",
        description: "Validate runtime, ADB, server, and target access",
      },
      {
        value: "devices" as const,
        label: "Show Android targets",
        description: "See connected devices and running emulators",
      },
      {
        value: "connect" as const,
        label: "Connect wirelessly",
        description: "Discover and verify a Wireless debugging target",
      },
      {
        value: "pair" as const,
        label: "Pair a new target",
        description: "Use Android's hidden six-digit pairing code",
      },
      {
        value: "sessions" as const,
        label: "Browse saved sessions",
        description: "Review private run summaries and diagnostic timelines",
      },
      {
        value: "context" as const,
        label: "Create AI debug context",
        description: "Export a bounded redacted Markdown brief from the latest run",
      },
      {
        value: "version" as const,
        label: "Show version",
        description: `ADB Ready ${options.version}`,
      },
      {
        value: "init" as const,
        label: "Initialize this project",
        description: "Create a validated config from detected project signals",
      },
      {
        value: "help" as const,
        label: "View command reference",
        description: "Explore commands, flags, and automation output",
      },
      { value: "exit" as const, label: "Exit", description: "Close ADB Ready" },
    ],
    input: options.input,
    sink: options.sink,
    capabilities:
      presentation === "full"
        ? options.capabilities
        : { ...options.capabilities, animation: false },
    preamble: (frame: number) =>
      presentation === "full"
        ? homePreamble(frame, options.version, options.capabilities)
        : compactSessionPreamble(options.capabilities),
    ...(options.refreshIntervalMs === undefined
      ? {}
      : { refreshIntervalMs: options.refreshIntervalMs }),
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
  return { kind: "action", action: selection.value };
}
