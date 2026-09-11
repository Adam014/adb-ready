export type ConfigSource = "cli" | "default" | "environment" | "profile" | "project" | "user";

export interface ConfigProvenance {
  source: ConfigSource;
  location?: string;
}

export type ConfigDevPreset = "custom" | "expo" | "gradle" | "react-native";
export type ConfigPackageManager = "bun" | "npm" | "pnpm" | "yarn";

export interface ConfigDevCommand {
  executable: string;
  args: string[];
  cwd?: string;
}

export interface ConfigDevPort {
  device: number;
  host?: number;
}

export type ConfigHookEvent =
  | "beforeDev"
  | "finally"
  | "onChildExit"
  | "onPortsReady"
  | "onReady"
  | "onTargetReady";

export interface ConfigDevHook {
  run: [string, ...string[]];
  timeoutMs?: number;
  failure?: "fail" | "ignore" | "warn";
  cwd?: string;
  envAllowlist?: string[];
}

export interface ConfigValues {
  adbPath?: string;
  adbHost?: string;
  adbPort?: number;
  timeoutMs?: number;
  color?: boolean;
  unicode?: boolean;
  animation?: boolean;
  interactive?: boolean;
  targetAliases?: Record<string, string>;
  appPackage?: string;
  devPreset?: ConfigDevPreset;
  packageManager?: ConfigPackageManager;
  devCommand?: ConfigDevCommand;
  devReversePorts?: ConfigDevPort[];
  devLogs?: boolean;
  devCleanupPorts?: boolean;
  devWatch?: boolean;
  devReadiness?: {
    all: ReadinessAssertion[];
    timeoutMs?: number;
    pollIntervalMs?: number;
  };
  recoveryMaxAttempts?: number;
  recoveryInitialDelayMs?: number;
  recoveryMaxDelayMs?: number;
  recoveryTotalTimeoutMs?: number;
  sessionPersist?: boolean;
  sessionMaxSessions?: number;
  sessionMaxAgeDays?: number;
  sessionMaxBytes?: number;
  journalMaxEntries?: number;
  journalMaxBytes?: number;
  journalSources?: string[];
  journalMinimumSeverity?: "debug" | "error" | "info" | "warning";
  journalRedactEnvironment?: string[];
  devHooks?: Partial<Record<ConfigHookEvent, ConfigDevHook[]>>;
}

export interface ResolvedConfig extends ConfigValues {
  timeoutMs: number;
}

export type ConfigKey = keyof ConfigValues;

export interface ConfigError {
  code: "CONFIG_INVALID_JSON" | "CONFIG_INVALID_VALUE" | "CONFIG_NOT_FOUND";
  path: string;
  message: string;
  source: Exclude<ConfigSource, "default">;
  location?: string;
}

export interface LoadedConfig {
  values: ResolvedConfig;
  provenance: Partial<Record<ConfigKey, ConfigProvenance | undefined>>;
  profile?: {
    name: string;
    source: "project" | "user";
    chain: string[];
  };
  files: {
    user?: string;
    project?: string;
  };
}

export type ConfigLoadResult =
  | { ok: true; config: LoadedConfig }
  | { ok: false; errors: ConfigError[] };

import type { ReadinessAssertion } from "../automation/readiness.js";
