import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 64 * 1024 * 1024;

export interface DecodedPng {
  width: number;
  height: number;
  bitDepth: 8;
  colorType: 0 | 2 | 4 | 6;
  pixels: Uint8Array;
}

export interface PngCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PngTransformOptions {
  crop?: PngCrop;
  maxWidth?: number;
  maxHeight?: number;
}

export interface TransformedPng {
  bytes: Uint8Array;
  source: { width: number; height: number };
  output: { width: number; height: number };
  crop?: PngCrop;
  encoding: { format: "png"; bitDepth: 8; colorType: "rgba" };
  truncated: boolean;
  truncation: Array<"cropped" | "resized">;
}

export class PngError extends Error {
  constructor(
    readonly code: "BOUNDS" | "CORRUPT" | "UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "PngError";
  }
}

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function channels(colorType: DecodedPng["colorType"]): number {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  return 4;
}

export function decodePng(input: Uint8Array): DecodedPng {
  const bytes = Buffer.from(input);
  if (bytes.byteLength < SIGNATURE.byteLength || !bytes.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngError("CORRUPT", "PNG signature is missing or incomplete.");
  }
  let offset = SIGNATURE.byteLength;
  let width: number | undefined;
  let height: number | undefined;
  let bitDepth: number | undefined;
  let colorType: number | undefined;
  let ended = false;
  let seenIdat = false;
  const compressed: Buffer[] = [];
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) throw new PngError("CORRUPT", "PNG chunk is incomplete.");
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.byteLength) throw new PngError("CORRUPT", "PNG chunk exceeds the file.");
    const type = bytes.subarray(offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) {
      throw new PngError("CORRUPT", `PNG ${type.toString("ascii")} checksum is invalid.`);
    }
    const name = type.toString("ascii");
    if (width === undefined && name !== "IHDR") {
      throw new PngError("CORRUPT", "PNG IHDR must be the first chunk.");
    }
    if (name === "IHDR") {
      if (width !== undefined || length !== 13)
        throw new PngError("CORRUPT", "PNG IHDR is invalid.");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0) {
        throw new PngError("UNSUPPORTED", "PNG compression or filtering method is unsupported.");
      }
      if (data[12] !== 0) throw new PngError("UNSUPPORTED", "Interlaced PNG is unsupported.");
    } else if (name === "IDAT") {
      seenIdat = true;
      compressed.push(data);
    } else if (name === "IEND") {
      if (length !== 0) throw new PngError("CORRUPT", "PNG IEND is invalid.");
      ended = true;
      offset = end;
      break;
    } else if ((type[0] ?? 0) >= 65 && (type[0] ?? 0) <= 90) {
      throw new PngError("UNSUPPORTED", `PNG critical chunk ${name} is unsupported.`);
    }
    offset = end;
  }
  if (
    !ended ||
    !seenIdat ||
    offset !== bytes.byteLength ||
    width === undefined ||
    height === undefined
  ) {
    throw new PngError("CORRUPT", "PNG structure is incomplete.");
  }
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  ) {
    throw new PngError("BOUNDS", "PNG dimensions exceed the supported decoding budget.");
  }
  if (
    bitDepth !== 8 ||
    (colorType !== 0 && colorType !== 2 && colorType !== 4 && colorType !== 6)
  ) {
    throw new PngError(
      "UNSUPPORTED",
      "PNG must use non-interlaced 8-bit grayscale, RGB, or RGBA pixels.",
    );
  }
  const channelCount = channels(colorType);
  const rowBytes = width * channelCount;
  const expectedBytes = (rowBytes + 1) * height;
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedBytes + 1 });
  } catch {
    throw new PngError("CORRUPT", "PNG pixel data could not be decompressed.");
  }
  if (inflated.byteLength !== expectedBytes) {
    throw new PngError("CORRUPT", "PNG pixel data has an unexpected size.");
  }
  const raw = Buffer.allocUnsafe(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const sourceOffset = y * (rowBytes + 1);
    const filter = inflated[sourceOffset];
    if (filter === undefined || filter > 4)
      throw new PngError("CORRUPT", "PNG row filter is invalid.");
    for (let x = 0; x < rowBytes; x += 1) {
      const encoded = inflated[sourceOffset + 1 + x] ?? 0;
      const destination = y * rowBytes + x;
      const left = x >= channelCount ? (raw[destination - channelCount] ?? 0) : 0;
      const above = y > 0 ? (raw[destination - rowBytes] ?? 0) : 0;
      const upperLeft =
        y > 0 && x >= channelCount ? (raw[destination - rowBytes - channelCount] ?? 0) : 0;
      raw[destination] =
        filter === 0
          ? encoded
          : filter === 1
            ? (encoded + left) & 0xff
            : filter === 2
              ? (encoded + above) & 0xff
              : filter === 3
                ? (encoded + Math.floor((left + above) / 2)) & 0xff
                : (encoded + paeth(left, above, upperLeft)) & 0xff;
    }
  }
  const pixels = new Uint8Array(width * height * 4);
  for (let source = 0, target = 0; source < raw.byteLength; source += channelCount, target += 4) {
    if (colorType === 0) {
      pixels[target] = raw[source] ?? 0;
      pixels[target + 1] = raw[source] ?? 0;
      pixels[target + 2] = raw[source] ?? 0;
      pixels[target + 3] = 255;
    } else if (colorType === 2) {
      pixels[target] = raw[source] ?? 0;
      pixels[target + 1] = raw[source + 1] ?? 0;
      pixels[target + 2] = raw[source + 2] ?? 0;
      pixels[target + 3] = 255;
    } else if (colorType === 4) {
      pixels[target] = raw[source] ?? 0;
      pixels[target + 1] = raw[source] ?? 0;
      pixels[target + 2] = raw[source] ?? 0;
      pixels[target + 3] = raw[source + 1] ?? 0;
    } else {
      pixels.set(raw.subarray(source, source + 4), target);
    }
  }
  return { width, height, bitDepth: 8, colorType, pixels };
}

