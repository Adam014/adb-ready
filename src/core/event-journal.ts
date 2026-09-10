import type { AdbReadyEvent, JsonValue, Severity } from "../domain/contracts.js";
import type { EventBus } from "./event-bus.js";
import { type RedactionOptions, redactText } from "./redaction.js";

export interface EventJournalOptions {
  maxEntries?: number;
  maxBytes?: number;
  sources?: readonly string[];
  minimumSeverity?: Severity;
  redaction?: RedactionOptions;
}

export interface EventJournalSnapshot {
  events: AdbReadyEvent[];
  dropped: number;
  bytes: number;
}

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
};

function redactedJson(value: JsonValue, options: RedactionOptions): JsonValue {
  if (typeof value === "string") return redactText(value, options).value;
  if (Array.isArray(value)) return value.map((item) => redactedJson(item, options));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactedJson(item, options)]),
    );
  }
  return value;
}

function redactEvent(event: AdbReadyEvent, options: RedactionOptions): AdbReadyEvent {
  return {
    ...event,
    message: redactText(event.message, options).value,
    ...(event.data === undefined
      ? {}
      : { data: redactedJson(event.data, options) as Record<string, JsonValue> }),
  };
}

function eventBytes(event: AdbReadyEvent): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength + 1;
}

export class EventJournal {
  readonly #events: Array<{ event: AdbReadyEvent; bytes: number }> = [];
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #sources: ReadonlySet<string> | undefined;
  readonly #minimumSeverity: Severity;
  readonly #redaction: RedactionOptions;
  readonly #unsubscribe: () => void;
  #bytes = 0;
  #dropped = 0;

  constructor(bus: EventBus, options: EventJournalOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 2_000;
    this.#maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1) {
      throw new RangeError("maxBytes must be a positive safe integer");
    }
    this.#sources = options.sources === undefined ? undefined : new Set(options.sources);
    this.#minimumSeverity = options.minimumSeverity ?? "debug";
    this.#redaction = options.redaction ?? {};
    this.#unsubscribe = bus.subscribe((event) => this.#record(event));
  }

  close(): EventJournalSnapshot {
    this.#unsubscribe();
    return this.snapshot();
  }

  snapshot(): EventJournalSnapshot {
    return {
      events: this.#events.map(({ event }) => structuredClone(event)),
      dropped: this.#dropped,
      bytes: this.#bytes,
    };
  }

  #record(input: AdbReadyEvent): void {
    if (
      (this.#sources !== undefined && !this.#sources.has(input.source)) ||
      SEVERITY_ORDER[input.severity] < SEVERITY_ORDER[this.#minimumSeverity]
    ) {
      return;
    }
    const event = redactEvent(input, this.#redaction);
    const bytes = eventBytes(event);
    if (bytes > this.#maxBytes) {
      this.#dropped += 1;
      return;
    }
    this.#events.push({ event, bytes });
    this.#bytes += bytes;
    while (this.#events.length > this.#maxEntries || this.#bytes > this.#maxBytes) {
      const removed = this.#events.shift();
      if (removed === undefined) break;
      this.#bytes -= removed.bytes;
      this.#dropped += 1;
    }
  }
}
