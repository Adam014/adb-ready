export type ExpoControlAction = "dev-menu" | "reload";

export interface ExpoControlResult {
  action: ExpoControlAction;
  connectedClients: number;
  detail: string;
  ok: boolean;
}

interface SocketEventMap {
  close: { code?: number; reason?: string };
  error: unknown;
  message: { data?: unknown };
  open: unknown;
}

interface ExpoControlSocket {
  addEventListener<K extends keyof SocketEventMap>(
    event: K,
    listener: (value: SocketEventMap[K]) => void,
  ): void;
  close(code?: number, reason?: string): void;
  removeEventListener<K extends keyof SocketEventMap>(
    event: K,
    listener: (value: SocketEventMap[K]) => void,
  ): void;
  send(value: string): void;
}

export type ExpoControlSocketFactory = (url: string) => ExpoControlSocket;

export interface SendExpoControlOptions {
  action: ExpoControlAction;
  endpoint: string;
  signal?: AbortSignal;
  socketFactory?: ExpoControlSocketFactory;
  timeoutMs?: number;
}

const EXPO_MESSAGE_PROTOCOL_VERSION = 2;
let requestSequence = 0;

function loopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".").map(Number);
  return (
    octets.length === 4 &&
    octets[0] === 127 &&
    octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
  );
}

function messageSocketUrl(endpoint: string): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !loopbackHostname(url.hostname)) {
    return undefined;
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/message";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function defaultSocketFactory(url: string): ExpoControlSocket {
  const Socket = globalThis.WebSocket as unknown as new (endpoint: string) => ExpoControlSocket;
  return new Socket(url);
}

function eventText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  return undefined;
}

export async function sendExpoControl(options: SendExpoControlOptions): Promise<ExpoControlResult> {
  const socketUrl = messageSocketUrl(options.endpoint);
  if (socketUrl === undefined) {
    return {
      action: options.action,
      connectedClients: 0,
      detail: "Expo controls are limited to a verified local Metro endpoint.",
      ok: false,
    };
  }
  if (options.signal?.aborted === true) {
    return {
      action: options.action,
      connectedClients: 0,
      detail: "The Expo control was cancelled before it started.",
      ok: false,
    };
  }

  const requestId = `adb-ready-${String(++requestSequence)}`;
  const method = options.action === "reload" ? "reload" : "devMenu";
  const timeoutMs = Math.max(250, options.timeoutMs ?? 2_000);

  return await new Promise<ExpoControlResult>((resolve) => {
    let socket: ExpoControlSocket;
    try {
      socket = (options.socketFactory ?? defaultSocketFactory)(socketUrl);
    } catch {
      resolve({
        action: options.action,
        connectedClients: 0,
        detail: "The local Expo control channel could not be opened.",
        ok: false,
      });
      return;
    }

    let settled = false;
    const finish = (result: ExpoControlResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      try {
        socket.close(1000, "ADB Ready control complete");
      } catch {
        // The result is already known; closing the local transient socket is best-effort.
      }
      resolve(result);
    };
    const fail = (detail: string): void =>
      finish({ action: options.action, connectedClients: 0, detail, ok: false });
    const send = (payload: unknown, failureDetail: string): boolean => {
      try {
        socket.send(JSON.stringify(payload));
        return true;
      } catch {
        fail(failureDetail);
        return false;
      }
    };
    const onOpen = (): void => {
      send(
        {
          id: requestId,
          method: "getpeers",
          target: "server",
          version: EXPO_MESSAGE_PROTOCOL_VERSION,
        },
        "The local Expo control channel could not query active connections.",
      );
    };
    const onMessage = (event: SocketEventMap["message"]): void => {
      const text = eventText(event.data);
      if (text === undefined) return;
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (
        typeof message !== "object" ||
        message === null ||
        !("version" in message) ||
        message.version !== EXPO_MESSAGE_PROTOCOL_VERSION ||
        !("id" in message) ||
        message.id !== requestId ||
        !("result" in message) ||
        typeof message.result !== "object" ||
        message.result === null ||
        Array.isArray(message.result)
      ) {
        return;
      }
      const connectedClients = Object.keys(message.result).length;
      if (connectedClients === 0) {
        finish({
          action: options.action,
          connectedClients,
          detail: "No Expo app is connected to this Metro server yet.",
          ok: false,
        });
        return;
      }
      if (
        !send(
          { method, version: EXPO_MESSAGE_PROTOCOL_VERSION },
          "The local Expo control channel could not send the requested action.",
        )
      ) {
        return;
      }
      finish({
        action: options.action,
        connectedClients,
        detail:
          options.action === "reload"
            ? "Reload sent through Expo's active local control channel."
            : "Developer menu sent through Expo's active local control channel.",
        ok: true,
      });
    };
    const onError = (): void => fail("The local Expo control channel failed.");
    const onClose = (): void => fail("The local Expo control channel closed before responding.");
    const onAbort = (): void => fail("The Expo control was cancelled.");
    const timer = setTimeout(
      () => fail("Expo did not respond on its local control channel in time."),
      timeoutMs,
    );

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
