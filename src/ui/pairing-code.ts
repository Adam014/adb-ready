import type { SelectInput } from "./select.js";
import type { TextSink } from "./spinner.js";
import { style } from "./style.js";
import type { TerminalCapabilities } from "./terminal.js";

export type PairingCodeResult =
  | { kind: "submitted"; value: string }
  | { kind: "cancelled"; reason: "eof" | "escape" | "interrupt" | "signal" }
  | { kind: "unavailable" };

interface EndAwareInput {
  once?(event: "end", listener: () => void): unknown;
}

export interface PairingCodeOptions {
  input: SelectInput;
  sink: TextSink;
  capabilities: TerminalCapabilities;
  fromStdin: boolean;
  signal?: AbortSignal;
}

export async function readPairingCode(options: PairingCodeOptions): Promise<PairingCodeResult> {
  const interactive = options.capabilities.interactive && !options.fromStdin;
  if (interactive && options.input.setRawMode === undefined) {
    return { kind: "unavailable" };
  }

  return await new Promise<PairingCodeResult>((resolve) => {
    const wasRaw = options.input.isRaw === true;
    let value = "";
    let settled = false;

    const attempt = (operation: () => unknown) => {
      try {
        operation();
      } catch {
        // Cleanup is best-effort so every independent restoration still runs.
      }
    };
    const cleanup = () => {
      attempt(() => options.input.off("data", onData));
      attempt(() => options.signal?.removeEventListener("abort", onAbort));
      if (interactive && !wasRaw) {
        attempt(() => options.input.setRawMode?.(false));
      }
      attempt(() => options.input.pause());
    };
    const settle = (result: PairingCodeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (interactive) {
        attempt(() => options.sink.write("\n"));
      }
      resolve(result);
    };
    const submit = () => settle({ kind: "submitted", value });
    const onAbort = () => settle({ kind: "cancelled", reason: "signal" });
    const onEnd = () => {
      if (value !== "") {
        submit();
      } else {
        settle({ kind: "cancelled", reason: "eof" });
      }
    };
    const onData = (chunk: Uint8Array | string) => {
      const input = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      for (const character of input) {
        if (character === "\u0003") {
          settle({ kind: "cancelled", reason: "interrupt" });
          return;
        }
        if (interactive && character === "\u001B") {
          settle({ kind: "cancelled", reason: "escape" });
          return;
        }
        if (character === "\r" || character === "\n") {
          submit();
          return;
        }
        if (interactive && (character === "\u007F" || character === "\b")) {
          if (value.length > 0) {
            value = value.slice(0, -1);
            options.sink.write("\b \b");
          }
          continue;
        }
        if (interactive) {
          if (/\d/u.test(character) && value.length < 6) {
            value += character;
            options.sink.write(options.capabilities.unicode ? "•" : "*");
          }
        } else if (value.length < 128) {
          value += character;
        }
      }
    };

    try {
      if (interactive) {
        options.sink.write(
          `${style.strong("Pairing code", options.capabilities)} ${style.dim("(6 digits, hidden):", options.capabilities)} `,
        );
        options.input.setRawMode?.(true);
      }
      options.input.resume();
      options.input.on("data", onData);
      (options.input as SelectInput & EndAwareInput).once?.("end", onEnd);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    } catch {
      settle({ kind: "unavailable" });
      return;
    }
    if (options.signal?.aborted) {
      onAbort();
    }
  });
}
