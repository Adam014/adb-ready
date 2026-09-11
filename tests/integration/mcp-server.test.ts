import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  InMemoryTransport,
  type JSONRPCMessage,
  type JSONRPCResponse,
} from "@modelcontextprotocol/server";
import { createAdbReadyMcpServer } from "../../src/agent/mcp-server.js";
import type { CommandDependencies } from "../../src/app/commands.js";
import type { ProcessRequest, ProcessResult } from "../../src/platform/process-runner.js";

const UI = `<?xml version="1.0"?><hierarchy><node bounds="[0,0][1080,2400]"><node text="Open" resource-id="com.example:id/open" class="android.widget.Button" clickable="true" long-clickable="true" enabled="true" bounds="[20,100][220,200]" /><node text="old" resource-id="com.example:id/email" class="android.widget.EditText" focusable="true" enabled="true" bounds="[100,300][900,420]" /><node resource-id="com.example:id/list" scrollable="true" enabled="true" bounds="[100,400][900,2000]" /></node></hierarchy>`;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

function result(request: ProcessRequest, stdout = "", exitCode = 0): ProcessResult {
  return {
    executable: request.executable,
    args: [...(request.args ?? [])],
    startedAt: "2026-09-11T10:00:00.000Z",
    finishedAt: "2026-09-11T10:00:00.010Z",
    durationMs: 10,
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    stoppedAfterIdle: false,
    killEscalated: false,
  };
}

function dependencies(): CommandDependencies {
  let id = 0;
  return {
    idFactory: () => `mcp-${String(++id)}`,
    clock: () => new Date("2026-09-11T10:00:00.000Z"),
    locateAdb: async () => "/sdk/adb",
    locateExecutable: async (executable) => `/bin/${executable}`,
    runtime: () => ({
      name: "bun",
      version: "1.3.1",
      executable: "bun",
      platform: process.platform,
      architecture: process.arch,
    }),
    detectProject: async ({ cwd }) => ({
      root: cwd,
      presetEvidence: [],
      packageManager: { conflicts: [] },
    }),
    sleep: async () => false,
    runner: async (request) => {
      const args = [...(request.args ?? [])];
      if (args.includes("devices")) {
        return result(
          request,
          "List of devices attached\nUSB-1 device model:Pixel_9 product:demo transport_id:7\n",
        );
      }
      if (args.includes("host-features")) return result(request, "shell_v2,mdns\n");
      if (args.includes("server-status")) return result(request, "usb_backend=libusb\n");
      if (args.includes("mdns")) return result(request, "List of discovered mdns services\n");
      if (args.includes("ro.serialno")) return result(request, "hardware-1\n");
      if (args.includes("reverse") && args.includes("--list")) return result(request);
      if (args.includes("wm") && args.includes("size")) {
        return result(request, "Physical size: 1080x2400\n");
      }
      if (args.includes("input") && args.includes("help")) {
        return result(request, "text keyevent keycombination\n");
      }
      if (args.includes("uiautomator")) return result(request, UI);
      if (args.includes("screencap")) {
        request.onStdoutChunk?.(PNG);
        return result(request);
      }
      if (args.includes("list") && args.includes("packages")) {
        return result(request, "package:/data/app/com.example.app/base.apk=com.example.app\n");
      }
      if (args.includes("resolve-activity"))
        return result(request, "com.example.app/.MainActivity\n");
      if (args.includes("activity") && args.includes("activities")) {
        return result(
          request,
          "mResumedActivity: ActivityRecord{42 u0 com.example.app/.MainActivity t12}\n",
        );
      }
      if (args.includes("dumpsys") && args.includes("package")) {
        return result(
          request,
          "Package [com.example.app]\n codePath=/data/app/com.example.app\n versionCode=7 targetSdk=36\n versionName=1.0.0\n pkgFlags=[ DEBUGGABLE ]\n",
        );
      }
      if (args.includes("pidof")) return result(request, "321\n");
      if (args.includes("logcat")) {
        const output = "09-11 10:00:00.000  321  322 E Demo: crash marker\n";
        request.onStdoutChunk?.(new TextEncoder().encode(output));
        return result(request, output);
      }
      return result(request, args.includes("start") ? "Status: ok\n" : "");
    },
  };
}

class McpPeer {
  readonly #transport: InMemoryTransport;
  readonly #pending = new Map<number, (message: JSONRPCResponse) => void>();
  #id = 0;

  constructor(transport: InMemoryTransport) {
    this.#transport = transport;
    transport.onmessage = (message: JSONRPCMessage) => {
      if (!("id" in message) || message.id === undefined || typeof message.id !== "number") return;
      if (!("result" in message) && !("error" in message)) return;
      this.#pending.get(message.id)?.(message);
      this.#pending.delete(message.id);
    };
  }

  async start(): Promise<void> {
    await this.#transport.start();
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<JSONRPCResponse> {
    const id = ++this.#id;
    const response = new Promise<JSONRPCResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 2_000);
      this.#pending.set(id, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
    });
    await this.#transport.send({ jsonrpc: "2.0", id, method, params });
    return await response;
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    await this.#transport.send({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    await this.#transport.close();
  }
}

function resultBody(response: JSONRPCResponse): Record<string, unknown> {
  expect(response).toHaveProperty("result");
  return ("result" in response ? response.result : {}) as Record<string, unknown>;
}

async function callTool(
  peer: McpPeer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return resultBody(
    await peer.request("tools/call", {
      name,
      arguments: args,
    }),
  );
}

