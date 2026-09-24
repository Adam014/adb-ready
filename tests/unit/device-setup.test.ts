import { describe, expect, test } from "bun:test";
import { showDeviceSetup } from "../../src/ui/device-setup.js";
import type { SelectInput } from "../../src/ui/select.js";
import type { TextSink } from "../../src/ui/spinner.js";
import { stripTerminalSequences } from "../../src/ui/style.js";
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

const interactive: TerminalCapabilities = {
  interactive: true,
  color: false,
  unicode: true,
  animation: false,
  columns: 80,
  rows: 30,
};

function readable(value: string): string {
  return stripTerminalSequences(value)
    .replaceAll("\r", "")
    .replaceAll("│", "")
    .replace(/\s+/gu, " ");
}

describe("first-device setup", () => {
  test("guides a physical USB device into verified target discovery", async () => {
    const sink = new MemorySink();
    const input = new AutoInput("\r", "\r", "\r");

    await expect(showDeviceSetup({ input, sink, capabilities: interactive })).resolves.toEqual({
      kind: "action",
      action: "devices",
    });
    expect(readable(sink.value)).toContain("Physical Android device");
    expect(readable(sink.value)).toContain("Build number seven times");
    expect(readable(sink.value)).toContain("approve the RSA trust prompt");
    expect(input.isRaw).toBe(false);
  });

  test("guides first-time wireless users into secure pairing", async () => {
    const sink = new MemorySink();
    const input = new AutoInput("\r", "2\r", "\r", "\r");

    await expect(showDeviceSetup({ input, sink, capabilities: interactive })).resolves.toEqual({
      kind: "action",
      action: "pair",
    });
    expect(readable(sink.value)).toContain("Android 11 or newer");
    expect(readable(sink.value)).toContain("Pair device with pairing code");
    expect(readable(sink.value)).toContain("never placed in shell history");
  });

  test("routes an already paired device into wireless connection", async () => {
    const sink = new MemorySink();
    const input = new AutoInput("\r", "2\r", "2\r", "\r");

    await expect(showDeviceSetup({ input, sink, capabilities: interactive })).resolves.toEqual({
      kind: "action",
      action: "connect",
    });
    expect(readable(sink.value)).toContain(
      "connection port normally differs from the pairing port",
    );
  });

  test("guides an existing emulator into verified target discovery", async () => {
    const sink = new MemorySink();
    const input = new AutoInput("2\r", "\r");

    await expect(showDeviceSetup({ input, sink, capabilities: interactive })).resolves.toEqual({
      kind: "action",
      action: "devices",
    });
    expect(readable(sink.value)).toContain("Device Manager");
    expect(readable(sink.value)).toContain("wait for its home screen");
  });

  test("returns home safely when setup is cancelled", async () => {
    const sink = new MemorySink();
    const input = new AutoInput("\u001B");

    await expect(showDeviceSetup({ input, sink, capabilities: interactive })).resolves.toEqual({
      kind: "cancelled",
      reason: "escape",
    });
    expect(input.isRaw).toBe(false);
  });

  test("navigates back from a physical connection method", async () => {
    const sink = new MemorySink();
    const input = new AutoInput("\r", "\u001B", "\u001B");

    await expect(showDeviceSetup({ input, sink, capabilities: interactive })).resolves.toEqual({
      kind: "cancelled",
      reason: "escape",
    });
    expect(readable(sink.value).match(/SET UP YOUR FIRST ANDROID TARGET/gu)).toHaveLength(2);
  });

  test("navigates back from wireless choices without losing terminal state", async () => {
    const sink = new MemorySink();
    const input = new AutoInput("\r", "2\r", "\u001B", "\u001B", "\u001B");

    await expect(showDeviceSetup({ input, sink, capabilities: interactive })).resolves.toEqual({
      kind: "cancelled",
      reason: "escape",
    });
    expect(readable(sink.value)).toContain("WIRELESS DEBUGGING");
    expect(input.isRaw).toBe(false);
  });

  test("propagates interruption from each nested physical-device prompt", async () => {
    const methodSink = new MemorySink();
    await expect(
      showDeviceSetup({
        input: new AutoInput("\r", "\u0003"),
        sink: methodSink,
        capabilities: interactive,
      }),
    ).resolves.toEqual({ kind: "cancelled", reason: "interrupt" });

    const wirelessSink = new MemorySink();
    await expect(
      showDeviceSetup({
        input: new AutoInput("\r", "2\r", "\u0003"),
        sink: wirelessSink,
        capabilities: interactive,
      }),
    ).resolves.toEqual({ kind: "cancelled", reason: "interrupt" });
  });

  test("does not render when an interactive terminal is unavailable", async () => {
    const sink = new MemorySink();
    const input = new AutoInput();

    await expect(
      showDeviceSetup({
        input,
        sink,
        capabilities: { ...interactive, interactive: false },
      }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(sink.value).toBe("");
  });
});
