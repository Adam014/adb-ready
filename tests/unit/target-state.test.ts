import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  adbServerScope,
  defaultTargetStatePath,
  readTargetState,
  rememberedTarget,
  writeRememberedTarget,
} from "../../src/state/target-state.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryStatePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "adb-ready-state-"));
  directories.push(directory);
  return path.join(directory, "nested", "state.json");
}

describe("target state", () => {
  test("uses non-project per-user state locations on every public platform", () => {
    expect(defaultTargetStatePath("linux", {}, "/home/dev")).toBe(
      "/home/dev/.local/state/adb-ready/state.json",
    );
    expect(defaultTargetStatePath("darwin", {}, "/Users/dev")).toBe(
      "/Users/dev/Library/Application Support/adb-ready/state.json",
    );
    expect(
      defaultTargetStatePath(
        "win32",
        { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
        "C:\\Users\\dev",
      ),
    ).toBe("C:\\Users\\dev\\AppData\\Local\\adb-ready\\state.json");
  });

  test("writes atomically and scopes remembered targets per ADB server", async () => {
    const statePath = await temporaryStatePath();
    await expect(
      writeRememberedTarget(
        { serial: "USB-1", updatedAt: "2026-09-09T10:00:00.000Z" },
        { statePath },
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      writeRememberedTarget(
        {
          serial: "192.168.1.20:37123",
          hardwareSerial: "PHONE-1",
          updatedAt: "2026-09-09T11:00:00.000Z",
        },
        { statePath, adbHost: "lab-host", adbPort: 5038 },
      ),
    ).resolves.toMatchObject({ ok: true });

    const state = await readTargetState({ statePath });
    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(rememberedTarget(state.document, {})).toMatchObject({ serial: "USB-1" });
      expect(
        rememberedTarget(state.document, { adbHost: "LAB-HOST", adbPort: 5038 }),
      ).toMatchObject({ serial: "192.168.1.20:37123", hardwareSerial: "PHONE-1" });
    }
    expect(adbServerScope({ adbHost: "LAB-HOST", adbPort: 5038 })).toBe("remote:lab-host:5038");
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ version: 1 });
  });

  test("does not overwrite malformed state", async () => {
    const statePath = await temporaryStatePath();
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, "not-json\n");

    const result = await writeRememberedTarget({ serial: "USB-1" }, { statePath });

    expect(result).toMatchObject({ ok: false, code: "STATE_INVALID" });
    expect(await readFile(statePath, "utf8")).toBe("not-json\n");
  });
});
