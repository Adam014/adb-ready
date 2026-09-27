import { createHash, randomUUID } from "node:crypto";
import { createReadStream, writeSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import {
  type Context,
  context,
  finish,
  operationProblem,
  problem,
  type ReadyTarget,
  readyTarget,
  succeeded,
} from "../app/app-commands.js";
import type { CommandConfig, CommandDependencies, CommandExecution } from "../app/commands.js";
import type { Problem } from "../domain/contracts.js";
import {
  commitEvidenceDestination,
  discardEvidenceDestination,
  EvidencePathError,
  openEvidenceTemporary,
  prepareEvidenceDestination,
} from "./files.js";
import { inspectMp4Recording } from "./mp4.js";
import { type PngCrop, PngError, transformPng } from "./png.js";

export type CaptureKind = "screen-record" | "screenshot";

export interface CaptureRequest {
  kind: CaptureKind;
  cwd: string;
  out?: string;
  force?: boolean;
  durationSeconds?: number;
  crop?: PngCrop;
  maxWidth?: number;
  maxHeight?: number;
  payloadBudgetBytes?: number;
  budget?: "context-safe" | "custom" | "full-resolution";
}

export interface EvidenceFile {
  path: string;
  mediaType: "image/png" | "video/mp4";
  bytes: number;
  sha256: string;
  durationMs?: number;
  frameCount?: number;
  observedAt: string;
  image?: {
    source: { width: number; height: number };
    output: { width: number; height: number };
    crop?: PngCrop;
    encoding: { format: "png"; bitDepth: 8; colorType: "rgba" };
    budget: "context-safe" | "custom" | "full-resolution";
    truncated: boolean;
    truncation: Array<"cropped" | "resized">;
  };
  provenance: {
    command: "exec-out screencap -p" | "shell screenrecord";
    targetSerial: string;
  };
}

export interface CaptureData {
  kind: CaptureKind;
  selected: import("../target/selection.js").SelectedTarget;
  evidence: EvidenceFile;
  durationSeconds?: number;
}

function captureInputProblem(request: CaptureRequest, commandId: string): Problem | undefined {
  const screenshotOptions = [
    request.crop,
    request.maxWidth,
    request.maxHeight,
    request.payloadBudgetBytes,
    request.budget,
  ];
  if (request.kind !== "screenshot" && screenshotOptions.some((value) => value !== undefined)) {
    return problem(
      "SCREENSHOT_OPTIONS_MISMATCH",
      "input.evidence.screenshot",
      "Screenshot crop and dimension options cannot be used for a screen recording.",
      "Remove screenshot-only options or capture a screenshot.",
      commandId,
    );
  }
  for (const value of [request.maxWidth, request.maxHeight]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 16_384)) {
      return problem(
        "SCREENSHOT_DIMENSION_LIMIT_INVALID",
        "input.evidence.screenshot",
        "Screenshot dimension limits must be whole pixels from 1 to 16384.",
        "Pass a positive --max-width or --max-height within the decoder budget.",
        commandId,
      );
    }
  }
  if (request.crop !== undefined) {
    const { x, y, width, height } = request.crop;
    if (
      ![x, y, width, height].every(Number.isSafeInteger) ||
      x < 0 ||
      y < 0 ||
      width < 1 ||
      height < 1 ||
      x + width > 16_384 ||
      y + height > 16_384
    ) {
      return problem(
        "SCREENSHOT_CROP_INVALID",
        "input.evidence.screenshot",
        "Screenshot crop must be X,Y,WIDTH,HEIGHT in bounded whole pixels.",
        "Use non-negative origins, positive dimensions, and an area inside the source screenshot.",
        commandId,
      );
    }
  }
  if (
    request.payloadBudgetBytes !== undefined &&
    (!Number.isSafeInteger(request.payloadBudgetBytes) ||
      request.payloadBudgetBytes < 1 ||
      request.payloadBudgetBytes > MAX_SCREENSHOT_BYTES)
  ) {
    return problem(
      "SCREENSHOT_PAYLOAD_BUDGET_INVALID",
      "input.evidence.screenshot",
      "Screenshot payload budget must be from 1 byte to 64 MiB.",
      "Choose a bounded agent payload budget.",
      commandId,
    );
  }
  return undefined;
}

