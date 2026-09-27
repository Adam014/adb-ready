import { describe, expect, test } from "bun:test";
import { readSecretText } from "../../src/ui/secret-text.js";
import type { SelectInput } from "../../src/ui/select.js";

class EndingInput implements SelectInput {
  constructor(readonly chunks: Array<string | Uint8Array>) {}
  resume(): void {}
  pause(): void {}
  on(_event: "data", listener: (chunk: Uint8Array | string) => void): void {
    for (const chunk of this.chunks) queueMicrotask(() => listener(chunk));
  }
  off(): void {}
  once(_event: "end", listener: () => void): void {
    queueMicrotask(listener);
  }
}

describe("secret text input", () => {
  test("preserves Unicode and embedded newlines while removing one pipe terminator", async () => {
    await expect(readSecretText(new EndingInput(["Příliš\n好 🦊\n"]))).resolves.toEqual({
      kind: "submitted",
      value: "Příliš\n好 🦊",
    });
  });

  test("rejects empty, oversized, unavailable, and cancelled input", async () => {
    await expect(readSecretText(new EndingInput(["\n"]))).resolves.toEqual({
      kind: "cancelled",
      reason: "empty",
    });
    await expect(readSecretText(new EndingInput(["x".repeat(4_097)]))).resolves.toEqual({
      kind: "cancelled",
      reason: "too-large",
    });
    const unavailable = new EndingInput(["secret"]);
    unavailable.once = undefined as never;
    await expect(readSecretText(unavailable)).resolves.toEqual({ kind: "unavailable" });
    const controller = new AbortController();
    controller.abort();
    await expect(readSecretText(new EndingInput(["secret"]), controller.signal)).resolves.toEqual({
      kind: "cancelled",
      reason: "signal",
    });
    const throwing = new EndingInput([]);
    throwing.resume = () => {
      throw new Error("closed");
    };
    await expect(readSecretText(throwing)).resolves.toEqual({ kind: "unavailable" });
  });
});
