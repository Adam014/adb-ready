import { describe, expect, test } from "bun:test";
import { readPairingCode } from "../../src/ui/pairing-code.js";
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

  constructor(readonly chunks: string[]) {}

  setRawMode(enabled: boolean): void {
    this.isRaw = enabled;
  }

  resume(): void {}
  pause(): void {}

  on(_event: "data", listener: (chunk: Uint8Array | string) => void): void {
    for (const chunk of this.chunks) {
      queueMicrotask(() => listener(chunk));
    }
  }

  off(): void {}
}

class EndingInput extends AutoInput {
  once(_event: "end", listener: () => void): void {
    queueMicrotask(listener);
  }
}

const interactive: TerminalCapabilities = {
  interactive: true,
  color: false,
  unicode: true,
  animation: false,
  columns: 80,
};

describe("pairing code input", () => {
  test("masks interactive digits and restores terminal mode", async () => {
    const input = new AutoInput(["123", "456\r"]);
    const sink = new MemorySink();
    const result = await readPairingCode({
      input,
      sink,
      capabilities: interactive,
      fromStdin: false,
    });

    expect(result).toEqual({ kind: "submitted", value: "123456" });
    expect(sink.value).toContain("••••••");
    expect(sink.value).not.toContain("123456");
    expect(input.isRaw).toBe(false);
  });

  test("reads piped digits without writing a prompt or echo", async () => {
    const sink = new MemorySink();
    const result = await readPairingCode({
      input: new AutoInput(["654321\n"]),
      sink,
      capabilities: { ...interactive, interactive: false, unicode: false },
      fromStdin: true,
    });

    expect(result).toEqual({ kind: "submitted", value: "654321" });
    expect(sink.value).toBe("");
  });

  test("does not silently normalize malformed piped input", async () => {
    const result = await readPairingCode({
      input: new AutoInput(["12ab3456\n"]),
      sink: new MemorySink(),
      capabilities: { ...interactive, interactive: false },
      fromStdin: true,
    });

    expect(result).toEqual({ kind: "submitted", value: "12ab3456" });
  });

  test("handles Ctrl-C without retaining raw mode", async () => {
    const input = new AutoInput(["12\u0003"]);
    const result = await readPairingCode({
      input,
      sink: new MemorySink(),
      capabilities: interactive,
      fromStdin: false,
    });

    expect(result).toEqual({ kind: "cancelled", reason: "interrupt" });
    expect(input.isRaw).toBe(false);
  });

  test("handles editing, escape, EOF, and pre-aborted input explicitly", async () => {
    const edited = new AutoInput(["12\u007F3\r"]);
    const editedSink = new MemorySink();
    await expect(
      readPairingCode({
        input: edited,
        sink: editedSink,
        capabilities: { ...interactive, unicode: false },
        fromStdin: false,
      }),
    ).resolves.toEqual({ kind: "submitted", value: "13" });
    expect(editedSink.value).toContain("\b \b");

    await expect(
      readPairingCode({
        input: new AutoInput(["\u001B"]),
        sink: new MemorySink(),
        capabilities: interactive,
        fromStdin: false,
      }),
    ).resolves.toEqual({ kind: "cancelled", reason: "escape" });

    await expect(
      readPairingCode({
        input: new EndingInput([]),
        sink: new MemorySink(),
        capabilities: { ...interactive, interactive: false },
        fromStdin: true,
      }),
    ).resolves.toEqual({ kind: "cancelled", reason: "eof" });
    await expect(
      readPairingCode({
        input: new EndingInput(["123456"]),
        sink: new MemorySink(),
        capabilities: { ...interactive, interactive: false },
        fromStdin: true,
      }),
    ).resolves.toEqual({ kind: "submitted", value: "123456" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      readPairingCode({
        input: new AutoInput([]),
        sink: new MemorySink(),
        capabilities: interactive,
        fromStdin: false,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ kind: "cancelled", reason: "signal" });
  });

  test("reports unavailable terminal capabilities and setup failures", async () => {
    const withoutRawMode: SelectInput = {
      isRaw: false,
      resume() {},
      pause() {},
      on() {},
      off() {},
    };
    await expect(
      readPairingCode({
        input: withoutRawMode,
        sink: new MemorySink(),
        capabilities: interactive,
        fromStdin: false,
      }),
    ).resolves.toEqual({ kind: "unavailable" });

    const broken = new AutoInput([]);
    broken.resume = () => {
      throw new Error("terminal unavailable");
    };
    await expect(
      readPairingCode({
        input: broken,
        sink: new MemorySink(),
        capabilities: interactive,
        fromStdin: false,
      }),
    ).resolves.toEqual({ kind: "unavailable" });
  });
});
