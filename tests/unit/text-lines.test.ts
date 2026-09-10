import { describe, expect, test } from "bun:test";
import { TextLineBuffer } from "../../src/core/text-lines.js";

describe("TextLineBuffer", () => {
  test("preserves lines across arbitrary UTF-8 chunk boundaries and flushes the tail", () => {
    const lines: string[] = [];
    const buffer = new TextLineBuffer((line) => lines.push(line));
    const bytes = new TextEncoder().encode("first\r\nemoji 😀\npartial");
    buffer.push(bytes.subarray(0, 15));
    buffer.push(bytes.subarray(15, 18));
    buffer.push(bytes.subarray(18));
    buffer.flush();
    expect(lines).toEqual(["first", "emoji 😀", "partial"]);
  });
});
