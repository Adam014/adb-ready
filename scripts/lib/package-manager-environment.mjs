const AUTH_ENVIRONMENT_KEYS = new Set([
  "COREPACK_NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_AUTH_TOKEN",
  "NPM_TOKEN",
  "YARN_NPM_AUTH_TOKEN",
]);

/**
 * Give package-consumer smoke tests their own public-registry configuration.
 * Publishing credentials and setup-node's publish-only user config must never
 * cross into package-manager compatibility tests.
 *
 * @param {NodeJS.ProcessEnv} source
 * @param {string} userConfig
 * @returns {NodeJS.ProcessEnv}
 */
export function createPackageConsumerEnvironment(source, userConfig) {
  if (userConfig.trim().length === 0) {
    throw new Error("package consumer npm user config path cannot be empty");
  }

  /** @type {NodeJS.ProcessEnv} */
  const environment = {};
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toUpperCase();
    if (
      normalized === "NPM_CONFIG_USERCONFIG" ||
      AUTH_ENVIRONMENT_KEYS.has(normalized) ||
      (normalized.startsWith("NPM_CONFIG_") && normalized.includes("AUTH"))
    ) {
      continue;
    }
    environment[key] = value;
  }
  environment.NPM_CONFIG_USERCONFIG = userConfig;
  return environment;
}
