import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandDependencies } from "../../src/app/commands.js";
import { runCapture } from "../../src/evidence/capture.js";
import { decodePng, encodePng } from "../../src/evidence/png.js";
import type { ProcessRequest, ProcessResult } from "../../src/platform/process-runner.js";
import { recordingMp4 } from "../fixtures/mp4.js";

function result(request: ProcessRequest, stdout = "", exitCode = 0): ProcessResult {
  return {
    executable: request.executable,
    args: [...(request.args ?? [])],
    startedAt: "2026-09-10T10:00:00.000Z",
    finishedAt: "2026-09-10T10:00:00.010Z",
    durationMs: 10,
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    stoppedAfterIdle: false,
    killEscalated: false,
  };
}

function fixture(png: Uint8Array, requests: string[][]): CommandDependencies {
  let id = 0;
  return {
    idFactory: () => `id-${String(++id)}`,
    clock: () => new Date("2026-09-10T10:00:00.000Z"),
    locateAdb: async () => "/sdk/adb",
    runner: async (request) => {
      const args = [...(request.args ?? [])];
      requests.push(args);
      if (args.includes("devices")) {
        return result(
          request,
          "List of devices attached\nUSB-1 device model:Pixel_9 transport_id:1\n",
        );
      }
      if (args.includes("host-features")) return result(request, "shell_v2\n");
      if (args.includes("mdns")) return result(request, "List of discovered mdns services\n");
      if (args.includes("ro.serialno")) return result(request, "hardware-1\n");
      if (args.includes("screencap")) {
        request.onStdoutChunk?.(png);
        return result(request);
      }
      return result(request);
    },
  };
}

