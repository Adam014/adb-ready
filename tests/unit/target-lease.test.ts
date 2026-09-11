import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireTargetLease, defaultTargetLeaseDirectory } from "../../src/state/target-lease.js";

describe("target leases", () => {
  test("uses per-user platform state locations", () => {
    expect(defaultTargetLeaseDirectory("linux", {}, "/home/dev")).toBe(
      "/home/dev/.local/state/adb-ready/leases",
    );
    expect(defaultTargetLeaseDirectory("darwin", {}, "/Users/dev")).toBe(
      "/Users/dev/Library/Application Support/adb-ready/leases",
    );
    expect(
      defaultTargetLeaseDirectory(
        "win32",
        { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
        "C:\\Users\\dev",
      ),
    ).toBe("C:\\Users\\dev\\AppData\\Local\\adb-ready\\leases");
  });

  test("prevents concurrent ownership and releases only its own lease", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-lease-"));
    try {
      const first = await acquireTargetLease(
        { targetIdentity: "phone-1", projectRoot: "/project/a", purpose: "dev" },
        { directory, heartbeatIntervalMs: 0 },
      );
      expect(first.ok).toBeTrue();
      const second = await acquireTargetLease(
        { targetIdentity: "phone-1", projectRoot: "/project/b", purpose: "ui tap" },
        { directory, heartbeatIntervalMs: 0 },
      );
      expect(second).toMatchObject({ ok: false, code: "TARGET_BUSY" });
      if (!first.ok) return;
      expect(await first.lease.release()).toBeTrue();
      const third = await acquireTargetLease(
        { targetIdentity: "phone-1", projectRoot: "/project/b", purpose: "ui tap" },
        { directory, heartbeatIntervalMs: 0 },
      );
      expect(third.ok).toBeTrue();
      if (third.ok) expect(await third.lease.release()).toBeTrue();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("recovers an expired lease without touching another target", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-lease-"));
    try {
      let now = new Date("2026-09-11T10:00:00.000Z");
      const stale = await acquireTargetLease(
        { targetIdentity: "phone-stale", projectRoot: "/project/a", purpose: "dev" },
        { directory, ttlMs: 1_000, heartbeatIntervalMs: 0, clock: () => now },
      );
      const other = await acquireTargetLease(
        { targetIdentity: "phone-other", projectRoot: "/project/a", purpose: "dev" },
        { directory, ttlMs: 60_000, heartbeatIntervalMs: 0, clock: () => now },
      );
      expect(stale.ok).toBeTrue();
      expect(other.ok).toBeTrue();
      now = new Date("2026-09-11T10:00:02.000Z");
      const recovered = await acquireTargetLease(
        { targetIdentity: "phone-stale", projectRoot: "/project/b", purpose: "run" },
        { directory, ttlMs: 1_000, heartbeatIntervalMs: 0, clock: () => now },
      );
      expect(recovered.ok).toBeTrue();
      const blockedOther = await acquireTargetLease(
        { targetIdentity: "phone-other", projectRoot: "/project/b", purpose: "run" },
        { directory, ttlMs: 60_000, heartbeatIntervalMs: 0, clock: () => now },
      );
      expect(blockedOther).toMatchObject({ ok: false, code: "TARGET_BUSY" });
      if (recovered.ok) await recovered.lease.release();
      if (other.ok) await other.lease.release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
