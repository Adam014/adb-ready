import { connect } from "node:net";

const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const MAX_STATUS_BYTES = 128;
const METRO_STATUS = "packager-status:running";

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
  signal?: AbortSignal;
  timeoutMs?: number;
  connectPort?: (host: string, port: number, signal: AbortSignal) => Promise<boolean>;
  fetchStatus?: (url: string, signal: AbortSignal) => Promise<{ status: number; body: string }>;
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
    await reader.cancel().catch(() => undefined);
  }
}

async function fetchStatus(
  url: string,
  signal: AbortSignal,
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    signal,
    redirect: "error",
    headers: { accept: "text/plain" },
  });
  return { status: response.status, body: await boundedResponse(response) };
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
      if (response.status === 200 && response.body.trim() === METRO_STATUS) {
        return { status: "available", endpoint };
      }
      return {
        status: "occupied",
        endpoint,
        detail:
          response.status !== 200
            ? `The Metro status endpoint returned HTTP ${String(response.status)}.`
            : "The service did not return Metro's running status.",
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
