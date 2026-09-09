export type ConfigSource = "cli" | "default" | "environment" | "project" | "user";

export interface ConfigProvenance {
  source: ConfigSource;
  location?: string;
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
  provenance: Record<ConfigKey, ConfigProvenance | undefined>;
  files: {
    user?: string;
    project?: string;
  };
}

export type ConfigLoadResult =
  | { ok: true; config: LoadedConfig }
  | { ok: false; errors: ConfigError[] };
