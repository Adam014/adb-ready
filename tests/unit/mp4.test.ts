import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectMp4Recording } from "../../src/evidence/mp4.js";
import { recordingMp4 } from "../fixtures/mp4.js";

async function inspect(contents: Uint8Array) {
  const root = await mkdtemp(path.join(tmpdir(), "adb-ready-mp4-"));
  const file = path.join(root, "recording.mp4");
  try {
    await writeFile(file, contents);
    return await inspectMp4Recording(file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("MP4 recording inspection", () => {
  test("reads the Android video track duration and frame count", async () => {
    expect(await inspect(recordingMp4())).toEqual({
      valid: true,
      durationMs: 2_510,
      frameCount: 6,
    });
  });

  test("accepts ISO extended box sizes and version-one media durations", async () => {
    expect(await inspect(recordingMp4({ durationVersion: 1, extendedFtyp: true }))).toEqual({
      valid: true,
      durationMs: 2_510,
      frameCount: 6,
    });
  });

  test("rejects a one-frame track without a media timeline", async () => {
    expect(await inspect(recordingMp4({ duration: 0, frameCount: 1 }))).toEqual({
      valid: false,
      reason: "empty-timeline",
    });
  });

  test("distinguishes missing video tracks from malformed containers", async () => {
    expect(await inspect(recordingMp4({ handler: "meta" }))).toEqual({
      valid: false,
      reason: "missing-video",
    });
    expect(await inspect(Buffer.from("not an mp4"))).toEqual({
      valid: false,
      reason: "invalid-container",
    });
  });
});
