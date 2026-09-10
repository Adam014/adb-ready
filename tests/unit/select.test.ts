import { describe, expect, test } from "bun:test";
import { type SelectInput, selectOne } from "../../src/ui/select.js";
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
  paused = false;
  readonly rawTransitions: boolean[] = [];
  readonly #listeners = new Set<(chunk: Uint8Array | string) => void>();

  setRawMode(enabled: boolean): void {
    this.isRaw = enabled;
    this.rawTransitions.push(enabled);
  }

  resume(): void {
    this.paused = false;
  }

  pause(): void {
    this.paused = true;
  }

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
  unicode: false,
  animation: false,
  columns: 80,
};

const options = [
  { value: "usb", label: "Pixel USB", recommended: true },
  { value: "offline", label: "Pixel Wi-Fi", disabled: true },
  { value: "emulator", label: "Emulator" },
];

describe("selectOne", () => {
  test("uses arrows while skipping unavailable choices", async () => {
    const input = new FakeInput();
    const sink = new MemorySink();
    const selection = selectOne({ title: "Select a target", options, input, sink, capabilities });

    input.send("\u001B[B");
    input.send("\r");

    await expect(selection).resolves.toEqual({ kind: "selected", value: "emulator" });
    expect(input.rawTransitions).toEqual([true, false]);
    expect(input.paused).toBe(true);
    expect(sink.value).toContain("· recommended");
    expect(sink.value).toContain("· unavailable");
    expect(sink.value).toEndWith("\u001B[?25h");
  });

  test("supports direct number shortcuts", async () => {
    const input = new FakeInput();
    const selection = selectOne({
      title: "Select",
      options,
      input,
      sink: new MemorySink(),
      capabilities,
    });

    input.send("3");
    input.send("\n");

    await expect(selection).resolves.toEqual({ kind: "selected", value: "emulator" });
  });

  test("processes navigation and confirmation delivered in one input chunk", async () => {
    const input = new FakeInput();
    const selection = selectOne({
      title: "Select",
      options,
      input,
      sink: new MemorySink(),
      capabilities,
    });

    input.send("\u001B[B\r");

    await expect(selection).resolves.toEqual({ kind: "selected", value: "emulator" });
  });

  test("reassembles an arrow sequence split across input chunks", async () => {
    const input = new FakeInput();
    const selection = selectOne({
      title: "Select",
      options,
      input,
      sink: new MemorySink(),
      capabilities,
    });

    input.send("\u001B");
    input.send("[B\r");

    await expect(selection).resolves.toEqual({ kind: "selected", value: "emulator" });
  });

  test("restores raw mode and cursor after Ctrl-C", async () => {
    const input = new FakeInput();
    const sink = new MemorySink();
    const selection = selectOne({ title: "Select", options, input, sink, capabilities });

    input.send("\u0003");

    await expect(selection).resolves.toEqual({ kind: "cancelled", reason: "interrupt" });
    expect(input.rawTransitions).toEqual([true, false]);
    expect(sink.value).toEndWith("\u001B[?25h");
  });

  test("does not emit control sequences when interaction is unavailable", async () => {
    const sink = new MemorySink();
    const result = await selectOne({
      title: "Select",
      options,
      input: new FakeInput(),
      sink,
      capabilities: { ...capabilities, interactive: false },
    });

    expect(result).toEqual({ kind: "unavailable" });
    expect(sink.value).toBe("");
  });

  test("restores the cursor when terminal setup itself fails", async () => {
    const input = new FakeInput();
    const sink = new MemorySink();
    input.setRawMode = (enabled) => {
      input.rawTransitions.push(enabled);
      if (enabled) {
        throw new Error("raw mode unavailable");
      }
    };

    const result = await selectOne({ title: "Select", options, input, sink, capabilities });

    expect(result).toEqual({ kind: "unavailable" });
    expect(input.rawTransitions).toEqual([true, false]);
    expect(sink.value).toEndWith("\u001B[?25h");
  });

  test("sanitizes labels before drawing them", async () => {
    const input = new FakeInput();
    const sink = new MemorySink();
    const selection = selectOne({
      title: "Select",
      options: [{ value: "safe", label: "Pixel\u001B[31m\nspoofed" }],
      input,
      sink,
      capabilities,
    });
    input.send("\r");
    await selection;

    const withoutOwnControls = sink.value
      .replaceAll("\u001B[?25l", "")
      .replaceAll("\u001B[?25h", "")
      .replaceAll("\u001B[2K", "");
    expect(withoutOwnControls).toContain("Pixel spoofed");
    expect(withoutOwnControls).not.toContain("\u001B");
  });

  test("keeps a dynamic preamble moving while the menu is open", async () => {
    const input = new FakeInput();
    const sink = new MemorySink();
    const selection = selectOne({
      title: "Select",
      options,
      input,
      sink,
      capabilities: { ...capabilities, animation: true },
      preamble: (frame) => [`frame ${String(frame)}`, ""],
      refreshIntervalMs: 32,
    });

    await new Promise((resolve) => setTimeout(resolve, 75));
    input.send("\u001B");

    await expect(selection).resolves.toEqual({ kind: "cancelled", reason: "escape" });
    expect(sink.value).toContain("frame 0");
    expect(sink.value).toMatch(/frame [12]/u);
  });

  test("wraps descriptions to the available terminal width", async () => {
    const input = new FakeInput();
    const sink = new MemorySink();
    const selection = selectOne({
      title: "Choose an action",
      options: [
        {
          value: "doctor",
          label: "Check my setup",
          description: "Validate runtime, ADB capabilities, server, and every visible target",
        },
      ],
      input,
      sink,
      capabilities: { ...capabilities, columns: 40 },
    });
    input.send("\u001B");
    await selection;

    const visibleLines = sink.value
      .replaceAll("\u001B[?25l", "")
      .replaceAll("\u001B[?25h", "")
      .replaceAll("\u001B[2K", "")
      .split("\n");
    expect(visibleLines.every((line) => line.length <= 40)).toBe(true);
  });
});
