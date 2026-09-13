import path from "node:path";
import { parseProjectEnv } from "@expo/env";

const PUBLIC_PREFIX = "EXPO_PUBLIC_";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TCP_URL_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

export interface DiscoveredLocalService {
  devicePort: number;
  hostPort: number;
  variables: string[];
  environmentFiles: string[];
}

export interface LocalServiceDiscoveryOptions {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
}

export interface LocalServiceDiscoveryDependencies {
  parseProjectEnvironment?: typeof parseProjectEnv;
}

export class ExpoEnvironmentDiscoveryError extends Error {
  override readonly name = "ExpoEnvironmentDiscoveryError";
}

function enabled(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function explicitLoopbackPort(value: string): number | undefined {
  try {
    const url = new URL(value);
    if (!TCP_URL_PROTOCOLS.has(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) return undefined;
    if (url.port === "") return undefined;
    const port = Number(url.port);
    return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detects only explicitly public Expo values that point at a loopback TCP URL.
 * Values are intentionally discarded; results retain only names, ports, and
 * non-sensitive loaded environment-file basenames.
 */
export function discoverExpoLocalServices(
  options: LocalServiceDiscoveryOptions,
  dependencies: LocalServiceDiscoveryDependencies = {},
): DiscoveredLocalService[] {
  const systemEnv = options.env ?? process.env;
  const dotenvDisabled = enabled(systemEnv.EXPO_NO_DOTENV);
  let parsed: ReturnType<typeof parseProjectEnv> = {
    env: {},
    files: [],
    sensitiveLoadedKeys: [],
  };
  if (!dotenvDisabled) {
    try {
      parsed = (dependencies.parseProjectEnvironment ?? parseProjectEnv)(options.projectRoot, {
        mode: "development",
        silent: true,
        systemEnv,
      });
    } catch {
      throw new ExpoEnvironmentDiscoveryError(
        "Expo environment files could not be resolved safely.",
      );
    }
  }

  const publicValues = new Map<string, string>();
  for (const [name, value] of Object.entries(parsed.env)) {
    if (name.startsWith(PUBLIC_PREFIX) && typeof value === "string") publicValues.set(name, value);
  }
  for (const [name, value] of Object.entries(systemEnv)) {
    if (name.startsWith(PUBLIC_PREFIX) && typeof value === "string") publicValues.set(name, value);
  }

  const environmentFiles = parsed.files.map((file) => path.basename(file));
  const byPort = new Map<number, DiscoveredLocalService>();
  for (const [name, value] of [...publicValues].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const port = explicitLoopbackPort(value);
    if (port === undefined) continue;
    const existing = byPort.get(port);
    if (existing === undefined) {
      byPort.set(port, {
        devicePort: port,
        hostPort: port,
        variables: [name],
        environmentFiles,
      });
    } else {
      existing.variables.push(name);
    }
  }
  return [...byPort.values()].sort((left, right) => left.devicePort - right.devicePort);
}
