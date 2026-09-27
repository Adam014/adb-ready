import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { physicalRunArguments } from "../../examples/ci-physical/run-job.mjs";
import { verifyPhysicalDevice } from "../../examples/ci-physical/verify-device.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

describe("self-hosted physical-device example", () => {
  test("builds one portable direct-argv finite run", () => {
    const args = physicalRunArguments({ ADB_READY_DEVICE_SERIAL: "USB-1" });
    expect(args).toContain("USB-1");
    expect(args).toContain("--non-interactive");
    expect(args).toContain("ndjson");
    expect(args.slice(-2)).toEqual([process.execPath, "examples/ci-physical/verify-device.mjs"]);
    expect(() => physicalRunArguments({})).toThrow("must name one pre-authorized");
    expect(() => physicalRunArguments({ ADB_READY_DEVICE_SERIAL: "USB-1\nother" })).toThrow(
      "must name one pre-authorized",
    );
  });

  test("verifies one bound physical target without collecting screen content", async () => {
    const writes: string[][] = [];
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-physical-evidence-"));
    try {
      const result = await verifyPhysicalDevice({
        env: {
          ADB_READY_TARGET_SERIAL: "USB-1",
          ANDROID_SERIAL: "USB-1",
          ADB_READY_VERIFIER_OUTPUT_DIR: directory,
        },
        runAdb: async (args) => {
          writes.push(args);
          const command = args.join(" ");
          if (command === "get-state") return Buffer.from("device\n");
          if (command.endsWith("getprop sys.boot_completed")) return Buffer.from("1\n");
          if (command.endsWith("getprop ro.build.version.sdk")) return Buffer.from("35\n");
          return Buffer.alloc(0);
        },
      });
      expect(result).toEqual({ apiLevel: "35" });
      expect(writes.some((args) => args.includes("screencap"))).toBeFalse();
      expect(JSON.parse(await readFile(path.join(directory, "verification.json"), "utf8"))).toEqual(
        {
          schemaVersion: 1,
          targetBound: true,
          state: "device",
          bootCompleted: true,
          apiLevel: "35",
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a mismatched target before invoking ADB", async () => {
    let called = false;
    await expect(
      verifyPhysicalDevice({
        env: {
          ADB_READY_TARGET_SERIAL: "USB-1",
          ANDROID_SERIAL: "USB-2",
          ADB_READY_VERIFIER_OUTPUT_DIR: "/tmp/evidence",
        },
        runAdb: async () => {
          called = true;
          return Buffer.alloc(0);
        },
      }),
    ).rejects.toThrow("did not bind");
    expect(called).toBeFalse();
  });

  test("keeps the copyable workflow manual, serialized, immutable, and evidence-preserving", async () => {
    const workflow = await readFile(
      path.join(root, "examples", "ci-physical", "github-actions.yml"),
      "utf8",
    );
    const actionReferences = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gmu)].map(
      ([, reference]) => reference,
    );
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).toContain("runs-on: [self-hosted, android-device]");
    expect(workflow).toContain("group: physical-android-device");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toMatch(/ADB_READY_DEVICE_SERIAL: \$\{\{ vars\.ADB_READY_DEVICE_SERIAL \}\}/u);
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("include-hidden-files: true");
    for (const reference of actionReferences) expect(reference).toMatch(/@[0-9a-f]{40}$/u);
  });
});
