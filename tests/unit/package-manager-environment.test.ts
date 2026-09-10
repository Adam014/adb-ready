import { describe, expect, test } from "bun:test";

import { createPackageConsumerEnvironment } from "../../scripts/lib/package-manager-environment.mjs";

describe("createPackageConsumerEnvironment", () => {
  test("isolates consumer commands from publish credentials and configuration", () => {
    const environment = createPackageConsumerEnvironment(
      {
        PATH: "/tools",
        NODE_AUTH_TOKEN: "node-secret",
        npm_token: "npm-secret",
        npm_config_userconfig: "/publish/.npmrc",
        NPM_CONFIG_ALWAYS_AUTH: "true",
        NPM_CONFIG_REGISTRY: "https://registry.example.test",
        YARN_NPM_AUTH_TOKEN: "yarn-secret",
      },
      "/consumer/.npmrc",
    );

    expect(environment).toEqual({
      PATH: "/tools",
      NPM_CONFIG_USERCONFIG: "/consumer/.npmrc",
      NPM_CONFIG_REGISTRY: "https://registry.example.test",
    });
  });

  test("rejects an empty isolated config path", () => {
    expect(() => createPackageConsumerEnvironment({}, "  ")).toThrow(
      "package consumer npm user config path cannot be empty",
    );
  });
});