describe("evidence capture", () => {
  test("streams a PNG into an atomic project file and returns verified metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-capture-"));
    const png = encodePng(
      2,
      2,
      Uint8Array.from({ length: 16 }, (_, index) => index * 8),
    );
    const requests: string[][] = [];
    try {
      const execution = await runCapture(
        { kind: "screenshot", cwd: root, out: "evidence/screen.png" },
        {},
        fixture(png, requests),
      );
      expect(execution.result).toMatchObject({
        ok: true,
        data: {
          kind: "screenshot",
          evidence: {
            path: "evidence/screen.png",
            mediaType: "image/png",
            bytes: png.byteLength,
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            image: {
              source: { width: 2, height: 2 },
              output: { width: 2, height: 2 },
              budget: "full-resolution",
              truncated: false,
            },
          },
        },
      });
      expect([...new Uint8Array(await readFile(path.join(root, "evidence/screen.png")))]).toEqual([
        ...png,
      ]);
      expect(requests.some((args) => args.includes("exec-out") && args.includes("screencap"))).toBe(
        true,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("strips a bounded textual OEM warning before streamed PNG data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-capture-"));
    const png = encodePng(1, 1, Uint8Array.from([10, 20, 30, 255]));
    const warning = new TextEncoder().encode(
      "[Warning] Multiple displays were found, but no display id was specified.\n",
    );
    const output = new Uint8Array(warning.byteLength + png.byteLength);
    output.set(warning);
    output.set(png, warning.byteLength);
    try {
      const execution = await runCapture(
        { kind: "screenshot", cwd: root, out: "screen.png" },
        {},
        fixture(output, []),
      );
      expect(execution.result).toMatchObject({
        ok: true,
        data: { evidence: { bytes: png.byteLength } },
      });
      expect([...new Uint8Array(await readFile(path.join(root, "screen.png")))]).toEqual([...png]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("crops and bounds screenshots with correlated metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-capture-"));
    const pixels = new Uint8Array(4 * 4 * 4);
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = index;
    try {
      const execution = await runCapture(
        {
          kind: "screenshot",
          cwd: root,
          out: "bounded.png",
          crop: { x: 1, y: 0, width: 2, height: 4 },
          maxHeight: 2,
          budget: "custom",
          payloadBudgetBytes: 1_000,
        },
        {},
        fixture(encodePng(4, 4, pixels), []),
      );
      expect(execution.result).toMatchObject({
        ok: true,
        data: {
          evidence: {
            image: {
              source: { width: 4, height: 4 },
              output: { width: 1, height: 2 },
              crop: { x: 1, y: 0, width: 2, height: 4 },
              budget: "custom",
              truncated: true,
              truncation: ["cropped", "resized"],
            },
          },
        },
      });
      expect(decodePng(await readFile(path.join(root, "bounded.png")))).toMatchObject({
        width: 1,
        height: 2,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects crops outside decoded source bounds without keeping evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-capture-"));
    try {
      const execution = await runCapture(
        {
          kind: "screenshot",
          cwd: root,
          out: "bad.png",
          crop: { x: 2, y: 0, width: 2, height: 2 },
        },
        {},
        fixture(encodePng(2, 2, new Uint8Array(16)), []),
      );
      expect(execution.result).toMatchObject({
        ok: false,
        problems: [{ code: "SCREENSHOT_BOUNDS_INVALID" }],
      });
      await expect(readFile(path.join(root, "bad.png"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("enforces the processed screenshot payload budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-capture-"));
    try {
      const execution = await runCapture(
        { kind: "screenshot", cwd: root, out: "large.png", payloadBudgetBytes: 1 },
        {},
        fixture(encodePng(1, 1, new Uint8Array([1, 2, 3, 255])), []),
      );
      expect(execution.result).toMatchObject({
        ok: false,
        problems: [{ code: "SCREENSHOT_PAYLOAD_TOO_LARGE" }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid binary output and leaves no final file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-capture-"));
    try {
      const execution = await runCapture(
        { kind: "screenshot", cwd: root, out: "screen.png" },
        {},
        fixture(new TextEncoder().encode("not a png"), []),
      );
      expect(execution.result).toMatchObject({
        ok: false,
        problems: [{ code: "SCREENSHOT_INVALID" }],
      });
      await expect(readFile(path.join(root, "screen.png"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bounds, transfers, verifies, and cleans only its owned device recording", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-record-"));
    const requests: string[][] = [];
    const mp4 = recordingMp4();
    const dependencies = fixture(new Uint8Array(), requests);
    const baseRunner = dependencies.runner;
    dependencies.runner = async (request) => {
      const args = [...(request.args ?? [])];
      if (args.includes("pull")) {
        requests.push(args);
        const destination = args.at(-1);
        if (destination === undefined) throw new Error("missing pull destination");
        await writeFile(destination, mp4);
        return result(request, "1 file pulled\n");
      }
      return (await baseRunner?.(request)) ?? result(request);
    };
    try {
      const execution = await runCapture(
        {
          kind: "screen-record",
          cwd: root,
          out: "evidence/demo.mp4",
          durationSeconds: 2,
        },
        {},
        dependencies,
      );
      expect(execution.result).toMatchObject({
        ok: true,
        data: {
          kind: "screen-record",
          durationSeconds: 2,
          evidence: {
            path: "evidence/demo.mp4",
            mediaType: "video/mp4",
            bytes: mp4.byteLength,
            durationMs: 2_510,
            frameCount: 6,
          },
        },
      });
      const record = requests.find((args) => args.includes("screenrecord"));
      const cleanup = requests.find((args) => args.includes("rm") && args.includes("-f"));
      expect(record).toEqual(expect.arrayContaining(["screenrecord", "--time-limit", "2"]));
      expect(cleanup?.at(-1)).toBe(record?.at(-1));
      expect(new Uint8Array(await readFile(path.join(root, "evidence/demo.mp4")))).toEqual(mp4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects Android recordings without a temporal frame timeline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-record-"));
    const requests: string[][] = [];
    const dependencies = fixture(new Uint8Array(), requests);
    const baseRunner = dependencies.runner;
    dependencies.runner = async (request) => {
      const args = [...(request.args ?? [])];
      if (args.includes("pull")) {
        const destination = args.at(-1);
        if (destination === undefined) throw new Error("missing pull destination");
        await writeFile(destination, recordingMp4({ duration: 0, frameCount: 1 }));
        return result(request, "1 file pulled\n");
      }
      return (await baseRunner?.(request)) ?? result(request);
    };
    try {
      const execution = await runCapture(
        { kind: "screen-record", cwd: root, out: "empty.mp4", durationSeconds: 2 },
        {},
        dependencies,
      );
      expect(execution.result).toMatchObject({
        ok: false,
        data: null,
        problems: [
          {
            code: "SCREEN_RECORD_EMPTY",
            summary: "Android produced a screen recording without a usable timeline.",
          },
        ],
      });
      await expect(readFile(path.join(root, "empty.mp4"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(requests.some((args) => args.includes("rm") && args.includes("-f"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
