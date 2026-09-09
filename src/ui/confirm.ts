import type { Risk } from "../domain/contracts.js";
import type { SelectInput } from "./select.js";
import { selectOne } from "./select.js";
import type { TextSink } from "./spinner.js";
import { sanitizeTerminalText, style } from "./style.js";
import type { TerminalCapabilities } from "./terminal.js";

export type ConfirmationResult =
  | { kind: "confirmed" }
  | { kind: "declined" }
  | { kind: "cancelled"; reason: "escape" | "interrupt" | "signal" }
  | { kind: "unavailable" };

export interface ConfirmationOptions {
  action: string;
  scope: string;
  risk: Risk;
  nonInteractiveFlag: string;
  input: SelectInput;
  sink: TextSink;
  capabilities: TerminalCapabilities;
  signal?: AbortSignal;
}

function fit(value: string, width: number): string {
  const clean = sanitizeTerminalText(value);
  if (clean.length <= width) {
    return clean;
  }
  return width <= 3 ? clean.slice(0, width) : `${clean.slice(0, width - 3)}...`;
}

function confirmationPreamble(options: ConfirmationOptions): string[] {
  const width = Math.max(12, options.capabilities.columns - 11);
  const top = options.capabilities.unicode ? "╭─" : "+-";
  const rail = options.capabilities.unicode ? "│" : "|";
  const bottom = options.capabilities.unicode ? "╰─" : "+-";
  const risk =
    options.risk === "destructive" || options.risk === "shared-global"
      ? style.warning(options.risk, options.capabilities)
      : options.risk;
  return [
    `${style.dim(top, options.capabilities)} ${style.strong("CONFIRM ACTION", options.capabilities)}`,
    `${style.dim(rail, options.capabilities)} Action  ${fit(options.action, width)}`,
    `${style.dim(rail, options.capabilities)} Scope   ${fit(options.scope, width)}`,
    `${style.dim(rail, options.capabilities)} Risk    ${risk}`,
    `${style.dim(rail, options.capabilities)} Script  ${fit(options.nonInteractiveFlag, width)}`,
    style.dim(bottom, options.capabilities),
    "",
  ];
}

export async function confirmAction(options: ConfirmationOptions): Promise<ConfirmationResult> {
  const selection = await selectOne({
    title: "Proceed with this exact action?",
    options: [
      {
        value: false,
        label: "Cancel",
        description: "Keep the target unchanged",
        recommended: true,
      },
      {
        value: true,
        label: "Continue",
        description: "Run only the action and scope shown above",
      },
    ],
    input: options.input,
    sink: options.sink,
    capabilities: options.capabilities,
    preamble: () => confirmationPreamble(options),
    help: options.capabilities.unicode
      ? "↑↓ move · enter choose · esc cancel"
      : "up/down · enter choose · esc cancel",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (selection.kind === "unavailable") {
    return { kind: "unavailable" };
  }
  if (selection.kind === "cancelled") {
    return selection;
  }
  return selection.value ? { kind: "confirmed" } : { kind: "declined" };
}
