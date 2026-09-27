import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyEmulator } from "../../examples/ci-emulator/verify-emulator.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from("bounded-ci-image"),
]);

describe("GitHub emulator example", () => {
  test("verifies one bound target and writes native evidence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-ci-emulator-"));
    const calls: string[][] = [];
    try {
      const result = await verifyEmulator({
        env: {
          ADB_READY_TARGET_SERIAL: "emulator-5554",
          ANDROID_SERIAL: "emulator-5554",
          ADB_READY_VERIFIER_OUTPUT_DIR: directory,
        },
        runAdb: async (args) => {
          calls.push(args);
          const command = args.join(" ");
          if (command === "get-state") return Buffer.from("device\n");
          if (command.endsWith("getprop sys.boot_completed")) return Buffer.from("1\n");
          if (command.endsWith("getprop ro.build.version.sdk")) return Buffer.from("35\n");
          if (command.endsWith("getprop ro.product.cpu.abi")) return Buffer.from("x86_64\n");
          if (command === "exec-out screencap -p") return png;
          return Buffer.from("observed window state\n");
        },
      });

      expect(result).toEqual({ apiLevel: "35", abi: "x86_64", screenshotBytes: png.length });
      expect(calls).toContainEqual([
        "shell",
        "am",
        "start",
        "-W",
        "-a",
        "android.settings.SETTINGS",
      ]);
      expect(await readFile(path.join(directory, "screen.png"))).toEqual(png);
      expect(await readFile(path.join(directory, "window.txt"), "utf8")).toContain(
        "observed window state",
      );
      expect(JSON.parse(await readFile(path.join(directory, "verification.json"), "utf8"))).toEqual(
        {
          schemaVersion: 1,
          targetBound: true,
          state: "device",
          bootCompleted: true,
          apiLevel: "35",
          abi: "x86_64",
          screenshot: "screen.png",
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails before ADB when the verifier target is not the leased target", async () => {
    let called = false;
    await expect(
      verifyEmulator({
        env: {
          ADB_READY_TARGET_SERIAL: "emulator-5554",
          ANDROID_SERIAL: "emulator-5556",
          ADB_READY_VERIFIER_OUTPUT_DIR: "/tmp/evidence",
        },
        runAdb: async () => {
          called = true;
          return Buffer.alloc(0);
        },
      }),
    ).rejects.toThrow("did not bind the verifier to one target");
    expect(called).toBeFalse();
  });

  test("keeps every external Action immutable and failure evidence upload unconditional", async () => {
    const workflow = await readFile(
      path.join(root, ".github", "workflows", "android-emulator.yml"),
      "utf8",
    );
    const actionReferences = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gmu)].map(
      ([, reference]) => reference,
    );

    expect(actionReferences.length).toBeGreaterThanOrEqual(5);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/@[0-9a-f]{40}$/u);
    }
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("include-hidden-files: true");
    expect(workflow).toContain("script: >-");
    expect(workflow).not.toContain("node dist/cli.js run \\");
    expect(workflow).toContain("--device emulator-5554");
    expect(workflow).toContain("--non-interactive");
  });
});
