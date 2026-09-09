import { describe, expect, test } from "bun:test";
import { confirmAction } from "../../src/ui/confirm.js";
import type { SelectInput } from "../../src/ui/select.js";
import type { TextSink } from "../../src/ui/spinner.js";
import type { TerminalCapabilities } from "../../src/ui/terminal.js";

class MemorySink implements TextSink {
  value = "";
  write(chunk: string): void {
    this.value += chunk;
  }
}

class FakeInput implements SelectInput {
  isRaw = false;
  readonly transitions: boolean[] = [];
  readonly #listeners = new Set<(chunk: Uint8Array | string) => void>();
  setRawMode(enabled: boolean): void {
    this.isRaw = enabled;
    this.transitions.push(enabled);
  }
  resume(): void {}
  pause(): void {}
  on(_event: "data", listener: (chunk: Uint8Array | string) => void): void {
    this.#listeners.add(listener);
  }
  off(_event: "data", listener: (chunk: Uint8Array | string) => void): void {
    this.#listeners.delete(listener);
  }
  send(value: string): void {
    for (const listener of this.#listeners) {
      listener(value);
    }
  }
}

const capabilities: TerminalCapabilities = {
  interactive: true,
  color: false,
  unicode: true,
  animation: false,
  columns: 80,
};

function start(input = new FakeInput(), sink = new MemorySink()) {
  const pending = confirmAction({
    action: "Clear app data",
    scope: "com.example.app on Pixel 9",
    risk: "destructive",
    nonInteractiveFlag: "--yes",
    input,
    sink,
    capabilities,
  });
  return { input, sink, pending };
}

describe("confirmAction", () => {
  test("defaults to the safe decline choice and explains the complete action", async () => {
    const { input, sink, pending } = start();
    input.send("\r");

    await expect(pending).resolves.toEqual({ kind: "declined" });
    expect(sink.value).toContain("Action  Clear app data");
    expect(sink.value).toContain("Scope   com.example.app on Pixel 9");
    expect(sink.value).toContain("Risk    destructive");
    expect(sink.value).toContain("Script  --yes");
    expect(input.transitions).toEqual([true, false]);
  });

  test("requires an explicit move to confirm", async () => {
    const { input, pending } = start();
    input.send("\u001B[B");
    input.send("\r");
    await expect(pending).resolves.toEqual({ kind: "confirmed" });
  });

  test("restores terminal state after interruption", async () => {
    const { input, sink, pending } = start();
    input.send("\u0003");
    await expect(pending).resolves.toEqual({ kind: "cancelled", reason: "interrupt" });
    expect(input.transitions).toEqual([true, false]);
    expect(sink.value).toEndWith("\u001B[?25h");
  });

  test("never prints or prompts when interaction is unavailable", async () => {
    const input = new FakeInput();
    const sink = new MemorySink();
    const result = await confirmAction({
      action: "Clear app data",
      scope: "fixture",
      risk: "destructive",
      nonInteractiveFlag: "--yes",
      input,
      sink,
      capabilities: { ...capabilities, interactive: false },
    });

    expect(result).toEqual({ kind: "unavailable" });
    expect(sink.value).toBe("");
  });

  test("keeps untrusted action details inside a narrow terminal", async () => {
    const input = new FakeInput();
    const sink = new MemorySink();
    const pending = confirmAction({
      action: "Clear app data\u001B[31m with a deliberately long description",
      scope: "com.example.long.application on a developer fixture target",
      risk: "destructive",
      nonInteractiveFlag: "adb-ready app clear com.example.long.application --yes",
      input,
      sink,
      capabilities: { ...capabilities, unicode: false, columns: 40 },
    });
    input.send("\r");
    await pending;

    const visibleLines = sink.value
      .replaceAll("\u001B[?25l", "")
      .replaceAll("\u001B[?25h", "")
      .replaceAll("\u001B[2K", "")
      .split("\n");
    expect(visibleLines.every((line) => line.length <= 40)).toBe(true);
    expect(sink.value).not.toContain("\u001B[31m");
  });
});
