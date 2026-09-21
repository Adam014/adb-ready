import type { EventBus } from "../core/event-bus.js";
import type { DevPreset } from "../dev/project.js";
import type { AdbReadyEvent } from "../domain/contracts.js";
import { Spinner, type TextSink, type TimerScheduler } from "./spinner.js";
import { style } from "./style.js";
import type { TerminalCapabilities } from "./terminal.js";

const DEV_PRESETS = new Set<DevPreset>([
  "capacitor",
  "custom",
  "expo",
  "flutter",
  "gradle",
  "react-native",
]);

function key(value: string, capabilities: TerminalCapabilities): string {
  return style.accent(value, capabilities);
}

export function renderDevControlHint(
  preset: DevPreset | undefined,
  capabilities: TerminalCapabilities,
): string {
  const separator = style.dim(" · ", capabilities);
  const stop = `${key("Ctrl+C", capabilities)} stop`;
  let controls: string[];

  if (preset === "expo") {
    controls =
      capabilities.columns < 72
        ? [`${key("r", capabilities)} reload`, `${key("?", capabilities)} commands`, stop]
        : [
            `${key("r", capabilities)} reload`,
            `${key("m", capabilities)} dev menu`,
            `${key("?", capabilities)} commands`,
            stop,
          ];
  } else {
    controls = [stop];
  }

  return `${style.dim("  controls", capabilities)}  ${controls.join(separator)}\n`;
}

export function renderAttachedServiceHint(capabilities: TerminalCapabilities): string {
  const separator = style.dim(" · ", capabilities);
  return `${style.dim("  attached", capabilities)}  Metro controls stay in its original terminal${separator}${key("Ctrl+C", capabilities)} stop this session\n`;
}

export class ProgressRenderer {
  readonly #spinner: Spinner;
  readonly #unsubscribe: () => void;
  readonly #verbose: boolean;
  readonly #sink: TextSink;
  readonly #capabilities: TerminalCapabilities;
  readonly #showDevControls: boolean;
  #controlsAvailable = false;
  #preset?: DevPreset;
  #attachedService = false;

  constructor(options: {
    bus: EventBus;
    sink: TextSink;
    capabilities: TerminalCapabilities;
    verbose?: boolean;
    showDevControls?: boolean;
    scheduler?: TimerScheduler;
  }) {
    this.#sink = options.sink;
    this.#verbose = options.verbose ?? false;
    this.#capabilities = options.capabilities;
    this.#showDevControls = options.showDevControls ?? false;
    this.#spinner = new Spinner(options.sink, options.capabilities, options.scheduler);
    this.#unsubscribe = options.bus.subscribe((event) => this.onEvent(event));
  }

  dispose(): void {
    this.#unsubscribe();
    this.#spinner.dispose();
  }

  private onEvent(event: AdbReadyEvent): void {
    if (event.data?.presentation === "background") return;

    const eventPreset =
      event.type === "child.started" || event.type === "service.attached"
        ? event.data?.preset
        : undefined;
    if (typeof eventPreset === "string" && DEV_PRESETS.has(eventPreset as DevPreset)) {
      this.#preset = eventPreset as DevPreset;
    }
    if (event.type === "service.attached") this.#attachedService = true;
    if (event.type === "dev.controls.available") this.#controlsAvailable = true;

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
      } else if (state === "attaching-child") {
        this.#spinner.start("Attaching to existing Metro server");
      } else if (state === "ready") {
        this.#spinner.succeed("Development session ready");
        if (this.#showDevControls) {
          this.#sink.write(
            this.#attachedService
              ? renderAttachedServiceHint(this.#capabilities)
              : this.#controlsAvailable
                ? renderDevControlHint(this.#preset, this.#capabilities)
                : renderDevControlHint(undefined, this.#capabilities),
          );
        }
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
