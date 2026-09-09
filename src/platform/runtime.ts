import process from "node:process";

export type RuntimeName = "bun" | "deno" | "node" | "unknown";

export interface RuntimeInfo {
  name: RuntimeName;
  version: string;
  nodeCompatibilityVersion?: string;
  platform: NodeJS.Platform;
  architecture: string;
}

export function detectRuntime(): RuntimeInfo {
  const versions = process.versions as Record<string, string | undefined>;

  if (versions.bun !== undefined) {
    return {
      name: "bun",
      version: versions.bun,
      ...(versions.node === undefined ? {} : { nodeCompatibilityVersion: versions.node }),
      platform: process.platform,
      architecture: process.arch,
    };
  }

  if (versions.deno !== undefined) {
    return {
      name: "deno",
      version: versions.deno,
      ...(versions.node === undefined ? {} : { nodeCompatibilityVersion: versions.node }),
      platform: process.platform,
      architecture: process.arch,
    };
  }

  if (versions.node !== undefined) {
    return {
      name: "node",
      version: versions.node,
      platform: process.platform,
      architecture: process.arch,
    };
  }

  return {
    name: "unknown",
    version: "unknown",
    platform: process.platform,
    architecture: process.arch,
  };
}
