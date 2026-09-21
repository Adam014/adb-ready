import { describe, expect, test } from "bun:test";
import type { DevLiveControls, ExpoControlAction } from "../../src/dev/expo-controls.js";
import { renderDevControlHelp, startDevControls } from "../../src/ui/dev-controls.js";
import type { SelectInput } from "../../src/ui/select.js";
import type { TextSink } from "../../src/ui/spinner.js";
import type { TerminalCapabilities } from "../../src/ui/terminal.js";

class FakeInput implements SelectInput {
  isRaw = false;
  paused = false;
  readonly listeners = new Set<(chunk: Uint8Array | string) => void>();

  setRawMode(enabled: boolean): void {
    this.isRaw = enabled;
  }
  resume(): void {
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  on(_event: "data", listener: (chunk: Uint8Array | string) => void): void {
    this.listeners.add(listener);
  }
  off(_event: "data", listener: (chunk: Uint8Array | string) => void): void {
    this.listeners.delete(listener);
  }
  send(value: string): void {
    for (const listener of this.listeners) listener(value);
  }
}

class MemorySink implements TextSink {
  value = "";
  write(chunk: string): void {
    this.value += chunk;
  }
}

const capabilities: TerminalCapabilities = {
  animation: false,
  color: false,
  columns: 100,
  interactive: true,
  unicode: true,
};

describe("development live-control input", () => {
  test("runs only implemented Expo actions, shows exact help, and restores raw mode", async () => {
    const input = new FakeInput();
    const sink = new MemorySink();
    const actions: ExpoControlAction[] = [];
    const controls: DevLiveControls = {
      preset: "expo",
      execute: async (action) => {
        actions.push(action);
        return {
          action,
          connectedClients: 1,
          detail: action === "reload" ? "Reload sent." : "Developer menu sent.",
          ok: true,
        };
      },
    };
    const binding = startDevControls({ capabilities, controls, input, sink });
    expect(binding).toBeDefined();
    expect(input.isRaw).toBeTrue();

    input.send("?");
    input.send("r");
    await Bun.sleep(0);
    input.send("m");
    await Bun.sleep(0);

    expect(actions).toEqual(["reload", "dev-menu"]);
    expect(sink.value).toContain(renderDevControlHelp(capabilities));
    expect(sink.value).toContain("✓ Reload sent.");
    expect(sink.value).toContain("✓ Developer menu sent.");

    input.send("\u0003");
    await binding?.stopRequested;
    expect(input.isRaw).toBeFalse();
    expect(input.paused).toBeTrue();
    expect(input.listeners.size).toBe(0);
  });

  test("does not claim controls in a non-interactive stream", () => {
    const input = new FakeInput();
    const sink = new MemorySink();
    const controls: DevLiveControls = {
      preset: "expo",
      execute: async (action) => ({
        action,
        connectedClients: 0,
        detail: "unused",
        ok: false,
      }),
    };
    expect(
      startDevControls({
        capabilities: { ...capabilities, interactive: false },
        controls,
        input,
        sink,
      }),
    ).toBeUndefined();
    expect(input.isRaw).toBeFalse();
    expect(sink.value).toBe("");
  });
});
