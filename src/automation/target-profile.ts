import type { ProcessResult, ProcessRunner } from "../platform/process-runner.js";
import { runProcess } from "../platform/process-runner.js";

const PROBE_TIMEOUT_MS = 10_000;

export interface AndroidTargetProfile {
  serial: string;
  abis: string[];
  density?: string;
  locales: string[];
}

export interface TargetProfileFailure {
  code: "TARGET_PROFILE_INVALID_INPUT" | "TARGET_PROFILE_UNAVAILABLE";
  summary: string;
  detail: string;
  next: string;
}

export type TargetProfileResult =
  | { ok: true; profile: AndroidTargetProfile }
  | { ok: false; failure: TargetProfileFailure };

export interface InspectTargetProfileOptions {
  adb: string;
  serial: string;
  signal?: AbortSignal;
}

function validValue(value: string): boolean {
  return (
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 4_096 &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
  );
}

function succeeded(result: ProcessResult): boolean {
  return (
    result.spawnError === undefined &&
    result.streamError === undefined &&
    result.exitCode === 0 &&
    !result.timedOut &&
    !result.aborted
  );
}

function detail(result: ProcessResult): string {
  if (result.aborted) return "The target profile probe was cancelled.";
  if (result.timedOut) return "The target profile probe exceeded its bounded timeout.";
  if (result.spawnError !== undefined) return result.spawnError.message;
  if (result.streamError !== undefined) return result.streamError.message;
  return (
    result.stderr.trim() || result.stdout.trim() || `ADB exited with ${String(result.exitCode)}.`
  );
}

async function getprop(
  options: InspectTargetProfileOptions,
  property: string,
  runner: ProcessRunner,
): Promise<ProcessResult> {
  return await runner({
    executable: options.adb,
    args: ["-s", options.serial, "shell", "getprop", property],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs: PROBE_TIMEOUT_MS,
    maxBufferBytes: 64 * 1024,
  });
}

function values(output: string, separator: RegExp): string[] {
  return [
    ...new Set(
      output
        .trim()
        .split(separator)
        .map((value) => value.trim())
        .filter((value) => value !== "" && validValue(value)),
    ),
  ];
}

function densityFrom(output: string): string | undefined {
  const observations = [...output.matchAll(/(?:Physical|Override) density:\s*(\d+)/giu)];
  const selected = observations.at(-1)?.[1];
  if (selected !== undefined) return selected;
  const direct = output.trim();
  return /^\d+$/u.test(direct) ? direct : undefined;
}

function normalizedLocales(output: string): string[] {
  const locales = values(output.replaceAll("_", "-"), /[,\s]+/u);
  return [
    ...new Set(
      locales.flatMap((locale) => {
        const language = locale.split("-")[0];
        return language === undefined || language === locale ? [locale] : [locale, language];
      }),
    ),
  ];
}

export async function inspectAndroidTargetProfile(
  options: InspectTargetProfileOptions,
  runner: ProcessRunner = runProcess,
): Promise<TargetProfileResult> {
  if (!validValue(options.adb) || !validValue(options.serial) || /\s/u.test(options.serial)) {
    return {
      ok: false,
      failure: {
        code: "TARGET_PROFILE_INVALID_INPUT",
        summary: "The target profile input is invalid.",
        detail: "ADB and the selected serial must be explicit printable values.",
        next: "Select one stable Android target before resolving an artifact.",
      },
    };
  }

  const abiList = await getprop(options, "ro.product.cpu.abilist", runner);
  if (!succeeded(abiList)) {
    return {
      ok: false,
      failure: {
        code: "TARGET_PROFILE_UNAVAILABLE",
        summary: "The selected target ABI could not be inspected.",
        detail: detail(abiList),
        next: `Restore ADB access to ${options.serial} before selecting an install artifact.`,
      },
    };
  }
  let abis = values(abiList.stdout, /,/u);
  if (abis.length === 0) {
    const primaryAbi = await getprop(options, "ro.product.cpu.abi", runner);
    if (!succeeded(primaryAbi)) {
      return {
        ok: false,
        failure: {
          code: "TARGET_PROFILE_UNAVAILABLE",
          summary: "The selected target ABI could not be inspected.",
          detail: detail(primaryAbi),
          next: `Restore ADB access to ${options.serial} before selecting an install artifact.`,
        },
      };
    }
    abis = values(primaryAbi.stdout, /,/u);
  }
  if (abis.length === 0) {
    return {
      ok: false,
      failure: {
        code: "TARGET_PROFILE_UNAVAILABLE",
        summary: "The selected target did not report an ABI.",
        detail: "Both ro.product.cpu.abilist and ro.product.cpu.abi were empty.",
        next: "Wait for Android to finish booting, then retry the run.",
      },
    };
  }

  const [density, persistentLocale] = await Promise.all([
    runner({
      executable: options.adb,
      args: ["-s", options.serial, "shell", "wm", "density"],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBufferBytes: 64 * 1024,
    }),
    getprop(options, "persist.sys.locale", runner),
  ]);
  let locales = succeeded(persistentLocale) ? normalizedLocales(persistentLocale.stdout) : [];
  if (locales.length === 0) {
    const productLocale = await getprop(options, "ro.product.locale", runner);
    if (succeeded(productLocale)) locales = normalizedLocales(productLocale.stdout);
  }

  const observedDensity = succeeded(density) ? densityFrom(density.stdout) : undefined;
  return {
    ok: true,
    profile: {
      serial: options.serial,
      abis,
      ...(observedDensity === undefined ? {} : { density: observedDensity }),
      locales,
    },
  };
}
