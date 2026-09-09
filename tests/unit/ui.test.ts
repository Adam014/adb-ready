import { describe, expect, test } from "bun:test";
import { EventBus } from "../../src/core/event-bus.js";
import { ProgressRenderer } from "../../src/ui/progress-renderer.js";
import { Spinner, type TextSink, type TimerScheduler } from "../../src/ui/spinner.js";
import { sanitizeTerminalText, symbols } from "../../src/ui/style.js";
import { resolveTerminalCapabilities, type TerminalCapabilities } from "../../src/ui/terminal.js";

class MemorySink implements TextSink {
  value = "";

  write(chunk: string): void {
    this.value += chunk;
  }
}

class ManualScheduler implements TimerScheduler {
  callback?: () => void;
  cleared = false;

  setInterval(callback: () => void): number {
    this.callback = callback;
    return 1;
  }

  clearInterval(): void {
    this.cleared = true;
  }
}

const interactiveCapabilities: TerminalCapabilities = {
  interactive: true,
  color: false,
  unicode: true,
  animation: true,
  columns: 80,
};

describe("terminal capabilities", () => {
  test("enables interaction only for a capable human TTY", () => {
    expect(
      resolveTerminalCapabilities({
        format: "human",
        nonInteractive: false,
        env: { LANG: "en_US.UTF-8" },
        inputIsTTY: true,
        outputIsTTY: true,
        columns: 100,
      }),
    ).toEqual({ interactive: true, color: true, unicode: true, animation: true, columns: 100 });
  });

  test("disables control sequences for JSON, CI, pipes, and dumb terminals", () => {
    for (const capabilities of [
      resolveTerminalCapabilities({
        format: "json",
        nonInteractive: false,
        inputIsTTY: true,
        outputIsTTY: true,
      }),
      resolveTerminalCapabilities({
        format: "human",
        nonInteractive: false,
        env: { CI: "true" },
        inputIsTTY: true,
        outputIsTTY: true,
      }),
      resolveTerminalCapabilities({
        format: "human",
        nonInteractive: false,
        inputIsTTY: false,
        outputIsTTY: false,
      }),
      resolveTerminalCapabilities({
        format: "human",
        nonInteractive: false,
        env: { TERM: "dumb" },
        inputIsTTY: true,
        outputIsTTY: true,
      }),
    ]) {
      expect(capabilities.interactive).toBe(false);
      expect(capabilities.animation).toBe(false);
    }
  });

  test("honors NO_COLOR and explicit user overrides", () => {
    const disabled = resolveTerminalCapabilities({
      format: "human",
      nonInteractive: false,
      env: { NO_COLOR: "" },
      inputIsTTY: true,
      outputIsTTY: true,
    });
    const overridden = resolveTerminalCapabilities({
      format: "human",
      nonInteractive: false,
      color: true,
      unicode: false,
      animation: false,
      env: { NO_COLOR: "" },
      inputIsTTY: true,
      outputIsTTY: true,
    });

    expect(disabled.color).toBe(false);
    expect(overridden).toMatchObject({ color: true, unicode: false, animation: false });
    expect(symbols(overridden).success).toBe("+");
  });
});

describe("terminal safety", () => {
  test("removes ANSI and control characters from untrusted text", () => {
    expect(sanitizeTerminalText("Pixel\u001B[31m hacked\nnext\u0007")).toBe("Pixel hacked next");
  });

  test("restores the cursor after animated completion", () => {
    const sink = new MemorySink();
    const timer = new ManualScheduler();
    const spinner = new Spinner(sink, interactiveCapabilities, timer);

    spinner.start("Discovering");
    timer.callback?.();
    spinner.succeed("Ready");

    expect(timer.cleared).toBe(true);
    expect(sink.value).toContain("\u001B[?25l");
    expect(sink.value).toContain("\u001B[?25h");
    expect(sink.value).toEndWith("✓ Ready\n\u001B[?25h");
  });

  test("prints one static result without ANSI when animation is unavailable", () => {
    const sink = new MemorySink();
    const spinner = new Spinner(sink, { ...interactiveCapabilities, animation: false });
    spinner.start("Discovering");
    spinner.succeed();

    expect(sink.value).toBe("✓ Discovering\n");
    expect(sink.value).not.toContain("\u001B");
  });
});

describe("ProgressRenderer", () => {
  test("renders structured operation events through the spinner", () => {
    const sink = new MemorySink();
    const bus = new EventBus(() => new Date("2026-09-09T10:00:00.000Z"));
    const renderer = new ProgressRenderer({
      bus,
      sink,
      capabilities: { ...interactiveCapabilities, animation: false },
    });

    bus.emit({
      type: "operation.started",
      source: "adb.devices",
      severity: "info",
      message: "Discovering Android targets",
      correlation: { commandId: "command-1" },
    });
    bus.emit({
      type: "operation.completed",
      source: "adb.devices",
      severity: "info",
      message: "Discovering Android targets completed",
      correlation: { commandId: "command-1" },
    });
    renderer.dispose();

    expect(sink.value).toBe("✓ Discovering Android targets\n");
  });
});
