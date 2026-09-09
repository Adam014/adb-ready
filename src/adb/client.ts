import { randomUUID } from "node:crypto";
import type { EventBus } from "../core/event-bus.js";
import type { Correlation, JsonValue } from "../domain/contracts.js";
import {
  type ProcessRequest,
  type ProcessResult,
  type ProcessRunner,
  runProcess,
} from "../platform/process-runner.js";
import {
  type AdbDevice,
  type AdbVersion,
  parseAdbDevices,
  parseAdbVersion,
  parseFeatureList,
  parseKeyValueLines,
} from "./parsers.js";

export interface AdbClientOptions {
  executable: string;
  bus: EventBus;
  correlation: Pick<Correlation, "commandId">;
  host?: string;
  port?: number;
  timeoutMs?: number;
  runner?: ProcessRunner;
  idFactory?: () => string;
}

export interface AdbObservation<T> {
  operationId: string;
  process: ProcessResult;
  value: T;
}

function processMetadata(result: ProcessResult): Record<string, JsonValue> {
  return {
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    ...(result.spawnError === undefined
      ? {}
      : {
          spawnError: {
            ...(result.spawnError.code === undefined ? {} : { code: result.spawnError.code }),
            message: result.spawnError.message,
          },
        }),
  };
}

export class AdbClient {
  readonly #options: AdbClientOptions;
  readonly #runner: ProcessRunner;
  readonly #idFactory: () => string;

  constructor(options: AdbClientOptions) {
    this.#options = options;
    this.#runner = options.runner ?? runProcess;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async version(signal?: AbortSignal): Promise<AdbObservation<AdbVersion>> {
    return await this.#observe(
      "version",
      "Checking ADB version",
      ["version"],
      parseAdbVersion,
      signal,
      false,
    );
  }

  async hostFeatures(signal?: AbortSignal): Promise<AdbObservation<string[]>> {
    return await this.#observe(
      "host-features",
      "Checking ADB host features",
      ["host-features"],
      parseFeatureList,
      signal,
    );
  }

  async serverStatus(signal?: AbortSignal): Promise<AdbObservation<Record<string, string>>> {
    return await this.#observe(
      "server-status",
      "Checking ADB server status",
      ["server-status"],
      parseKeyValueLines,
      signal,
    );
  }

  async devices(signal?: AbortSignal): Promise<AdbObservation<AdbDevice[]>> {
    return await this.#observe(
      "devices",
      "Discovering Android targets",
      ["devices", "-l"],
      parseAdbDevices,
      signal,
    );
  }

  #serverArguments(): string[] {
    return [
      ...(this.#options.host === undefined ? [] : ["-H", this.#options.host]),
      ...(this.#options.port === undefined ? [] : ["-P", String(this.#options.port)]),
    ];
  }

  async #observe<T>(
    operation: string,
    message: string,
    args: string[],
    parse: (output: string) => T,
    signal: AbortSignal | undefined,
    useServerArguments = true,
  ): Promise<AdbObservation<T>> {
    const operationId = this.#idFactory();
    const correlation = { commandId: this.#options.correlation.commandId, operationId };
    const finalArgs = [...(useServerArguments ? this.#serverArguments() : []), ...args];

    this.#options.bus.emit({
      type: "operation.started",
      source: `adb.${operation}`,
      severity: "info",
      message,
      correlation,
      data: { executable: this.#options.executable, args: finalArgs },
    });

    const request: ProcessRequest = {
      executable: this.#options.executable,
      args: finalArgs,
      ...(this.#options.timeoutMs === undefined ? {} : { timeoutMs: this.#options.timeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    };
    const result = await this.#runner(request);
    const succeeded = result.spawnError === undefined && result.exitCode === 0 && !result.timedOut;

    this.#options.bus.emit({
      type: succeeded ? "operation.completed" : "operation.failed",
      source: `adb.${operation}`,
      severity: succeeded ? "info" : "error",
      message: succeeded ? `${message} completed` : `${message} failed`,
      correlation,
      data: processMetadata(result),
    });

    return {
      operationId,
      process: result,
      value: parse(result.stdout),
    };
  }
}
