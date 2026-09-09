import {
  type AdbReadyEvent,
  type Correlation,
  type JsonValue,
  SCHEMA_VERSION,
  type Severity,
} from "../domain/contracts.js";

export interface EventInput {
  type: string;
  source: string;
  severity: Severity;
  message: string;
  correlation: Correlation;
  data?: Record<string, JsonValue>;
}

export type EventListener = (event: AdbReadyEvent) => void;

export class EventBus {
  readonly #clock: () => Date;
  readonly #listeners = new Set<EventListener>();
  #sequence = 0;

  constructor(clock: () => Date = () => new Date()) {
    this.#clock = clock;
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(input: EventInput): AdbReadyEvent {
    const event: AdbReadyEvent = {
      schemaVersion: SCHEMA_VERSION,
      sequence: ++this.#sequence,
      timestamp: this.#clock().toISOString(),
      type: input.type,
      source: input.source,
      severity: input.severity,
      message: input.message,
      correlation: input.correlation,
      ...(input.data === undefined ? {} : { data: input.data }),
    };

    for (const listener of this.#listeners) {
      listener(event);
    }

    return event;
  }
}
