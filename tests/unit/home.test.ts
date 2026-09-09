import { describe, expect, test } from "bun:test";
import { clearInteractiveScreen, showHomeScreen } from "../../src/ui/home.js";
import type { SelectInput } from "../../src/ui/select.js";
import type { TextSink } from "../../src/ui/spinner.js";
import type { TerminalCapabilities } from "../../src/ui/terminal.js";

class MemorySink implements TextSink {
  value = "";

  write(chunk: string): void {
    this.value += chunk;
  }
}

class AutoInput implements SelectInput {
  isRaw = false;
  readonly values: string[];

  constructor(...values: string[]) {
    this.values = values;
  }

  setRawMode(enabled: boolean): void {
    this.isRaw = enabled;
  }

  resume(): void {}

  pause(): void {}

  on(_event: "data", listener: (chunk: Uint8Array | string) => void): void {
    for (const value of this.values) {
      queueMicrotask(() => listener(value));
    }
  }

  off(): void {}
}

const interactive: TerminalCapabilities = {
  interactive: true,
  color: false,
  unicode: true,
  animation: true,
  columns: 100,
};

describe("home screen", () => {
  test("clears first, animates the wordmark, and opens on the recommended doctor", async () => {
    const sink = new MemorySink();
    const input = new AutoInput("\r");
    const selected = await showHomeScreen({
      version: "0.0.0",
      input,
      sink,
      capabilities: interactive,
      sleep: async () => {},
    });

    expect(selected).toEqual({ kind: "action", action: "doctor" });
    expect(sink.value).toStartWith("\u001B[2J\u001B[H");
    expect(sink.value).toContain("ADB READY");
    expect(sink.value).toContain("Start development session (unavailable)");
    expect(sink.value).toContain("Connect or pair wirelessly (unavailable)");
    expect(sink.value).toContain("ADB Ready 0.0.0 · choose a workflow");
    expect(sink.value).toEndWith("\u001B[?25h");
    expect(input.isRaw).toBe(false);
  });

  test("supports the version menu shortcut", async () => {
    const selected = await showHomeScreen({
      version: "0.0.0",
      input: new AutoInput("5", "\r"),
      sink: new MemorySink(),
      capabilities: { ...interactive, animation: false },
    });

    expect(selected).toEqual({ kind: "action", action: "version" });
  });

  test("uses a compact ASCII identity on narrow terminals", async () => {
    const sink = new MemorySink();
    await showHomeScreen({
      version: "0.0.0",
      input: new AutoInput("\u001B"),
      sink,
      capabilities: {
        ...interactive,
        animation: false,
        color: false,
        unicode: false,
        columns: 40,
      },
    });

    expect(sink.value).toContain("|  [>]  ADB READY     |");
    expect(sink.value).not.toContain("\u001B[36m");
  });

  test("never clears or renders when interaction is unavailable", async () => {
    const sink = new MemorySink();
    const unavailable = { ...interactive, interactive: false, animation: false };
    clearInteractiveScreen(sink, unavailable);
    const selected = await showHomeScreen({
      version: "0.0.0",
      input: new AutoInput(),
      sink,
      capabilities: unavailable,
    });

    expect(selected).toEqual({ kind: "unavailable" });
    expect(sink.value).toBe("");
  });

  test("returns an interrupt result and restores terminal state", async () => {
    const sink = new MemorySink();
    const input = new AutoInput("\u0003");
    const selected = await showHomeScreen({
      version: "0.0.0",
      input,
      sink,
      capabilities: { ...interactive, animation: false },
    });

    expect(selected).toEqual({ kind: "cancelled", reason: "interrupt" });
    expect(input.isRaw).toBe(false);
    expect(sink.value).toEndWith("\u001B[?25h");
  });
});
