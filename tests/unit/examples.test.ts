import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config/loader.js";

const examples = fileURLToPath(new URL("../../examples", import.meta.url));
const cases = [
  ["expo", "expo"],
  ["react-native", "react-native"],
  ["gradle", "gradle"],
  ["custom", "custom"],
] as const;

describe("public configuration examples", () => {
  for (const [directory, expectedPreset] of cases) {
    test(`${directory} is valid and resolves its intended preset`, async () => {
      const projectConfigPath = path.join(examples, directory, "adb-ready.config.json");
      const contents = await readFile(projectConfigPath, "utf8");
      expect(() => JSON.parse(contents)).not.toThrow();

      const result = await loadConfig({
        cwd: path.dirname(projectConfigPath),
        env: {},
        homeDirectory: examples,
        userConfigPath: path.join(examples, "missing-user-config.json"),
        projectConfigPath,
        explicitProjectConfig: true,
      });

      expect(result).toMatchObject({
        ok: true,
        config: { values: { devPreset: expectedPreset } },
      });
    });
  }
});
