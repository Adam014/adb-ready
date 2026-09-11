import { describe, expect, test } from "bun:test";
import { clearInteractiveScreen, showHomeScreen } from "../../src/ui/home.js";
import type { SelectInput } from "../../src/ui/select.js";
import type { TextSink } from "../../src/ui/spinner.js";
import { sanitizeTerminalText } from "../../src/ui/style.js";
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
    const value = this.values.shift();
    if (value !== undefined) queueMicrotask(() => listener(value));
  }

  off(): void {}
}

class ManualInput implements SelectInput {
  isRaw = false;
  readonly listeners = new Set<(chunk: Uint8Array | string) => void>();

  setRawMode(enabled: boolean): void {
    this.isRaw = enabled;
  }

  resume(): void {}

  pause(): void {}

  on(_event: "data", listener: (chunk: Uint8Array | string) => void): void {
    this.listeners.add(listener);
  }

  off(_event: "data", listener: (chunk: Uint8Array | string) => void): void {
    this.listeners.delete(listener);
  }

  send(value: string): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
}

const interactive: TerminalCapabilities = {
  interactive: true,
  color: false,
  unicode: true,
  animation: true,
  columns: 100,
};

describe("home screen", () => {
  test("clears first, renders product value, and opens on the flagship dev workflow", async () => {
    const sink = new MemorySink();
    const input = new AutoInput("\r");
    const selected = await showHomeScreen({
      version: "0.0.0",
      input,
      sink,
      capabilities: interactive,
      refreshIntervalMs: 1,
    });

    expect(selected).toEqual({ kind: "action", action: "dev" });
    expect(sink.value).toStartWith("\u001B[2J\u001B[H");
    expect(sink.value).toContain("ADB READY");
    expect(sink.value).toContain("Android sessions. Kept ready.");
    expect(sink.value).toContain("RUN    one target + project");
    expect(sink.value).toContain("Test & automate");
    expect(sink.value).toContain("Device & app");
    expect(sink.value).toContain("Debug & evidence");
    expect(sink.value).toContain("Project & setup");
    expect(sink.value).toContain("WHAT DO YOU WANT TO DO?");
    expect(sink.value).toEndWith("\u001B[?25h");
    expect(input.isRaw).toBe(false);
  });

  test("opens a focused section and supports its version shortcut", async () => {
    const selected = await showHomeScreen({
      version: "0.0.0",
      input: new AutoInput("5\r", "4\r"),
      sink: new MemorySink(),
      capabilities: { ...interactive, animation: false },
    });

    expect(selected).toEqual({ kind: "action", action: "version" });
  });

  test("keeps new app and evidence workflows behind focused categories", async () => {
    const sink = new MemorySink();
    const selected = await showHomeScreen({
      version: "0.0.0",
      input: new AutoInput("4\r", "2\r"),
      sink,
      capabilities: { ...interactive, animation: false },
    });

    expect(selected).toEqual({ kind: "action", action: "inspect-ui" });
    expect(sink.value).toContain("HOME / DEBUG & EVIDENCE");
    expect(sink.value).toContain("Inspect project app");
    expect(sink.value).toContain("Capture screenshot");
  });

  test("returns from a section with escape and closes only from home", async () => {
    const sink = new MemorySink();
    const selected = await showHomeScreen({
      version: "0.0.0",
      input: new AutoInput("3\r", "\u001B", "\u001B"),
      sink,
      capabilities: { ...interactive, animation: false },
    });

    expect(selected).toEqual({ kind: "action", action: "exit" });
    expect(sink.value).toContain("HOME / DEVICE & APP");
    expect(sink.value).toContain("esc back");
  });

  test("renders only the compact action menu after command output", async () => {
    const sink = new MemorySink();
    const selected = await showHomeScreen({
      version: "0.0.0",
      input: new AutoInput("\u001B"),
      sink,
      capabilities: { ...interactive, animation: false, columns: 45 },
      presentation: "menu",
    });

    expect(selected).toEqual({ kind: "action", action: "exit" });
    expect(sink.value).toContain("WHAT DO YOU WANT TO DO?");
    expect(sink.value).toContain("####");
    expect(sink.value).toStartWith("\u001B[?25l\u001B[2K\n");
    expect(sink.value).not.toContain("\u001B[2J\u001B[H");
    expect(sink.value).not.toContain("Android sessions. Kept ready.");
    expect(sink.value.split("\n").every((line) => sanitizeTerminalText(line).length <= 45)).toBe(
      true,
    );
  });

  test("keeps the compact ASCII wordmark static", async () => {
    const sink = new MemorySink();
    const input = new ManualInput();
    const selection = showHomeScreen({
      version: "0.0.0",
      input,
      sink,
      capabilities: interactive,
      presentation: "menu",
      refreshIntervalMs: 32,
    });

    await new Promise((resolve) => setTimeout(resolve, 75));
    input.send("\u001B");

    await expect(selection).resolves.toEqual({ kind: "action", action: "exit" });
    expect(sink.value.match(/WHAT DO YOU WANT TO DO\?/gu)).toHaveLength(1);
    expect(sink.value.match(/\[\d+F/gu)).toHaveLength(1);
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

    expect(sink.value).toContain("ADB READY");
    expect(sink.value).toContain("Android sessions. Kept ready.");
    expect(sink.value).not.toContain("\u001B[36m");
    expect(sink.value.split("\n").every((line) => sanitizeTerminalText(line).length <= 40)).toBe(
      true,
    );
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