function chunk(type: string, data: Uint8Array): Buffer {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.allocUnsafe(12 + data.byteLength);
  output.writeUInt32BE(data.byteLength, 0);
  name.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return output;
}

export function encodePng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS ||
    pixels.byteLength !== width * height * 4
  ) {
    throw new PngError("BOUNDS", "RGBA pixel dimensions are invalid.");
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.allocUnsafe((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const target = y * (width * 4 + 1);
    scanlines[target] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * width * 4, width * 4).copy(
      scanlines,
      target + 1,
    );
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanlines, { level: 6 })),
    chunk("IEND", new Uint8Array()),
  ]);
}

function cropPixels(source: DecodedPng, crop: PngCrop): Uint8Array {
  const pixels = new Uint8Array(crop.width * crop.height * 4);
  for (let y = 0; y < crop.height; y += 1) {
    const start = ((crop.y + y) * source.width + crop.x) * 4;
    pixels.set(source.pixels.subarray(start, start + crop.width * 4), y * crop.width * 4);
  }
  return pixels;
}

function resizePixels(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): Uint8Array {
  if (width === sourceWidth && height === sourceHeight) return source;
  const output = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = ((y + 0.5) * sourceHeight) / height - 0.5;
    const y0 = Math.max(0, Math.floor(sourceY));
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const fy = Math.max(0, sourceY - y0);
    for (let x = 0; x < width; x += 1) {
      const sourceX = ((x + 0.5) * sourceWidth) / width - 0.5;
      const x0 = Math.max(0, Math.floor(sourceX));
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const fx = Math.max(0, sourceX - x0);
      const target = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const top =
          (source[(y0 * sourceWidth + x0) * 4 + channel] ?? 0) * (1 - fx) +
          (source[(y0 * sourceWidth + x1) * 4 + channel] ?? 0) * fx;
        const bottom =
          (source[(y1 * sourceWidth + x0) * 4 + channel] ?? 0) * (1 - fx) +
          (source[(y1 * sourceWidth + x1) * 4 + channel] ?? 0) * fx;
        output[target + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return output;
}

export function transformPng(input: Uint8Array, options: PngTransformOptions = {}): TransformedPng {
  const decoded = decodePng(input);
  const crop = options.crop ?? { x: 0, y: 0, width: decoded.width, height: decoded.height };
  if (
    !Number.isSafeInteger(crop.x) ||
    !Number.isSafeInteger(crop.y) ||
    !Number.isSafeInteger(crop.width) ||
    !Number.isSafeInteger(crop.height) ||
    crop.x < 0 ||
    crop.y < 0 ||
    crop.width < 1 ||
    crop.height < 1 ||
    crop.x + crop.width > decoded.width ||
    crop.y + crop.height > decoded.height
  ) {
    throw new PngError("BOUNDS", "Screenshot crop lies outside the decoded source dimensions.");
  }
  for (const value of [options.maxWidth, options.maxHeight]) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < 1 || value > MAX_DIMENSION)
    ) {
      throw new PngError("BOUNDS", "Screenshot dimension limit must be from 1 to 16384 pixels.");
    }
  }
  const widthLimit = options.maxWidth ?? crop.width;
  const heightLimit = options.maxHeight ?? crop.height;
  const scale = Math.min(1, widthLimit / crop.width, heightLimit / crop.height);
  const width = Math.max(1, Math.floor(crop.width * scale));
  const height = Math.max(1, Math.floor(crop.height * scale));
  const cropped = cropPixels(decoded, crop);
  const pixels = resizePixels(cropped, crop.width, crop.height, width, height);
  const cropChanged =
    crop.x !== 0 || crop.y !== 0 || crop.width !== decoded.width || crop.height !== decoded.height;
  const resized = width !== crop.width || height !== crop.height;
  const truncation: TransformedPng["truncation"] = [
    ...(cropChanged ? (["cropped"] as const) : []),
    ...(resized ? (["resized"] as const) : []),
  ];
  return {
    bytes: encodePng(width, height, pixels),
    source: { width: decoded.width, height: decoded.height },
    output: { width, height },
    ...(options.crop === undefined ? {} : { crop }),
    encoding: { format: "png", bitDepth: 8, colorType: "rgba" },
    truncated: truncation.length > 0,
    truncation,
  };
}
