import { describe, expect, test } from "bun:test";
import { decodePng, encodePng, PngError, transformPng } from "../../src/evidence/png.js";

function pixels(width: number, height: number): Uint8Array {
  return Uint8Array.from({ length: width * height * 4 }, (_, index) => (index * 17) % 256);
}

describe("PNG evidence codec", () => {
  test("round-trips validated RGBA pixels", () => {
    const source = pixels(3, 2);
    const decoded = decodePng(encodePng(3, 2, source));
    expect(decoded).toMatchObject({ width: 3, height: 2, bitDepth: 8, colorType: 6 });
    expect(decoded.pixels).toEqual(source);
  });

  test("crops before a proportional bounded resize", () => {
    const transformed = transformPng(encodePng(6, 4, pixels(6, 4)), {
      crop: { x: 1, y: 1, width: 4, height: 2 },
      maxWidth: 2,
      maxHeight: 2,
    });
    expect(transformed).toMatchObject({
      source: { width: 6, height: 4 },
      output: { width: 2, height: 1 },
      crop: { x: 1, y: 1, width: 4, height: 2 },
      truncated: true,
      truncation: ["cropped", "resized"],
    });
    expect(decodePng(transformed.bytes)).toMatchObject({ width: 2, height: 1 });
  });

  test("never upscales and reports an untouched image", () => {
    const transformed = transformPng(encodePng(2, 3, pixels(2, 3)), {
      maxWidth: 20,
      maxHeight: 30,
    });
    expect(transformed).toMatchObject({
      source: { width: 2, height: 3 },
      output: { width: 2, height: 3 },
      truncated: false,
      truncation: [],
    });
  });

  test("rejects corrupt signatures, checksums, and source bounds", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(PngError);
    const corrupt = encodePng(1, 1, pixels(1, 1)).slice();
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 1;
    expect(() => decodePng(corrupt)).toThrow("checksum");
    expect(() =>
      transformPng(encodePng(2, 2, pixels(2, 2)), {
        crop: { x: 1, y: 1, width: 2, height: 2 },
      }),
    ).toThrow("outside");
  });

  test("rejects invalid encoder and transform dimensions", () => {
    expect(() => encodePng(2, 2, new Uint8Array(3))).toThrow("dimensions");
    expect(() => transformPng(encodePng(1, 1, pixels(1, 1)), { maxWidth: 0 })).toThrow(
      "dimension limit",
    );
  });
});
