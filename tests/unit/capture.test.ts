import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandDependencies } from "../../src/app/commands.js";
import { runCapture } from "../../src/evidence/capture.js";
import type { ProcessRequest, ProcessResult } from "../../src/platform/process-runner.js";

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
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
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
          },
        },
      });
      expect(new Uint8Array(await readFile(path.join(root, "evidence/screen.png")))).toEqual(png);
      expect(requests.some((args) => args.includes("exec-out") && args.includes("screencap"))).toBe(
        true,
      );
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
    const mp4 = Uint8Array.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
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
          evidence: { path: "evidence/demo.mp4", mediaType: "video/mp4", bytes: mp4.byteLength },
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
});
