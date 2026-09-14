import type { FileHandle } from "node:fs/promises";
import { open, stat } from "node:fs/promises";

interface Mp4Box {
  type: string;
  payloadStart: number;
  end: number;
}

interface VideoTrack {
  duration: bigint;
  timescale: number;
  frameCount: number;
}

export type Mp4RecordingInspection =
  | {
      valid: true;
      durationMs: number;
      frameCount: number;
    }
  | {
      valid: false;
      reason: "empty-timeline" | "invalid-container" | "missing-video";
    };

const MAX_BOXES_PER_LEVEL = 4_096;

async function readAt(
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Buffer | undefined> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : undefined;
}

async function boxesBetween(
  handle: FileHandle,
  start: number,
  end: number,
): Promise<Mp4Box[] | undefined> {
  const boxes: Mp4Box[] = [];
  let cursor = start;
  while (cursor < end) {
    if (boxes.length >= MAX_BOXES_PER_LEVEL || end - cursor < 8) return undefined;
    const header = await readAt(handle, cursor, Math.min(16, end - cursor));
    if (header === undefined || header.byteLength < 8) return undefined;
    const size32 = header.readUInt32BE(0);
    const type = header.subarray(4, 8).toString("ascii");
    let headerSize = 8;
    let size: number;
    if (size32 === 0) {
      size = end - cursor;
    } else if (size32 === 1) {
      if (header.byteLength < 16) return undefined;
      const extended = header.readBigUInt64BE(8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
      size = Number(extended);
      headerSize = 16;
    } else {
      size = size32;
    }
    if (size < headerSize || cursor + size > end) return undefined;
    boxes.push({ type, payloadStart: cursor + headerSize, end: cursor + size });
    cursor += size;
  }
  return cursor === end ? boxes : undefined;
}

async function childBoxes(handle: FileHandle, box: Mp4Box): Promise<Mp4Box[] | undefined> {
  return await boxesBetween(handle, box.payloadStart, box.end);
}

async function handlerType(handle: FileHandle, box: Mp4Box): Promise<string | undefined> {
  const payload = await readAt(handle, box.payloadStart, 12);
  return payload?.subarray(8, 12).toString("ascii");
}

async function mediaDuration(
  handle: FileHandle,
  box: Mp4Box,
): Promise<{ duration: bigint; timescale: number } | undefined> {
  const version = await readAt(handle, box.payloadStart, 1);
  if (version === undefined) return undefined;
  const versionNumber = version.readUInt8(0);
  if (versionNumber === 0) {
    const payload = await readAt(handle, box.payloadStart, 20);
    if (payload === undefined) return undefined;
    return { timescale: payload.readUInt32BE(12), duration: BigInt(payload.readUInt32BE(16)) };
  }
  if (versionNumber === 1) {
    const payload = await readAt(handle, box.payloadStart, 32);
    if (payload === undefined) return undefined;
    return { timescale: payload.readUInt32BE(20), duration: payload.readBigUInt64BE(24) };
  }
  return undefined;
}

async function sampleCount(handle: FileHandle, box: Mp4Box): Promise<number | undefined> {
  const payload = await readAt(handle, box.payloadStart, 12);
  return payload?.readUInt32BE(8);
}

async function videoTrack(handle: FileHandle, track: Mp4Box): Promise<VideoTrack | undefined> {
  const trackChildren = await childBoxes(handle, track);
  const media = trackChildren?.find((box) => box.type === "mdia");
  if (media === undefined) return undefined;
  const mediaChildren = await childBoxes(handle, media);
  const header = mediaChildren?.find((box) => box.type === "hdlr");
  if (header === undefined || (await handlerType(handle, header)) !== "vide") return undefined;
  const mediaHeader = mediaChildren?.find((box) => box.type === "mdhd");
  const mediaInfo = mediaChildren?.find((box) => box.type === "minf");
  if (mediaHeader === undefined || mediaInfo === undefined) return undefined;
  const duration = await mediaDuration(handle, mediaHeader);
  const mediaInfoChildren = await childBoxes(handle, mediaInfo);
  const sampleTable = mediaInfoChildren?.find((box) => box.type === "stbl");
  if (duration === undefined || sampleTable === undefined) return undefined;
  const sampleTableChildren = await childBoxes(handle, sampleTable);
  const sampleSizes = sampleTableChildren?.find(
    (box) => box.type === "stsz" || box.type === "stz2",
  );
  if (sampleSizes === undefined) return undefined;
  const frameCount = await sampleCount(handle, sampleSizes);
  return frameCount === undefined ? undefined : { ...duration, frameCount };
}

function durationMilliseconds(track: VideoTrack): number | undefined {
  if (track.timescale < 1 || track.duration < 1n) return undefined;
  const milliseconds = (track.duration * 1_000n) / BigInt(track.timescale);
  if (milliseconds < 1n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(milliseconds);
}

export async function inspectMp4Recording(file: string): Promise<Mp4RecordingInspection> {
  const metadata = await stat(file).catch(() => undefined);
  if (metadata === undefined || !metadata.isFile() || metadata.size < 24) {
    return { valid: false, reason: "invalid-container" };
  }
  const handle = await open(file, "r").catch(() => undefined);
  if (handle === undefined) return { valid: false, reason: "invalid-container" };
  try {
    const topLevel = await boxesBetween(handle, 0, metadata.size);
    if (
      topLevel === undefined ||
      topLevel[0]?.type !== "ftyp" ||
      !topLevel.some((box) => box.type === "mdat")
    ) {
      return { valid: false, reason: "invalid-container" };
    }
    const movie = topLevel.find((box) => box.type === "moov");
    if (movie === undefined) return { valid: false, reason: "invalid-container" };
    const movieChildren = await childBoxes(handle, movie);
    if (movieChildren === undefined) return { valid: false, reason: "invalid-container" };
    const videoTracks = (
      await Promise.all(
        movieChildren
          .filter((box) => box.type === "trak")
          .map(async (track) => await videoTrack(handle, track)),
      )
    ).filter((track): track is VideoTrack => track !== undefined);
    if (videoTracks.length === 0) return { valid: false, reason: "missing-video" };
    for (const track of videoTracks) {
      const durationMs = durationMilliseconds(track);
      if (durationMs !== undefined && track.frameCount >= 2) {
        return { valid: true, durationMs, frameCount: track.frameCount };
      }
    }
    return { valid: false, reason: "empty-timeline" };
  } catch {
    return { valid: false, reason: "invalid-container" };
  } finally {
    await handle.close();
  }
}