describe("MCP server protocol", () => {
  test("serves the complete agent workflow through an in-memory JSON-RPC connection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "adb-ready-mcp-in-process-"));
    roots.push(root);
    await writeFile(path.join(root, "app.apk"), "apk");
    const env = {
      ...process.env,
      ADB_READY_INTERACTIVE: "false",
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
    };
    const server = createAdbReadyMcpServer({
      cwd: root,
      env,
      dependencies: dependencies(),
      targetLease: false,
      version: "0.3.3-test",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const peer = new McpPeer(clientTransport);
    await peer.start();
    await server.connect(serverTransport);

    try {
      const initialized = resultBody(
        await peer.request("initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "adb-ready-tests", version: "1" },
        }),
      );
      expect(initialized).toMatchObject({
        serverInfo: { name: "adb-ready", version: "0.3.3-test" },
      });
      await peer.notify("notifications/initialized");

      const listed = resultBody(await peer.request("tools/list"));
      expect(listed.tools).toBeArrayOfSize(31);
      expect(resultBody(await peer.request("resources/list")).resources).toBeArrayOfSize(2);
      expect(
        resultBody(await peer.request("resources/templates/list")).resourceTemplates,
      ).toBeArrayOfSize(3);

      expect(await callTool(peer, "doctor")).toMatchObject({ structuredContent: { ok: true } });
      expect(await callTool(peer, "list_targets")).toMatchObject({
        structuredContent: { ok: true },
      });
      expect(
        await callTool(peer, "resolve_app", { applicationId: "com.example.app" }),
      ).toMatchObject({
        structuredContent: { ok: true },
      });
      expect(
        await callTool(peer, "ensure_ready", { device: "USB-1", transportId: "7" }),
      ).toMatchObject({ structuredContent: { ok: false } });
      const ready = await callTool(peer, "ensure_ready", { device: "USB-1" });
      expect(ready).toMatchObject({ structuredContent: { ok: true } });
      const structured = ready.structuredContent as { data: { targetHandle: string } };
      const targetHandle = structured.data.targetHandle;
      expect(targetHandle).toMatch(/^[a-f0-9-]{36}$/u);
      expect(await callTool(peer, "ensure_ready", { device: "OTHER" })).toMatchObject({
        structuredContent: { ok: false },
      });
      expect(
        await callTool(peer, "inspect_ui", { targetHandle: crypto.randomUUID() }),
      ).toMatchObject({
        structuredContent: { ok: false },
      });

      const target = { targetHandle };
      const calls: Array<[string, Record<string, unknown>]> = [
        ["launch_app", { ...target, applicationId: "com.example.app" }],
        ["restart_app", { ...target, applicationId: "com.example.app" }],
        ["install_app", { ...target, path: "app.apk", applicationId: "com.example.app" }],
        ["open_url", { ...target, url: "https://example.com", applicationId: "com.example.app" }],
        ["inspect_app", { ...target, applicationId: "com.example.app" }],
        ["inspect_ui", target],
        ["audit_ui", target],
        ["find_ui", { ...target, selector: "text=Open" }],
        ["get_ui", { ...target, selector: "id=com.example:id/open" }],
        ["assert_ui", { ...target, selector: "text=Open" }],
        ["compare_ui", { ...target, digest: "0".repeat(64) }],
        ["tap_ui", { ...target, target: { selector: "text=Open" }, dryRun: true }],
        ["long_press_ui", { ...target, target: { x: 120, y: 150 }, dryRun: true }],
        ["swipe_ui", { ...target, direction: "up", dryRun: true }],
        [
          "scroll_ui",
          { ...target, direction: "down", selector: "id=com.example:id/list", dryRun: true },
        ],
        ["type_text_ui", { ...target, text: "hello", submit: true, dryRun: true }],
        [
          "fill_ui",
          {
            ...target,
            selector: "id=com.example:id/email",
            text: "person@example.com",
            dryRun: true,
          },
        ],
        ["clear_ui", { ...target, selector: "id=com.example:id/email", dryRun: true }],
        ["press_key_ui", { ...target, key: "back", dryRun: true }],
        ["wait_for_ui", { ...target, selector: "text=Open", timeoutMs: 100 }],
        ["capture_screenshot", { ...target, out: "evidence/mcp.png" }],
        ["get_dev_session", { taskHandle: crypto.randomUUID() }],
        ["stop_dev_session", { taskHandle: crypto.randomUUID() }],
        ["list_sessions", { limit: 5 }],
        ["get_session_problems", {}],
        ["compile_debug_context", { budget: 2_000 }],
      ];
      for (const [name, args] of calls) {
        const response = await callTool(peer, name, args);
        expect(response).toHaveProperty("structuredContent");
      }
      expect(
        await callTool(peer, "install_app", { ...target, path: "app.apk", paths: ["app.apk"] }),
      ).toMatchObject({
        structuredContent: { ok: false },
      });
      expect(await callTool(peer, "swipe_ui", { ...target, direction: "up", x1: 1 })).toMatchObject(
        {
          structuredContent: { ok: false },
        },
      );

      for (const uri of [
        "adb-ready://targets",
        "adb-ready://sessions",
        "adb-ready://sessions/missing",
        "adb-ready://sessions/missing/events/nope/999",
        "adb-ready://sessions/missing/context",
      ]) {
        expect(resultBody(await peer.request("resources/read", { uri })).contents).toBeArray();
      }
    } finally {
      await server.close();
      await peer.close();
    }
  });
});
