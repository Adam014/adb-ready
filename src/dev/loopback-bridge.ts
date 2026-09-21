import { connect, createServer, type Server, type Socket } from "node:net";

const IPV4_LOOPBACK = "127.0.0.1";
const IPV6_LOOPBACK = "::1";
const DEFAULT_PROBE_TIMEOUT_MS = 750;

export interface LoopbackBridge {
  port: number;
  sourceHost: typeof IPV4_LOOPBACK;
  targetHost: typeof IPV6_LOOPBACK;
  close: () => Promise<void>;
}

export type LoopbackBridgeResult =
  | { status: "bridged"; bridge: LoopbackBridge }
  | { status: "failed"; detail: string }
  | { status: "not-needed" }
  | { status: "unavailable" };

export interface EnsureLoopbackBridgeOptions {
  port: number;
  signal?: AbortSignal;
  connectPort?: (host: string, port: number, signal?: AbortSignal) => Promise<boolean>;
}

async function portReachable(host: string, port: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted === true) return false;
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(false), DEFAULT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function proxyServer(port: number, sockets: Set<Socket>): Server {
  const server = createServer((client) => {
    const upstream = connect({ host: IPV6_LOOPBACK, port });
    sockets.add(client);
    sockets.add(upstream);
    const forgetClient = () => sockets.delete(client);
    const forgetUpstream = () => sockets.delete(upstream);
    client.once("close", forgetClient);
    upstream.once("close", forgetUpstream);
    client.once("error", () => upstream.destroy());
    upstream.once("error", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.on("error", () => {
    for (const socket of sockets) socket.destroy();
  });
  return server;
}

async function listen(
  server: Server,
  port: number,
  signal?: AbortSignal,
): Promise<Error | undefined> {
  return await new Promise<Error | undefined>((resolve) => {
    if (signal?.aborted === true) {
      resolve(new Error("Loopback bridge startup was interrupted"));
      return;
    }

    let settled = false;
    let cancelled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      server.off("error", fail);
      resolve(error);
    };
    const abort = () => {
      cancelled = true;
      try {
        server.close();
      } catch {
        // The server may not have reached its listening state yet.
      }
      finish(new Error("Loopback bridge startup was interrupted"));
    };
    const fail = (error: Error) => finish(error);
    server.once("error", fail);
    signal?.addEventListener("abort", abort, { once: true });
    server.listen({ host: IPV4_LOOPBACK, port, exclusive: true }, () => {
      if (cancelled) {
        try {
          server.close();
        } catch {
          // The abort handler may already have closed the server.
        }
        return;
      }
      finish();
    });
  });
}

export async function ensureLoopbackBridge(
  options: EnsureLoopbackBridgeOptions,
): Promise<LoopbackBridgeResult> {
  const probe = options.connectPort ?? portReachable;
  if (await probe(IPV4_LOOPBACK, options.port, options.signal)) return { status: "not-needed" };
  if (!(await probe(IPV6_LOOPBACK, options.port, options.signal))) return { status: "unavailable" };
  if (options.signal?.aborted === true) {
    return { status: "failed", detail: "Loopback bridge startup was interrupted." };
  }

  const sockets = new Set<Socket>();
  const server = proxyServer(options.port, sockets);
  const error = await listen(server, options.port, options.signal);
  if (error !== undefined) {
    for (const socket of sockets) socket.destroy();
    try {
      server.close();
    } catch {
      // A failed listen can leave the server without an active handle.
    }
    if (await probe(IPV4_LOOPBACK, options.port, options.signal)) return { status: "not-needed" };
    return {
      status: "failed",
      detail: `The IPv4 loopback bridge could not listen on port ${String(options.port)}.`,
    };
  }

  let closed = false;
  return {
    status: "bridged",
    bridge: {
      port: options.port,
      sourceHost: IPV4_LOOPBACK,
      targetHost: IPV6_LOOPBACK,
      close: async () => {
        if (closed) return;
        closed = true;
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    },
  };
}
