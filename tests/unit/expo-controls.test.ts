import { describe, expect, test } from "bun:test";
import { type ExpoControlSocketFactory, sendExpoControl } from "../../src/dev/expo-controls.js";

class FakeSocket {
  readonly listeners = new Map<string, Set<(event: never) => void>>();
  readonly sent: string[] = [];
  closed = false;
  respondWithPeers: Record<string, unknown> | undefined;

  addEventListener(event: string, listener: (value: never) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeEventListener(event: string, listener: (value: never) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  send(value: string): void {
    this.sent.push(value);
    const message = JSON.parse(value);
    if (message.method === "getpeers" && this.respondWithPeers !== undefined) {
      queueMicrotask(() =>
        this.emit("message", {
          data: JSON.stringify({
            id: message.id,
            result: this.respondWithPeers,
            version: 2,
          }),
        }),
      );
    }
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value as never);
  }
}

function fixture(peers: Record<string, unknown>): {
  factory: ExpoControlSocketFactory;
  socket: FakeSocket;
  urls: string[];
} {
  const socket = new FakeSocket();
  socket.respondWithPeers = peers;
  const urls: string[] = [];
  const factory: ExpoControlSocketFactory = (url) => {
    urls.push(url);
    queueMicrotask(() => socket.emit("open", {}));
    return socket;
  };
  return { factory, socket, urls };
}

describe("Expo live controls", () => {
  test("checks connected peers before sending the official reload protocol", async () => {
    const { factory, socket, urls } = fixture({ app: { platform: "android" } });

    const result = await sendExpoControl({
      action: "reload",
      endpoint: "http://[::1]:8099/status?probe=1",
      socketFactory: factory,
    });

    expect(result).toEqual({
      action: "reload",
      connectedClients: 1,
      detail: "Reload sent through Expo's active local control channel.",
      ok: true,
    });
    expect(urls).toEqual(["ws://[::1]:8099/message"]);
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      expect.objectContaining({ method: "getpeers", target: "server", version: 2 }),
      { method: "reload", version: 2 },
    ]);
    expect(socket.closed).toBeTrue();
  });

  test("sends the Expo developer-menu method only when an app is connected", async () => {
    const connected = fixture({ app1: {}, app2: {} });
    const result = await sendExpoControl({
      action: "dev-menu",
      endpoint: "http://127.0.0.1:8081",
      socketFactory: connected.factory,
    });
    expect(result.ok).toBeTrue();
    expect(result.connectedClients).toBe(2);
    expect(JSON.parse(connected.socket.sent[1] ?? "{}")).toEqual({
      method: "devMenu",
      version: 2,
    });

    const empty = fixture({});
    const unavailable = await sendExpoControl({
      action: "dev-menu",
      endpoint: "http://localhost:8081",
      socketFactory: empty.factory,
    });
    expect(unavailable).toMatchObject({
      connectedClients: 0,
      detail: "No Expo app is connected to this Metro server yet.",
      ok: false,
    });
    expect(empty.socket.sent).toHaveLength(1);
  });

  test("rejects non-loopback endpoints and handles cancellation safely", async () => {
    let constructed = false;
    const factory: ExpoControlSocketFactory = () => {
      constructed = true;
      return new FakeSocket();
    };
    expect(
      await sendExpoControl({
        action: "reload",
        endpoint: "https://metro.example.com:8081",
        socketFactory: factory,
      }),
    ).toMatchObject({ ok: false, detail: expect.stringContaining("verified local") });
    expect(constructed).toBeFalse();

    const controller = new AbortController();
    controller.abort();
    expect(
      await sendExpoControl({
        action: "reload",
        endpoint: "http://127.0.0.1:8081",
        signal: controller.signal,
        socketFactory: factory,
      }),
    ).toMatchObject({ ok: false, detail: expect.stringContaining("cancelled") });
    expect(constructed).toBeFalse();
  });

  test("reports synchronous socket send failures without escaping the input handler", async () => {
    const socket = new FakeSocket();
    socket.send = () => {
      throw new Error("closed");
    };
    const resultPromise = sendExpoControl({
      action: "reload",
      endpoint: "http://localhost:8081",
      socketFactory: () => {
        queueMicrotask(() => socket.emit("open", {}));
        return socket;
      },
    });

    await expect(resultPromise).resolves.toMatchObject({
      detail: "The local Expo control channel could not query active connections.",
      ok: false,
    });
    expect(socket.closed).toBeTrue();
  });

  test("cancels an in-flight peer query and closes its transient socket", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const resultPromise = sendExpoControl({
      action: "dev-menu",
      endpoint: "http://127.0.0.1:8081",
      signal: controller.signal,
      socketFactory: () => {
        queueMicrotask(() => socket.emit("open", {}));
        return socket;
      },
    });
    await Bun.sleep(0);
    controller.abort();

    await expect(resultPromise).resolves.toMatchObject({
      detail: "The Expo control was cancelled.",
      ok: false,
    });
    expect(socket.closed).toBeTrue();
  });
});
