function box(type: string, ...parts: Uint8Array[]): Buffer {
  const size = 8 + parts.reduce((total, part) => total + part.byteLength, 0);
  const value = Buffer.alloc(size);
  value.writeUInt32BE(size, 0);
  value.write(type, 4, 4, "ascii");
  let offset = 8;
  for (const part of parts) {
    value.set(part, offset);
    offset += part.byteLength;
  }
  return value;
}

function extendedBox(type: string, ...parts: Uint8Array[]): Buffer {
  const size = 16 + parts.reduce((total, part) => total + part.byteLength, 0);
  const value = Buffer.alloc(size);
  value.writeUInt32BE(1, 0);
  value.write(type, 4, 4, "ascii");
  value.writeBigUInt64BE(BigInt(size), 8);
  let offset = 16;
  for (const part of parts) {
    value.set(part, offset);
    offset += part.byteLength;
  }
  return value;
}

function mediaHeader(timescale: number, duration: number, version: 0 | 1): Buffer {
  const value = Buffer.alloc(version === 0 ? 20 : 32);
  value.writeUInt8(version, 0);
  if (version === 0) {
    value.writeUInt32BE(timescale, 12);
    value.writeUInt32BE(duration, 16);
  } else {
    value.writeUInt32BE(timescale, 20);
    value.writeBigUInt64BE(BigInt(duration), 24);
  }
  return box("mdhd", value);
}

function handler(type: string): Buffer {
  const value = Buffer.alloc(12);
  value.write(type, 8, 4, "ascii");
  return box("hdlr", value);
}

function sampleSizes(frameCount: number): Buffer {
  const value = Buffer.alloc(12);
  value.writeUInt32BE(frameCount, 8);
  return box("stsz", value);
}

export function recordingMp4(
  options: {
    duration?: number;
    durationVersion?: 0 | 1;
    extendedFtyp?: boolean;
    frameCount?: number;
    handler?: string;
  } = {},
): Uint8Array<ArrayBuffer> {
  const ftypPayload = Buffer.from("mp42\0\0\0\0isommp42", "binary");
  const ftyp = options.extendedFtyp ? extendedBox("ftyp", ftypPayload) : box("ftyp", ftypPayload);
  const sampleTable = box("stbl", sampleSizes(options.frameCount ?? 6));
  const mediaInfo = box("minf", sampleTable);
  const media = box(
    "mdia",
    mediaHeader(90_000, options.duration ?? 225_975, options.durationVersion ?? 0),
    handler(options.handler ?? "vide"),
    mediaInfo,
  );
  return Uint8Array.from(
    Buffer.concat([ftyp, box("moov", box("trak", media)), box("mdat", Buffer.from([1]))]),
  );
}
