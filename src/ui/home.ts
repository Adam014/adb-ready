import { renderLinkCoreFrame } from "./ascii-scene.js";
import { type SelectInput, type SelectOption, selectOne } from "./select.js";
import type { TextSink } from "./spinner.js";
import { style } from "./style.js";
import type { TerminalCapabilities } from "./terminal.js";

export type HomeAction =
  | "app-info"
  | "app-restart"
  | "capture-screenshot"
  | "connect"
  | "context"
  | "dev"
  | "devices"
  | "doctor"
  | "exit"
  | "help"
  | "init"
  | "inspect-app"
  | "inspect-ui"
  | "logs"
  | "pair"
  | "sessions"
  | "version";
type HomeSection = "debug" | "device" | "project";
type HomeMenuValue = HomeAction | HomeSection;
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
  if (presentation === "full") clearInteractiveScreen(options.sink, options.capabilities);

  const rootOptions: ReadonlyArray<SelectOption<HomeMenuValue>> = [
    {
      value: "dev" as const,
      label: "Start development",
      description: "Prepare one target, ports, logs, and your project command.",
      recommended: true,
    },
    {
      value: "device" as const,
      label: "Device & app",
      description: "Find, connect, and manage the Android target used by this project.",
    },
    {
      value: "debug" as const,
      label: "Debug & evidence",
      description: "Follow useful signals and collect a shareable record of a failure.",
    },
    {
      value: "project" as const,
      label: "Project & setup",
      description: "Validate this machine, configure the project, or find a command.",
    },
    { value: "exit" as const, label: "Exit", description: "Close ADB Ready." },
  ];
  const sectionOptions: Record<HomeSection, ReadonlyArray<SelectOption<HomeMenuValue>>> = {
    device: [
      {
        value: "devices",
        label: "Android targets",
        description: "See connected devices, emulators, and unavailable targets.",
      },
      {
        value: "app-info",
        label: "Project app details",
        description: "Resolve the project app and check its installed state.",
      },
      {
        value: "app-restart",
        label: "Restart project app",
        description: "Verify a clean stop and launch on the selected target.",
      },
      {
        value: "connect",
        label: "Connect wirelessly",
        description: "Discover and verify an already paired Wireless debugging target.",
      },
      {
        value: "pair",
        label: "Pair a new target",
        description: "Pair safely with Android's temporary six-digit code.",
      },
    ],
    debug: [
      {
        value: "inspect-app",
        label: "Inspect project app",
        description: "Collect app state and a small classified log window.",
      },
      {
        value: "inspect-ui",
        label: "Inspect current UI",
        description: "Read a bounded, sensitive accessibility snapshot.",
      },
      {
        value: "capture-screenshot",
        label: "Capture screenshot",
        description: "Save a verified PNG inside this project.",
      },
      {
        value: "logs",
        label: "Follow app logs",
        description: "Stream focused, redacted Android logs for one target.",
      },
      {
        value: "sessions",
        label: "Saved sessions",
        description: "Review recent runs and their bounded diagnostic timeline.",
      },
      {
        value: "context",
        label: "Create AI context",
        description: "Build a compact, redacted brief from the latest session.",
      },
    ],
    project: [
      {
        value: "doctor",
        label: "Check environment",
        description: "Validate runtime, ADB, server, and target access.",
      },
      {
        value: "init",
        label: "Initialize project",
        description: "Create a validated config from detected project signals.",
      },
      {
        value: "help",
        label: "Command reference",
        description: "Explore commands, flags, and automation output.",
      },
      {
        value: "version",
        label: "Version",
        description: `ADB Ready ${options.version}`,
      },
    ],
  };

  let section: HomeSection | undefined;
  let firstRender = true;
  while (true) {
    const atRoot = section === undefined;
    const currentOptions: ReadonlyArray<SelectOption<HomeMenuValue>> = atRoot
      ? rootOptions
      : sectionOptions[section ?? "device"];
    const selection = await selectOne<HomeMenuValue>({
      title: atRoot
        ? "WHAT DO YOU WANT TO DO?"
        : `HOME / ${section === "device" ? "DEVICE & APP" : section === "debug" ? "DEBUG & EVIDENCE" : "PROJECT & SETUP"}`,
      options: currentOptions,
      input: options.input,
      sink: options.sink,
      capabilities:
        presentation === "full" && firstRender
          ? options.capabilities
          : { ...options.capabilities, animation: false },
      preamble: (frame: number) =>
        presentation === "full" && firstRender
          ? homePreamble(frame, options.version, options.capabilities)
          : compactSessionPreamble(options.capabilities),
      help: atRoot
        ? options.capabilities.unicode
          ? "↑↓ move · 1-5 jump · enter open"
          : "up/down · 1-5 jump · enter open"
        : options.capabilities.unicode
          ? "↑↓ move · 1-9 jump · enter open"
          : "up/down · 1-9 jump · enter open",
      escapeLabel: atRoot ? "close" : "back",
      eraseOnExit: true,
      ...(options.refreshIntervalMs === undefined
        ? {}
        : { refreshIntervalMs: options.refreshIntervalMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    firstRender = false;

    if (selection.kind === "unavailable") return selection;
    if (selection.kind === "cancelled") {
      if (selection.reason === "escape") {
        if (atRoot) return { kind: "action", action: "exit" };
        section = undefined;
        continue;
      }
      return { kind: "cancelled", reason: selection.reason };
    }
    if (atRoot && selection.value !== "dev" && selection.value !== "exit") {
      section = selection.value as HomeSection;
      continue;
    }
    return { kind: "action", action: selection.value as HomeAction };
  }
}
