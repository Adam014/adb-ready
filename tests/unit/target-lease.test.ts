import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireTargetLease, defaultTargetLeaseDirectory } from "../../src/state/target-lease.js";

describe("target leases", () => {
  test("uses per-user platform state locations", () => {
    expect(defaultTargetLeaseDirectory("linux", { XDG_STATE_HOME: "/state" }, "/home/dev")).toBe(
      "/state/adb-ready/leases",
    );
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

  test("validates bounded lease and heartbeat durations", async () => {
    const request = { targetIdentity: "phone-1", projectRoot: "/project", purpose: "dev" };
    await expect(acquireTargetLease(request, { ttlMs: 999 })).rejects.toThrow(
      "ttlMs must be at least 1000",
    );
    await expect(
      acquireTargetLease(request, { ttlMs: 1_000, heartbeatIntervalMs: 1_000 }),
    ).rejects.toThrow("heartbeatIntervalMs must be non-negative and less than ttlMs");
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

  test("heartbeats an owned lease and makes repeated release idempotent", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-lease-"));
    try {
      let tick = 0;
      const lease = await acquireTargetLease(
        { targetIdentity: "phone-heartbeat", projectRoot: "/project", purpose: "dev" },
        {
          directory,
          ttlMs: 1_000,
          heartbeatIntervalMs: 5,
          clock: () => new Date(1_000 + tick++ * 100),
        },
      );
      expect(lease.ok).toBeTrue();
      if (!lease.ok) return;
      const acquiredAt = lease.lease.owner.updatedAt;
      const deadline = Date.now() + 1_000;
      while (lease.lease.owner.updatedAt === acquiredAt && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(Date.parse(lease.lease.owner.updatedAt)).toBeGreaterThan(Date.parse(acquiredAt));
      expect(await lease.lease.release()).toBeTrue();
      expect(await lease.lease.release()).toBeTrue();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("never releases a lease whose owner file changed", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-lease-"));
    try {
      const lease = await acquireTargetLease(
        { targetIdentity: "phone-changed", projectRoot: "/project", purpose: "dev" },
        { directory, heartbeatIntervalMs: 0 },
      );
      expect(lease.ok).toBeTrue();
      if (!lease.ok) return;
      const targetDirectory = path.join(
        directory,
        `sha256-${createHash("sha256").update("phone-changed").digest("hex").slice(0, 24)}`,
      );
      await writeFile(path.join(targetDirectory, "owner.json"), "{}\n");
      expect(await lease.lease.release()).toBeFalse();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("recovers a local lease whose owning process is gone", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-lease-"));
    try {
      const options = {
        directory,
        ttlMs: 60_000,
        heartbeatIntervalMs: 0,
        hostname: "test-host",
        clock: () => new Date("2026-09-11T10:00:00.000Z"),
      };
      const stale = await acquireTargetLease(
        { targetIdentity: "phone-dead", projectRoot: "/project/a", purpose: "dev" },
        { ...options, pid: 999 },
      );
      expect(stale.ok).toBeTrue();
      const recovered = await acquireTargetLease(
        { targetIdentity: "phone-dead", projectRoot: "/project/b", purpose: "run" },
        { ...options, processAlive: () => false },
      );
      expect(recovered.ok).toBeTrue();
      if (recovered.ok) await recovered.lease.release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports a fresh ownerless acquisition directory as busy", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-lease-"));
    try {
      const identity = "phone-acquiring";
      const targetDirectory = path.join(
        directory,
        `sha256-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`,
      );
      await mkdir(targetDirectory);
      const result = await acquireTargetLease(
        { targetIdentity: identity, projectRoot: "/project", purpose: "dev" },
        { directory, ttlMs: 60_000, heartbeatIntervalMs: 0 },
      );
      expect(result).toMatchObject({
        ok: false,
        code: "TARGET_BUSY",
        message: "The selected Android target is being acquired by another process.",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
