import { createConnection } from "node:net";

export type RemoteAdbServerProbeResult =
  | { ok: true; protocolVersion: number }
  | {
      ok: false;
      kind:
        | "cancelled"
        | "invalid-response"
        | "protocol-mismatch"
        | "rejected"
        | "timeout"
        | "unreachable";
      message: string;
      expectedProtocolVersion?: number;
      actualProtocolVersion?: number;
      networkCode?: string;
    };

export interface RemoteAdbServerProbeOptions {
  host: string;
  port: number;
  expectedProtocolVersion: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type RemoteAdbServerProbe = (
  options: RemoteAdbServerProbeOptions,
) => Promise<RemoteAdbServerProbeResult>;

const REQUEST = "000chost:version";
const MAX_RESPONSE_BYTES = 4_096;

function normalizedSocketHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function protocolFrame(
  buffer: Buffer,
):
  | { kind: "incomplete" }
  | { kind: "invalid"; message: string }
  | { kind: "okay"; payload: string }
  | { kind: "rejected"; message: string } {
  if (buffer.length < 4) return { kind: "incomplete" };
  const status = buffer.subarray(0, 4).toString("ascii");
  if (status !== "OKAY" && status !== "FAIL") {
    return { kind: "invalid", message: "The server returned an unknown ADB status." };
  }
  if (buffer.length < 8) return { kind: "incomplete" };
  const lengthText = buffer.subarray(4, 8).toString("ascii");
  if (!/^[0-9a-fA-F]{4}$/u.test(lengthText)) {
    return { kind: "invalid", message: "The server returned an invalid ADB payload length." };
  }
  const length = Number.parseInt(lengthText, 16);
  if (length > MAX_RESPONSE_BYTES) {
    return { kind: "invalid", message: "The server returned an oversized ADB payload." };
  }
  if (buffer.length < 8 + length) return { kind: "incomplete" };
  const payload = buffer.subarray(8, 8 + length).toString("utf8");
  return status === "OKAY"
    ? { kind: "okay", payload }
    : { kind: "rejected", message: payload || "The server rejected host:version." };
}

export function adbProtocolVersion(value: string | undefined): number | undefined {
  const match = value?.match(/^1\.0\.(\d+)$/u);
  if (match?.[1] === undefined) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0xffff ? parsed : undefined;
}

export const probeRemoteAdbServer: RemoteAdbServerProbe = async (options) => {
  if (options.host.trim() === "") throw new RangeError("remote ADB host cannot be empty");
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new RangeError("remote ADB port must be from 1 to 65535");
  }
  if (
    !Number.isSafeInteger(options.expectedProtocolVersion) ||
    options.expectedProtocolVersion < 0 ||
    options.expectedProtocolVersion > 0xffff
  ) {
    throw new RangeError("expected ADB protocol version must be from 0 to 65535");
  }
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 60_000
  ) {
    throw new RangeError("remote ADB probe timeout must be from 1 to 60000");
  }
  if (options.signal?.aborted === true) {
    return { ok: false, kind: "cancelled", message: "Remote ADB preflight was cancelled." };
  }

  return await new Promise<RemoteAdbServerProbeResult>((resolve) => {
    const socket = createConnection({
      host: normalizedSocketHost(options.host),
      port: options.port,
    });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (result: RemoteAdbServerProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      socket.destroy();
      resolve(result);
    };
    const abort = (): void =>
      finish({ ok: false, kind: "cancelled", message: "Remote ADB preflight was cancelled." });
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          kind: "timeout",
          message: "The configured ADB server did not answer the safety preflight in time.",
        }),
      options.timeoutMs,
    );

    options.signal?.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => socket.write(REQUEST, "ascii"));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_RESPONSE_BYTES + 8) {
        finish({
          ok: false,
          kind: "invalid-response",
          message: "The configured endpoint returned an oversized ADB response.",
        });
        return;
      }
      const frame = protocolFrame(buffer);
      if (frame.kind === "incomplete") return;
      if (frame.kind === "invalid") {
        finish({ ok: false, kind: "invalid-response", message: frame.message });
        return;
      }
      if (frame.kind === "rejected") {
        finish({ ok: false, kind: "rejected", message: frame.message });
        return;
      }
      if (!/^[0-9a-fA-F]{4}$/u.test(frame.payload)) {
        finish({
          ok: false,
          kind: "invalid-response",
          message: "The configured endpoint returned an invalid ADB protocol version.",
        });
        return;
      }
      const actualProtocolVersion = Number.parseInt(frame.payload, 16);
      if (actualProtocolVersion !== options.expectedProtocolVersion) {
        finish({
          ok: false,
          kind: "protocol-mismatch",
          message: "The remote ADB server protocol does not match the local ADB client.",
          expectedProtocolVersion: options.expectedProtocolVersion,
          actualProtocolVersion,
        });
        return;
      }
      finish({ ok: true, protocolVersion: actualProtocolVersion });
    });
    socket.once("end", () =>
      finish({
        ok: false,
        kind: "invalid-response",
        message: "The configured endpoint closed before completing the ADB preflight.",
      }),
    );
    socket.once("error", (caught: NodeJS.ErrnoException) =>
      finish({
        ok: false,
        kind: "unreachable",
        message: "The configured ADB server could not be reached.",
        ...(caught.code === undefined ? {} : { networkCode: caught.code }),
      }),
    );
  });
};
