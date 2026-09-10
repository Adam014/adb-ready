import type { AndroidPackage } from "../adb/parsers.js";

export interface AndroidPackageInfo {
  applicationId: string;
  installed: boolean;
  sourcePath?: string;
  versionName?: string;
  versionCode?: number;
  minSdk?: number;
  targetSdk?: number;
  debuggable?: boolean;
  firstInstallTime?: string;
  lastUpdateTime?: string;
}

export interface ForegroundActivity {
  applicationId: string;
  activity: string;
}

export function parsePackageList(output: string): AndroidPackage[] {
  const packages: AndroidPackage[] = [];
  const seen = new Set<string>();
  for (const line of output.replaceAll("\r\n", "\n").split("\n")) {
    const match = line
      .trim()
      .match(/^package:(?:(\S+)=)?([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)/u);
    const name = match?.[2];
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    packages.push({ name, ...(match?.[1] === undefined ? {} : { sourcePath: match[1] }) });
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

export function parseResolvedActivity(output: string): ForegroundActivity | undefined {
  const lines = output
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines.reverse()) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/(\S+)$/u);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { applicationId: match[1], activity: match[2] };
    }
  }
  return undefined;
}

export function parseForegroundActivity(output: string): ForegroundActivity | undefined {
  const patterns = [
    /\bmResumedActivity:\s+ActivityRecord\{[^}]*\s([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/(\S+?)(?:\s|\})/u,
    /\btopResumedActivity=ActivityRecord\{[^}]*\s([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/(\S+?)(?:\s|\})/u,
  ];
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { applicationId: match[1], activity: match[2] };
    }
  }
  return undefined;
}

export function parsePackageInfo(applicationId: string, output: string): AndroidPackageInfo {
  const sourcePath = output.match(/\bcodePath=([^\s]+)/u)?.[1];
  const versionName = output.match(/\bversionName=([^\s]+)/u)?.[1];
  const versionCodeText = output.match(/\bversionCode=(\d+)/u)?.[1];
  const minSdkText = output.match(/\bminSdk=(\d+)/u)?.[1];
  const targetSdkText = output.match(/\btargetSdk=(\d+)/u)?.[1];
  const flags = output.match(/\bflags=\[([^\]]*)\]/u)?.[1]?.split(/\s+/u) ?? [];
  const pkgFlags = output.match(/\bpkgFlags=\[([^\]]*)\]/u)?.[1]?.split(/\s+/u) ?? [];
  const firstInstallTime = output.match(/\bfirstInstallTime=([^\n\r]+)/u)?.[1]?.trim();
  const lastUpdateTime = output.match(/\blastUpdateTime=([^\n\r]+)/u)?.[1]?.trim();
  const installed = output.includes(`Package [${applicationId}]`) || sourcePath !== undefined;
  return {
    applicationId,
    installed,
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(versionName === undefined ? {} : { versionName }),
    ...(versionCodeText === undefined ? {} : { versionCode: Number(versionCodeText) }),
    ...(minSdkText === undefined ? {} : { minSdk: Number(minSdkText) }),
    ...(targetSdkText === undefined ? {} : { targetSdk: Number(targetSdkText) }),
    ...(flags.length === 0 && pkgFlags.length === 0
      ? {}
      : { debuggable: [...flags, ...pkgFlags].includes("DEBUGGABLE") }),
    ...(firstInstallTime === undefined ? {} : { firstInstallTime }),
    ...(lastUpdateTime === undefined ? {} : { lastUpdateTime }),
  };
}
