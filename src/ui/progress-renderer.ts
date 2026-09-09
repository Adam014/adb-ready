import type { EventBus } from "../core/event-bus.js";
import type { AdbReadyEvent } from "../domain/contracts.js";
import { Spinner, type TextSink, type TimerScheduler } from "./spinner.js";
import type { TerminalCapabilities } from "./terminal.js";

export class ProgressRenderer {
  readonly #spinner: Spinner;
  readonly #unsubscribe: () => void;
  readonly #verbose: boolean;
  readonly #sink: TextSink;

  constructor(options: {
    bus: EventBus;
    sink: TextSink;
    capabilities: TerminalCapabilities;
    verbose?: boolean;
    scheduler?: TimerScheduler;
  }) {
    this.#sink = options.sink;
    this.#verbose = options.verbose ?? false;
    this.#spinner = new Spinner(options.sink, options.capabilities, options.scheduler);
    this.#unsubscribe = options.bus.subscribe((event) => this.onEvent(event));
  }

  dispose(): void {
    this.#unsubscribe();
    this.#spinner.dispose();
  }

  private onEvent(event: AdbReadyEvent): void {
    if (event.type === "operation.started") {
      this.#spinner.start(event.message);
    } else if (event.type === "operation.completed") {
      this.#spinner.succeed(event.message.replace(/ completed$/u, ""));
    } else if (event.type === "operation.failed") {
      this.#spinner.fail(event.message.replace(/ failed$/u, ""));
    } else if (this.#verbose) {
      this.#sink.write(`› ${event.message}\n`);
    }
  }
}
