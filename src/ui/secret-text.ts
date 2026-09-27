import { Buffer } from "node:buffer";
import type { SelectInput } from "./select.js";

const MAX_SECRET_BYTES = 4_096;

interface EndAwareInput {
  once?(event: "end", listener: () => void): unknown;
}

export type SecretTextResult =
  | { kind: "submitted"; value: string }
  | { kind: "cancelled"; reason: "empty" | "signal" | "too-large" }
  | { kind: "unavailable" };

export async function readSecretText(
  input: SelectInput,
  signal?: AbortSignal,
): Promise<SecretTextResult> {
  return await new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let settled = false;

    const attempt = (operation: () => unknown): void => {
      try {
        operation();
      } catch {
        // Cleanup is best-effort so independent restoration still runs.
      }
    };
    const cleanup = (): void => {
      attempt(() => input.off("data", onData));
      attempt(() => signal?.removeEventListener("abort", onAbort));
      attempt(() => input.pause());
    };
    const settle = (result: SecretTextResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = (): void => settle({ kind: "cancelled", reason: "signal" });
    const onData = (chunk: Uint8Array | string): void => {
      const encoded = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
      bytes += encoded.byteLength;
      if (bytes > MAX_SECRET_BYTES) {
        settle({ kind: "cancelled", reason: "too-large" });
        return;
      }
      chunks.push(encoded);
    };
    const onEnd = (): void => {
      const value = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
        .toString("utf8")
        .replace(/\r?\n$/u, "");
      settle(value === "" ? { kind: "cancelled", reason: "empty" } : { kind: "submitted", value });
    };

    try {
      input.resume();
      input.on("data", onData);
      const endAware = input as SelectInput & EndAwareInput;
      if (endAware.once === undefined) {
        settle({ kind: "unavailable" });
        return;
      }
      endAware.once("end", onEnd);
      signal?.addEventListener("abort", onAbort, { once: true });
    } catch {
      settle({ kind: "unavailable" });
      return;
    }
    if (signal?.aborted) onAbort();
  });
}
