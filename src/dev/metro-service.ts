import { realpath } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";

const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const MAX_STATUS_BYTES = 128;
const MAX_PROJECT_ROOT_BYTES = 4_096;
const METRO_STATUS = "packager-status:running";
const METRO_PROJECT_ROOT_HEADER = "x-react-native-project-root";

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export type MetroServiceProbeResult =
  | { status: "available"; endpoint: string }
  | { status: "occupied"; endpoint: string; detail: string }
  | { status: "unavailable"; endpoint: string }
  | { status: "aborted"; endpoint: string };

export interface MetroServiceProbeOptions {
  host: string;
  port: number;
  expectedProjectRoot?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  connectPort?: (host: string, port: number, signal: AbortSignal) => Promise<boolean>;
  fetchStatus?: (
    url: string,
    signal: AbortSignal,
  ) => Promise<{ status: number; body: string; projectRoot?: string }>;
}

async function portReachable(host: string, port: number, signal: AbortSignal): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    const abort = () => finish(false);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function boundedResponse(response: Response): Promise<string> {
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
      if (bytes > MAX_STATUS_BYTES) throw new RangeError("Metro status response is too large");
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The response is already bounded; cancellation is best-effort cleanup.
    }
  }
}

async function fetchStatus(
  url: string,
  signal: AbortSignal,
): Promise<{ status: number; body: string; projectRoot?: string }> {
  const response = await fetch(url, {
    signal,
    redirect: "error",
    headers: { accept: "text/plain" },
  });
  const projectRoot = response.headers.get(METRO_PROJECT_ROOT_HEADER) ?? undefined;
  return {
    status: response.status,
    body: await boundedResponse(response),
    ...(projectRoot === undefined ? {} : { projectRoot }),
  };
}

async function canonicalProjectRoot(value: string): Promise<string | undefined> {
  if (Buffer.byteLength(value, "utf8") > MAX_PROJECT_ROOT_BYTES) return undefined;
  let decoded: string;
  try {
    decoded = decodeURI(value);
  } catch {
    return undefined;
  }
  if (!path.isAbsolute(decoded)) return undefined;
  const resolved = path.resolve(decoded);
  const canonical = await realpath(resolved).catch(() => resolved);
  return process.platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical;
}

async function projectRootMatches(
  observed: string | undefined,
  expected: string,
): Promise<boolean> {
  if (observed === undefined) return false;
  const [observedRoot, expectedRoot] = await Promise.all([
    canonicalProjectRoot(observed),
    canonicalProjectRoot(expected),
  ]);
  return observedRoot !== undefined && expectedRoot !== undefined && observedRoot === expectedRoot;
}

export async function probeMetroService(
  options: MetroServiceProbeOptions,
): Promise<MetroServiceProbeResult> {
  const endpoint = `http://${options.host}:${String(options.port)}`;
  if (aborted(options.signal)) return { status: "aborted", endpoint };
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("Metro probe timeoutMs must be a positive integer");
  }

  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Metro probe timed out")), timeoutMs);
  try {
    const reachable = await (options.connectPort ?? portReachable)(
      options.host,
      options.port,
      controller.signal,
    );
    if (aborted(options.signal)) return { status: "aborted", endpoint };
    if (!reachable) return { status: "unavailable", endpoint };

    try {
      const response = await (options.fetchStatus ?? fetchStatus)(
        `${endpoint}/status`,
        controller.signal,
      );
      const validStatus = response.status === 200 && response.body.trim() === METRO_STATUS;
      if (
        validStatus &&
        (options.expectedProjectRoot === undefined ||
          (await projectRootMatches(response.projectRoot, options.expectedProjectRoot)))
      ) {
        return { status: "available", endpoint };
      }
      return {
        status: "occupied",
        endpoint,
        detail:
          response.status !== 200
            ? `The Metro status endpoint returned HTTP ${String(response.status)}.`
            : response.body.trim() !== METRO_STATUS
              ? "The service did not return Metro's running status."
              : response.projectRoot === undefined
                ? "Metro did not identify its project root, so ADB Ready cannot attach safely."
                : "Metro belongs to a different project root.",
      };
    } catch {
      if (aborted(options.signal)) return { status: "aborted", endpoint };
      return {
        status: "occupied",
        endpoint,
        detail: "The port is open, but its service did not complete the Metro status probe.",
      };
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