function pathProblem(caught: unknown, current: Context): Problem {
  const code = caught instanceof EvidencePathError ? caught.code : "IO";
  return problem(
    `EVIDENCE_PATH_${code}`,
    "input.evidence.path",
    caught instanceof Error ? caught.message : "The evidence output path is unavailable.",
    "Choose a new relative path inside the project, or pass --force for an existing regular file.",
    current.commandId,
  );
}

function defaultName(kind: CaptureKind, current: Context): string {
  const timestamp = current.started.toISOString().replaceAll(/[:.]/gu, "-");
  return `${kind}-${timestamp}.${kind === "screenshot" ? "png" : "mp4"}`;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_TEXT_PREAMBLE_BYTES = 16 * 1024;
const MAX_SCREENSHOT_BYTES = 64 * 1024 * 1024;

function isTextPreamble(value: Uint8Array): boolean {
  return value.every(
    (byte) => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126),
  );
}

class PngStreamWriter {
  readonly #fd: number;
  #pending = Buffer.alloc(0);
  #started = false;
  #rejected = false;
  bytes = 0;

  constructor(fd: number) {
    this.#fd = fd;
  }

  write(chunk: Uint8Array): void {
    if (this.#rejected) return;
    if (this.#started) {
      if (this.bytes + chunk.byteLength > MAX_SCREENSHOT_BYTES) {
        this.#rejected = true;
        return;
      }
      writeSync(this.#fd, chunk);
      this.bytes += chunk.byteLength;
      return;
    }

    const combined = Buffer.concat([this.#pending, Buffer.from(chunk)]);
    const offset = combined.indexOf(PNG_SIGNATURE);
    if (offset === -1) {
      if (combined.byteLength > MAX_PNG_TEXT_PREAMBLE_BYTES + PNG_SIGNATURE.byteLength - 1) {
        this.#rejected = true;
        this.#pending = Buffer.alloc(0);
        return;
      }
      this.#pending = combined;
      return;
    }
    if (offset > MAX_PNG_TEXT_PREAMBLE_BYTES || !isTextPreamble(combined.subarray(0, offset))) {
      this.#rejected = true;
      this.#pending = Buffer.alloc(0);
      return;
    }

    const png = combined.subarray(offset);
    if (png.byteLength > MAX_SCREENSHOT_BYTES) {
      this.#rejected = true;
      this.#pending = Buffer.alloc(0);
      return;
    }
    writeSync(this.#fd, png);
    this.bytes += png.byteLength;
    this.#pending = Buffer.alloc(0);
    this.#started = true;
  }

  get valid(): boolean {
    return this.#started && !this.#rejected && this.bytes >= PNG_SIGNATURE.byteLength;
  }
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function captureScreenshot(
  request: CaptureRequest,
  current: Context,
  ready: ReadyTarget,
  destination: Awaited<ReturnType<typeof prepareEvidenceDestination>>,
  problems: Problem[],
  signal?: AbortSignal,
): Promise<EvidenceFile | undefined> {
  const handle = await openEvidenceTemporary(destination);
  const png = new PngStreamWriter(handle.fd);
  let observation: Awaited<ReturnType<ReadyTarget["client"]["targetCommand"]>>;
  try {
    observation = await ready.client.targetCommand(
      ready.target,
      "capture-screenshot",
      "Capturing Android screenshot",
      ["exec-out", "screencap", "-p"],
      () => undefined,
      signal,
      {
        maxBufferBytes: 64 * 1024,
        onStdoutChunk: (chunk) => png.write(chunk),
      },
    );
  } finally {
    await handle.close();
  }
  if (!succeeded(observation.process) || !png.valid) {
    await discardEvidenceDestination(destination);
    problems.push(
      succeeded(observation.process)
        ? problem(
            "SCREENSHOT_INVALID",
            "evidence.capture",
            "ADB did not return a valid PNG screenshot.",
            "The selected target may have a secure or unavailable display.",
            current.commandId,
          )
        : operationProblem("capture-screenshot", observation, current.commandId),
    );
    return undefined;
  }
  let transformed: ReturnType<typeof transformPng>;
  try {
    transformed = transformPng(await readFile(destination.temporaryPath), {
      ...(request.crop === undefined ? {} : { crop: request.crop }),
      ...(request.maxWidth === undefined ? {} : { maxWidth: request.maxWidth }),
      ...(request.maxHeight === undefined ? {} : { maxHeight: request.maxHeight }),
    });
  } catch (caught) {
    await discardEvidenceDestination(destination);
    const pngError = caught instanceof PngError ? caught : undefined;
    problems.push(
      problem(
        pngError?.code === "BOUNDS"
          ? "SCREENSHOT_BOUNDS_INVALID"
          : pngError?.code === "UNSUPPORTED"
            ? "SCREENSHOT_ENCODING_UNSUPPORTED"
            : "SCREENSHOT_INVALID",
        pngError?.code === "BOUNDS" ? "input.evidence.screenshot" : "evidence.capture",
        pngError?.message ?? "ADB did not return a decodable PNG screenshot.",
        "Use a crop inside the reported source dimensions and limits from 1 to 16384 pixels. The target must emit a standard non-interlaced 8-bit PNG.",
        current.commandId,
      ),
    );
    return undefined;
  }
  if (
    request.payloadBudgetBytes !== undefined &&
    transformed.bytes.byteLength > request.payloadBudgetBytes
  ) {
    await discardEvidenceDestination(destination);
    problems.push(
      problem(
        "SCREENSHOT_PAYLOAD_TOO_LARGE",
        "evidence.capture",
        `The processed screenshot is ${String(transformed.bytes.byteLength)} bytes, above the ${String(request.payloadBudgetBytes)}-byte agent payload budget.`,
        "Crop a smaller region, lower maxWidth/maxHeight, or request fullResolution only when the client can accept the larger payload.",
        current.commandId,
      ),
    );
    return undefined;
  }
  await writeFile(destination.temporaryPath, transformed.bytes, { flag: "w", mode: 0o600 });
  await commitEvidenceDestination(destination, request.force === true);
  return {
    path: destination.relativePath,
    mediaType: "image/png",
    bytes: transformed.bytes.byteLength,
    sha256: await sha256(destination.finalPath),
    observedAt: current.clock().toISOString(),
    image: {
      source: transformed.source,
      output: transformed.output,
      ...(transformed.crop === undefined ? {} : { crop: transformed.crop }),
      encoding: transformed.encoding,
      budget:
        request.budget ??
        (request.maxWidth === undefined &&
        request.maxHeight === undefined &&
        request.crop === undefined
          ? "full-resolution"
          : "custom"),
      truncated: transformed.truncated,
      truncation: transformed.truncation,
    },
    provenance: { command: "exec-out screencap -p", targetSerial: ready.target.serial },
  };
}

async function captureScreenRecord(
  request: CaptureRequest,
  current: Context,
  ready: ReadyTarget,
  destination: Awaited<ReturnType<typeof prepareEvidenceDestination>>,
  problems: Problem[],
  signal?: AbortSignal,
): Promise<EvidenceFile | undefined> {
  const duration = request.durationSeconds ?? 10;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 180) {
    problems.push(
      problem(
        "SCREEN_RECORD_DURATION_INVALID",
        "input.evidence.duration",
        "Screen recording duration must be from 1 to 180 seconds.",
        "Choose a bounded duration supported by Android screenrecord.",
        current.commandId,
      ),
    );
    return undefined;
  }
  const nonce = randomUUID();
  const remote = `/data/local/tmp/adb-ready-${nonce}.mp4`;
  const recorded = await ready.client.targetCommand(
    ready.target,
    "capture-screen-record",
    `Recording Android screen for ${String(duration)} seconds`,
    ["shell", "screenrecord", "--time-limit", String(duration), remote],
    () => undefined,
    signal,
    { timeoutMs: (duration + 10) * 1_000 },
  );
  try {
    if (!succeeded(recorded.process)) {
      problems.push(operationProblem("capture-screen-record", recorded, current.commandId));
      return undefined;
    }
    const pulled = await ready.client.targetCommand(
      ready.target,
      "capture-screen-record-pull",
      "Transferring Android screen recording",
      ["pull", remote, destination.temporaryPath],
      () => undefined,
      signal,
    );
    if (!succeeded(pulled.process)) {
      problems.push(
        problem(
          "SCREEN_RECORD_PULL_FAILED",
          "evidence.capture",
          "The screen recording could not be transferred from the selected target.",
          "ADB Ready kept no incomplete local evidence file.",
          current.commandId,
        ),
      );
      await discardEvidenceDestination(destination);
      return undefined;
    }
    const inspection = await inspectMp4Recording(destination.temporaryPath);
    if (!inspection.valid) {
      const empty = inspection.reason === "empty-timeline";
      problems.push(
        problem(
          empty ? "SCREEN_RECORD_EMPTY" : "SCREEN_RECORD_INVALID",
          "evidence.capture",
          empty
            ? "Android produced a screen recording without a usable timeline."
            : "Android produced an unreadable or incomplete MP4 screen recording.",
          empty
            ? "Trigger visible activity during capture and retry; Android screenrecord can emit a one-frame, zero-duration MP4 when the display stays static."
            : "Retry the capture after confirming Android screenrecord is available on the selected target.",
          current.commandId,
        ),
      );
      await discardEvidenceDestination(destination);
      return undefined;
    }
    const metadata = await stat(destination.temporaryPath);
    await commitEvidenceDestination(destination, request.force === true);
    return {
      path: destination.relativePath,
      mediaType: "video/mp4",
      bytes: metadata.size,
      sha256: await sha256(destination.finalPath),
      durationMs: inspection.durationMs,
      frameCount: inspection.frameCount,
      observedAt: current.clock().toISOString(),
      provenance: { command: "shell screenrecord", targetSerial: ready.target.serial },
    };
  } finally {
    const cleanup = await ready.client.targetCommand(
      ready.target,
      "capture-screen-record-cleanup",
      "Cleaning owned device recording",
      ["shell", "rm", "-f", remote],
      () => undefined,
      undefined,
    );
    if (!succeeded(cleanup.process)) {
      problems.push(operationProblem("capture-screen-record-cleanup", cleanup, current.commandId));
    }
  }
}

export async function runCapture(
  request: CaptureRequest,
  config: CommandConfig = {},
  dependencies: CommandDependencies = {},
  signal?: AbortSignal,
): Promise<CommandExecution<CaptureData>> {
  const current = context(`capture ${request.kind}`, dependencies);
  const problems: Problem[] = [];
  const inputProblem = captureInputProblem(request, current.commandId);
  if (inputProblem !== undefined) {
    problems.push(inputProblem);
    return finish<CaptureData>(current, null, problems);
  }
  const ready = await readyTarget(current, config, dependencies, problems, signal);
  if (ready === undefined) return finish<CaptureData>(current, null, problems);
  let destination: Awaited<ReturnType<typeof prepareEvidenceDestination>>;
  try {
    destination = await prepareEvidenceDestination({
      root: request.cwd,
      ...(request.out === undefined ? {} : { requested: request.out }),
      defaultName: defaultName(request.kind, current),
      ...(request.force === undefined ? {} : { force: request.force }),
      nonce: randomUUID(),
    });
  } catch (caught) {
    problems.push(pathProblem(caught, current));
    return finish<CaptureData>(current, null, problems);
  }
  let evidence: EvidenceFile | undefined;
  try {
    evidence =
      request.kind === "screenshot"
        ? await captureScreenshot(request, current, ready, destination, problems, signal)
        : await captureScreenRecord(request, current, ready, destination, problems, signal);
  } catch (caught) {
    await discardEvidenceDestination(destination);
    problems.push(pathProblem(caught, current));
  }
  return finish(
    current,
    evidence === undefined
      ? null
      : {
          kind: request.kind,
          selected: ready.selected,
          evidence,
          ...(request.kind === "screen-record"
            ? { durationSeconds: request.durationSeconds ?? 10 }
            : {}),
        },
    problems,
  );
}
