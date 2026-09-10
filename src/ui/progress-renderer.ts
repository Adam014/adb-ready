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
    } else if (event.type === "session.state.changed") {
      const state = event.data?.to;
      if (state === "acquiring-target") {
        this.#spinner.start("Acquiring one Android target");
      } else if (state === "preparing-ports") {
        this.#spinner.start("Preparing session ports");
      } else if (state === "starting-child") {
        this.#spinner.start("Starting development command");
      } else if (state === "ready") {
        this.#spinner.succeed("Development session ready");
      } else if (state === "stopping") {
        this.#spinner.start("Stopping owned session resources");
      } else if (state === "failed") {
        this.#spinner.fail("Development session failed");
      }
    } else if (event.type === "session.degraded") {
      this.#spinner.warn(event.message);
    } else if (event.type === "recovery.started") {
      this.#spinner.start(
        event.data?.attempt === undefined
          ? "Recovering development session"
          : `Recovering development session · attempt ${String(event.data.attempt)}`,
      );
    } else if (event.type === "recovery.completed") {
      this.#spinner.succeed(event.message);
    } else if (event.type === "recovery.failed") {
      this.#spinner.warn(event.message);
    } else if (event.type === "watch.failed") {
      this.#spinner.fail(event.message);
    } else if (
      this.#verbose &&
      event.type !== "health.checked" &&
      event.source !== "child.stdout" &&
      event.source !== "child.stderr" &&
      event.source !== "logcat"
    ) {
      this.#sink.write(`› ${event.message}\n`);
    }
  }
}
