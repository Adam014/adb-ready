import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EvidencePathError, prepareEvidenceDestination } from "../../src/evidence/files.js";

describe("evidence output paths", () => {
  test("accepts a new relative output inside the project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-evidence-"));
    try {
      const destination = await prepareEvidenceDestination({
        root,
        requested: "artifacts/screen.png",
        defaultName: "unused.png",
        nonce: "fixture",
      });
      expect(destination.relativePath).toBe("artifacts/screen.png");
      expect(destination.finalPath.startsWith(destination.root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects traversal, absolute paths, and silent overwrite", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-evidence-"));
    await writeFile(path.join(root, "exists.png"), "old");
    try {
      for (const requested of ["../outside.png", path.resolve(root, "absolute.png")]) {
        await expect(
          prepareEvidenceDestination({
            root,
            requested,
            defaultName: "unused.png",
            nonce: "fixture",
          }),
        ).rejects.toBeInstanceOf(EvidencePathError);
      }
      await expect(
        prepareEvidenceDestination({
          root,
          requested: "exists.png",
          defaultName: "unused.png",
          nonce: "fixture",
        }),
      ).rejects.toMatchObject({ code: "EXISTS" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not follow a symlinked output parent", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-evidence-"));
    const outside = await mkdtemp(path.join(tmpdir(), "adb-ready-outside-"));
    await symlink(outside, path.join(root, "linked"));
    try {
      await expect(
        prepareEvidenceDestination({
          root,
          requested: "linked/screen.png",
          defaultName: "unused.png",
          nonce: "fixture",
        }),
      ).rejects.toMatchObject({ code: "SYMLINK" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
