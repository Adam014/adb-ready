import { spawn } from "node:child_process";
import process from "node:process";

export type ProcessStdio = "capture" | "inherit";

export interface ProcessRequest {
  executable: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  killSignal?: NodeJS.Signals;
  killGraceMs?: number;
  stdio?: ProcessStdio;
  stdin?: "ignore" | "inherit";
  maxBufferBytes?: number;
  stopAfterIdleMs?: number;
  onStdoutChunk?: (chunk: Uint8Array) => void;
  onStderrChunk?: (chunk: Uint8Array) => void;
  input?: string | Uint8Array;
}

export interface ProcessResult {
  executable: string;
  args: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  stoppedAfterIdle: boolean;
  killEscalated: boolean;
  spawnError?: {
    code?: string;
    message: string;
  };
  streamError?: {
    stream: "stderr" | "stdout";
    message: string;
  };
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 1_000;

interface BoundedCapture {
  append(chunk: Uint8Array): void;
  text(): string;
  readonly truncated: boolean;
}

function createBoundedCapture(maxBytes: number): BoundedCapture {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;

  return {
    append(chunk) {
      if (size >= maxBytes) {
        truncated = true;
        return;
      }

      const remaining = maxBytes - size;
      const accepted = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
      chunks.push(accepted);
      size += accepted.byteLength;
      if (accepted.byteLength !== chunk.byteLength) {
        truncated = true;
      }
    },
    text() {
      const merged = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder("utf-8", { fatal: false }).decode(merged);
    },
    get truncated() {
      return truncated;
    },
  };
}

export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  const args = [...(request.args ?? [])];
  const started = new Date();
  const startedAt = started.toISOString();
  const maxBufferBytes = request.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const killGraceMs = request.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < 0) {
    throw new RangeError("maxBufferBytes must be a non-negative safe integer");
  }
  if (
    request.timeoutMs !== undefined &&
    (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0)
  ) {
    throw new RangeError("timeoutMs must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 0) {
    throw new RangeError("killGraceMs must be a non-negative safe integer");
  }
  if (
    request.stopAfterIdleMs !== undefined &&
    (!Number.isSafeInteger(request.stopAfterIdleMs) || request.stopAfterIdleMs < 1)
  ) {
    throw new RangeError("stopAfterIdleMs must be a positive safe integer");
  }
  if (request.stdio === "inherit" && request.input !== undefined) {
    throw new RangeError("input cannot be combined with inherited stdio");
  }
  if (request.stdin === "inherit" && request.input !== undefined) {
    throw new RangeError("input cannot be combined with inherited stdin");
  }
  if (request.stdio === "inherit" && request.stopAfterIdleMs !== undefined) {
    throw new RangeError("stopAfterIdleMs cannot be combined with inherited stdio");
  }
  if (
    request.stdio === "inherit" &&
    (request.onStdoutChunk !== undefined || request.onStderrChunk !== undefined)
  ) {
    throw new RangeError("stream callbacks cannot be combined with inherited stdio");
  }

  const stdout = createBoundedCapture(maxBufferBytes);
  const stderr = createBoundedCapture(maxBufferBytes);
  const stdio = request.stdio ?? "capture";
  let timedOut = false;
  let aborted = request.signal?.aborted ?? false;
  let stoppedAfterIdle = false;
  let killEscalated = false;
  let spawnError: ProcessResult["spawnError"];
  let streamError: ProcessResult["streamError"];

  return await new Promise<ProcessResult>((resolve) => {
    const child = spawn(request.executable, args, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      shell: false,
      stdio:
        stdio === "inherit"
          ? "inherit"
          : [
              request.stdin === "inherit"
                ? "inherit"
                : request.input === undefined
                  ? "ignore"
                  : "pipe",
              "pipe",
              "pipe",
            ],
      windowsHide: true,
    });

    const killSignal = request.killSignal ?? "SIGTERM";
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill(killSignal);
      if (killSignal !== "SIGKILL" && escalationTimer === undefined) {
        escalationTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            killEscalated = true;
            child.kill("SIGKILL");
          }
        }, killGraceMs);
      }
    };
    const touchIdleTimer = () => {
      if (request.stopAfterIdleMs === undefined || stoppedAfterIdle) {
        return;
      }
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        stoppedAfterIdle = true;
        terminate();
      }, request.stopAfterIdleMs);
    };

    if (stdio === "capture") {
      child.stdout?.on("data", (chunk: Uint8Array) => {
        stdout.append(chunk);
        try {
          request.onStdoutChunk?.(new Uint8Array(chunk));
        } catch (caught) {
          streamError ??= {
            stream: "stdout",
            message: caught instanceof Error ? caught.message : String(caught),
          };
          terminate();
        }
        if (streamError === undefined) {
          touchIdleTimer();
        }
      });
      child.stderr?.on("data", (chunk: Uint8Array) => {
        stderr.append(chunk);
        try {
          request.onStderrChunk?.(new Uint8Array(chunk));
        } catch (caught) {
          streamError ??= {
            stream: "stderr",
            message: caught instanceof Error ? caught.message : String(caught),
          };
          terminate();
        }
        if (streamError === undefined) {
          touchIdleTimer();
        }
      });
      if (request.input !== undefined) {
        child.stdin?.on("error", () => {
          // A child may close stdin before consuming all input. Its exit state
          // remains the authoritative operation result.
        });
        child.stdin?.end(request.input);
      }
    }

    const abort = () => {
      aborted = true;
      terminate();
    };

    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) {
      abort();
    }

    const timeout =
      request.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            if (idleTimer !== undefined) {
              clearTimeout(idleTimer);
            }
            terminate();
          }, request.timeoutMs);

    child.once("error", (error: NodeJS.ErrnoException) => {
      spawnError = {
        ...(error.code === undefined ? {} : { code: error.code }),
        message: error.message,
      };
    });

    child.once("close", (exitCode, signal) => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      if (escalationTimer !== undefined) {
        clearTimeout(escalationTimer);
      }
      request.signal?.removeEventListener("abort", abort);

      const finished = new Date();
      resolve({
        executable: request.executable,
        args,
        startedAt,
        finishedAt: finished.toISOString(),
        durationMs: Math.max(0, finished.getTime() - started.getTime()),
        exitCode: spawnError === undefined ? exitCode : null,
        signal: spawnError === undefined ? signal : null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
        aborted,
        stoppedAfterIdle,
        killEscalated,
        ...(spawnError === undefined ? {} : { spawnError }),
        ...(streamError === undefined ? {} : { streamError }),
      });
    });
  });
}
