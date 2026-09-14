const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_URL_LENGTH = 8 * 1024;

export type ExpoRuntime = "custom" | "expo";

export interface ExpoLaunchTarget {
  url: string;
  runtime: ExpoRuntime;
  source: "link" | "open";
  applicationId?: string;
}

export type ExpoLaunchResolution =
  | { status: "aborted" }
  | { status: "resolved"; target: ExpoLaunchTarget }
  | { status: "unavailable"; detail: string };

interface ExpoResponse {
  status: number;
  body: string;
  location?: string;
}

export interface ResolveExpoLaunchOptions {
  endpoint: string;
  runtime: ExpoRuntime;
  devicePort: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  request?: (url: string, signal: AbortSignal) => Promise<ExpoResponse>;
}

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function validApplicationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u.test(value);
}

function parseLaunchUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (!/^[a-z][a-z0-9+.-]*:$/iu.test(parsed.protocol)) return undefined;
    if (
      new Set(["content:", "data:", "file:", "intent:", "javascript:"]).has(
        parsed.protocol.toLowerCase(),
      )
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function isLocalNetworkHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    isPrivateIpv4(normalized)
  );
}

function routeThroughReverse(url: URL, devicePort: number): URL {
  const nested = url.searchParams.get("url");
  if (nested !== null) {
    const parsedNested = parseLaunchUrl(nested);
    if (parsedNested !== undefined && isLocalNetworkHost(parsedNested.hostname)) {
      parsedNested.hostname = "127.0.0.1";
      parsedNested.port = String(devicePort);
      url.searchParams.set("url", parsedNested.toString());
    }
    return url;
  }
  if (isLocalNetworkHost(url.hostname)) {
    url.hostname = "127.0.0.1";
    url.port = String(devicePort);
  }
  return url;
}

async function boundedBody(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new RangeError("Expo response is too large");
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The bounded response is already complete; cancellation is best effort.
    }
  }
}

async function requestExpo(url: string, signal: AbortSignal): Promise<ExpoResponse> {
  const response = await fetch(url, {
    signal,
    redirect: "manual",
    headers: { accept: "application/json", "expo-platform": "android" },
  });
  const location = response.headers.get("location") ?? undefined;
  return {
    status: response.status,
    body: await boundedBody(response),
    ...(location === undefined ? {} : { location }),
  };
}

function parseOpenResponse(
  response: ExpoResponse,
  requestedRuntime: ExpoRuntime,
  devicePort: number,
): ExpoLaunchTarget | undefined {
  if (response.status !== 200) return undefined;
  let document: unknown;
  try {
    document = JSON.parse(response.body);
  } catch {
    return undefined;
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return undefined;
  }
  const record = document as Record<string, unknown>;
  const runtime = record.runtime;
  if (runtime !== requestedRuntime) return undefined;
  const parsedUrl = parseLaunchUrl(record.url);
  if (parsedUrl === undefined) return undefined;
  const applicationId = record.appId;
  return {
    url: routeThroughReverse(parsedUrl, devicePort).toString(),
    runtime: requestedRuntime,
    source: "open",
    ...(validApplicationId(applicationId) ? { applicationId } : {}),
  };
}

function parseLegacyResponse(
  response: ExpoResponse,
  runtime: ExpoRuntime,
  devicePort: number,
): ExpoLaunchTarget | undefined {
  if (response.status !== 307) return undefined;
  const parsedUrl = parseLaunchUrl(response.location);
  return parsedUrl === undefined
    ? undefined
    : {
        url: routeThroughReverse(parsedUrl, devicePort).toString(),
        runtime,
        source: "link",
      };
}

export async function resolveExpoLaunch(
  options: ResolveExpoLaunchOptions,
): Promise<ExpoLaunchResolution> {
  if (
    !Number.isSafeInteger(options.devicePort) ||
    options.devicePort < 1 ||
    options.devicePort > 65_535
  ) {
    throw new RangeError("Expo devicePort must be an integer from 1 through 65535");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("Expo launch timeoutMs must be a positive integer");
  }
  if (aborted(options.signal)) return { status: "aborted" };

  const endpoint = new URL(options.endpoint);
  const request = options.request ?? requestExpo;
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Expo launch request timed out")),
    timeoutMs,
  );
  try {
    const openUrl = new URL("/_expo/open", endpoint);
    openUrl.searchParams.set("platform", "android");
    openUrl.searchParams.set("runtime", options.runtime);
    try {
      const response = await request(openUrl.toString(), controller.signal);
      const target = parseOpenResponse(response, options.runtime, options.devicePort);
      if (target !== undefined) return { status: "resolved", target };
    } catch {
      if (aborted(options.signal)) return { status: "aborted" };
    }

    const legacyUrl = new URL("/_expo/link", endpoint);
    legacyUrl.searchParams.set("platform", "android");
    if (options.runtime === "custom") legacyUrl.searchParams.set("choice", "expo-dev-client");
    try {
      const response = await request(legacyUrl.toString(), controller.signal);
      const target = parseLegacyResponse(response, options.runtime, options.devicePort);
      if (target !== undefined) return { status: "resolved", target };
    } catch {
      if (aborted(options.signal)) return { status: "aborted" };
    }

    return {
      status: "unavailable",
      detail:
        "Metro did not provide a valid Android launch URL through /_expo/open or the compatible /_expo/link endpoint.",
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
