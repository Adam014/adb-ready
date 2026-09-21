import type {
  DevLiveControls,
  DevLiveControlsBinding,
  ExpoControlAction,
} from "../dev/expo-controls.js";
import type { SelectInput } from "./select.js";
import type { TextSink } from "./spinner.js";
import { sanitizeTerminalText, style, symbols } from "./style.js";
import type { TerminalCapabilities } from "./terminal.js";

export interface DevControlOptions {
  capabilities: TerminalCapabilities;
  controls: DevLiveControls;
  input: SelectInput;
  signal?: AbortSignal;
  sink: TextSink;
}

export function renderDevControlHelp(capabilities: TerminalCapabilities): string {
  const separator = style.dim(" · ", capabilities);
  return `${style.dim("  controls", capabilities)}  ${[
    `${style.accent("r", capabilities)} reload Expo app`,
    `${style.accent("m", capabilities)} open developer menu`,
    `${style.accent("?", capabilities)} show this help`,
    `${style.accent("Ctrl+C", capabilities)} stop session`,
  ].join(separator)}\n`;
}

export function startDevControls(options: DevControlOptions): DevLiveControlsBinding | undefined {
  if (!options.capabilities.interactive || options.input.setRawMode === undefined) {
    return undefined;
  }

  const glyphs = symbols(options.capabilities);
  const actionController = new AbortController();
  const wasRaw = options.input.isRaw === true;
  let disposed = false;
  let busy = false;
  let requestStop: (() => void) | undefined;
  const stopRequested = new Promise<void>((resolve) => {
    requestStop = resolve;
  });

  const attempt = (operation: () => unknown): void => {
    try {
      operation();
    } catch {
      // Each terminal restoration step is independent and best-effort.
    }
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    actionController.abort();
    attempt(() => options.input.off("data", onData));
    attempt(() => options.signal?.removeEventListener("abort", dispose));
    if (!wasRaw) attempt(() => options.input.setRawMode?.(false));
    attempt(() => options.input.pause());
  };
  const runAction = async (action: ExpoControlAction): Promise<void> => {
    if (busy || disposed) return;
    busy = true;
    const label = action === "reload" ? "Reloading Expo app" : "Opening Expo developer menu";
    options.sink.write(`${style.accent(glyphs.recovered, options.capabilities)} ${label}…\n`);
    try {
      const result = await options.controls.execute(action, actionController.signal);
      const detail = sanitizeTerminalText(result.detail);
      options.sink.write(
        result.ok
          ? `${style.success(glyphs.success, options.capabilities)} ${detail}\n`
          : `${style.warning(glyphs.warning, options.capabilities)} ${detail}\n`,
      );
    } catch {
      options.sink.write(
        `${style.warning(glyphs.warning, options.capabilities)} Expo control failed safely. The development session is still running.\n`,
      );
    } finally {
      busy = false;
    }
  };
  const onData = (chunk: Uint8Array | string): void => {
    const value = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const character of value) {
      if (character === "\u0003") {
        options.sink.write("\n");
        requestStop?.();
        dispose();
        return;
      }
      if (character === "r") {
        void runAction("reload");
      } else if (character === "m") {
        void runAction("dev-menu");
      } else if (character === "?") {
        options.sink.write(renderDevControlHelp(options.capabilities));
      }
    }
  };

  try {
    options.input.setRawMode(true);
    options.input.resume();
    options.input.on("data", onData);
    options.signal?.addEventListener("abort", dispose, { once: true });
  } catch {
    dispose();
    return undefined;
  }
  if (options.signal?.aborted === true) dispose();

  return { dispose, stopRequested };
}
