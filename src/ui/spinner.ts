import { sanitizeTerminalText, style, symbols } from "./style.js";
import type { TerminalCapabilities } from "./terminal.js";

export interface TextSink {
  write(chunk: string): unknown;
}

export interface TimerScheduler {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

const scheduler: TimerScheduler = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class Spinner {
  readonly #sink: TextSink;
  readonly #capabilities: TerminalCapabilities;
  readonly #scheduler: TimerScheduler;
  #timer: unknown;
  #frame = 0;
  #message = "";
  #cursorHidden = false;

  constructor(
    sink: TextSink,
    capabilities: TerminalCapabilities,
    timerScheduler: TimerScheduler = scheduler,
  ) {
    this.#sink = sink;
    this.#capabilities = capabilities;
    this.#scheduler = timerScheduler;
  }

  start(message: string): void {
    this.stopAnimation();
    this.#message = sanitizeTerminalText(message);
    if (!this.#capabilities.animation) {
      return;
    }
    this.hideCursor();
    this.drawFrame();
    this.#timer = this.#scheduler.setInterval(() => this.drawFrame(), 80);
  }

  succeed(message = this.#message): void {
    this.finish("success", message);
  }

  fail(message = this.#message): void {
    this.finish("failure", message);
  }

  warn(message = this.#message): void {
    this.finish("warning", message);
  }

  dispose(): void {
    this.stopAnimation();
    this.showCursor();
  }

  private finish(status: "failure" | "success" | "warning", message: string): void {
    this.stopAnimation();
    if (this.#capabilities.animation) {
      this.#sink.write("\r\u001B[2K");
    }
    const glyphs = symbols(this.#capabilities);
    const symbol =
      status === "success"
        ? style.success(glyphs.success, this.#capabilities)
        : status === "warning"
          ? style.warning(glyphs.warning, this.#capabilities)
          : style.failure(glyphs.failure, this.#capabilities);
    this.#sink.write(`${symbol} ${sanitizeTerminalText(message)}\n`);
    this.showCursor();
  }

  private drawFrame(): void {
    const frames = this.#capabilities.unicode
      ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
      : ["-", "\\", "|", "/"];
    const frame = frames[this.#frame % frames.length] ?? frames[0] ?? ">";
    this.#frame += 1;
    this.#sink.write(`\r\u001B[2K${style.accent(frame, this.#capabilities)} ${this.#message}`);
  }

  private stopAnimation(): void {
    if (this.#timer !== undefined) {
      this.#scheduler.clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  private hideCursor(): void {
    if (!this.#cursorHidden) {
      this.#sink.write("\u001B[?25l");
      this.#cursorHidden = true;
    }
  }

  private showCursor(): void {
    if (this.#cursorHidden) {
      this.#sink.write("\u001B[?25h");
      this.#cursorHidden = false;
    }
  }
}
