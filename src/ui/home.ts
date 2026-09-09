import { renderLinkCoreFrame } from "./ascii-scene.js";
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
  refreshIntervalMs?: number;
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
    "Android setup. No guesswork.",
    "",
    "CHECK  ADB and your local setup",
    "SEE    every visible target",
    "USE    human or JSON output",
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
      style.dim(center("Android setup. No guesswork.", capabilities.columns), capabilities),
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

export function clearInteractiveScreen(sink: TextSink, capabilities: TerminalCapabilities): void {
  if (capabilities.interactive) {
    sink.write("\u001B[2J\u001B[H");
  }
}

export async function showHomeScreen(options: HomeScreenOptions): Promise<HomeResult> {
  if (!options.capabilities.interactive) {
    return { kind: "unavailable" };
  }

  clearInteractiveScreen(options.sink, options.capabilities);
  const selection = await selectOne({
    title: "WHAT DO YOU WANT TO DO?",
    options: [
      {
        value: "doctor" as const,
        label: "Check my setup",
        description: "Validate runtime, ADB, server, and target access",
        recommended: true,
      },
      {
        value: "devices" as const,
        label: "Show Android targets",
        description: "See connected devices and running emulators",
      },
      {
        value: "version" as const,
        label: "Show version",
        description: `ADB Ready ${options.version}`,
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
    capabilities: options.capabilities,
    preamble: (frame) => homePreamble(frame, options.version, options.capabilities),
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
