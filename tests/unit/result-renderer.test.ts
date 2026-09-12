import { describe, expect, test } from "bun:test";
import { EventBus } from "../../src/core/event-bus.js";
import { type ResultEnvelope, SCHEMA_VERSION } from "../../src/domain/contracts.js";
import { NdjsonEventRenderer, renderResult } from "../../src/ui/result-renderer.js";
import type { TextSink } from "../../src/ui/spinner.js";
import type { TerminalCapabilities } from "../../src/ui/terminal.js";

class MemorySink implements TextSink {
  value = "";

  write(chunk: string): void {
    this.value += chunk;
  }
}

const capabilities: TerminalCapabilities = {
  interactive: false,
  color: false,
  unicode: false,
  animation: false,
  columns: 120,
};

const result: ResultEnvelope<{
  adbPath: string;
  devices: Array<{
    serial: string;
    state: "device";
    model: string;
    properties: Record<string, string>;
    unparsed: string[];
  }>;
}> = {
  schemaVersion: SCHEMA_VERSION,
  command: "devices",
  commandId: "command-1",
  ok: true,
  startedAt: "2026-09-09T10:00:00.000Z",
  finishedAt: "2026-09-09T10:00:00.010Z",
  durationMs: 10,
  data: {
    adbPath: "~/Android/sdk/platform-tools/adb",
    devices: [
      {
        serial: "emulator-5554",
        state: "device",
        model: "Pixel 9",
        properties: {},
        unparsed: [],
      },
    ],
  },
  problems: [],
};

describe("result renderer", () => {
  test("writes the complete envelope as uncontaminated JSON", () => {
    const sink = new MemorySink();
    renderResult(result, { format: "json", capabilities, sink });

    expect(sink.value).not.toContain("\u001b");
    expect(JSON.parse(sink.value)).toEqual(result);
  });

  test("renders a compact ASCII human target summary", () => {
    const sink = new MemorySink();
    renderResult(result, { format: "human", capabilities, sink });

    expect(sink.value).toContain("ADB Ready · devices");
    expect(sink.value).toContain("Targets (1)");
    expect(sink.value).toContain("`- Pixel 9 · emulator-5554 · device");
    expect(sink.value).not.toContain("\u001b");
  });

  test("plain output is stable, line-oriented, and free of terminal controls", () => {
    const sink = new MemorySink();
    renderResult(result, { format: "plain", capabilities, sink });

    expect(sink.value).toBe(
      "command=devices\nok=true\nduration_ms=10\ndevice_count=1\ndevice_0=Pixel 9 · emulator-5554 · device\n",
    );
    expect(sink.value).not.toContain("\u001b");
  });

  test("renders discoverable wireless services separately from connected targets", () => {
    const wireless: ResultEnvelope<unknown> = {
      ...result,
      data: {
        adbPath: "~/Android/sdk/platform-tools/adb",
        devices: [],
        targets: [],
        discovery: {
          mdns: {
            available: true,
            method: "track",
            services: [
              {
                instance: "adb-PHONE-1-x",
                rawServiceType: "_adb-tls-connect._tcp",
                serviceType: "connect",
                endpoint: {
                  host: "192.168.1.20",
                  port: 37123,
                  serial: "192.168.1.20:37123",
                  version: 4,
                },
                givenName: "My Pixel",
              },
            ],
          },
          identity: { probed: 0, resolved: 0 },
        },
      },
    };
    const human = new MemorySink();
    const plain = new MemorySink();

    renderResult(wireless, { format: "human", capabilities, sink: human });
    renderResult(wireless, { format: "plain", capabilities, sink: plain });

    expect(human.value).toContain("Targets (0)");
    expect(human.value).toContain("Wireless discovery (1)");
    expect(human.value).toContain("My Pixel · 192.168.1.20:37123 · connect");
    expect(plain.value).toContain("wireless_service_count=1");
    expect(plain.value).toContain("wireless_service_0=My Pixel · 192.168.1.20:37123 · connect");
  });

  test("streams events and the final result as independently valid NDJSON records", () => {
    const sink = new MemorySink();
    const bus = new EventBus(() => new Date("2026-09-09T10:00:00.000Z"));
    const events = new NdjsonEventRenderer(bus, sink);
    bus.emit({
      type: "operation.started",
      source: "adb.devices",
      severity: "info",
      message: "Discovering targets",
      correlation: { commandId: "command-1" },
    });
    events.dispose();
    renderResult(result, { format: "ndjson", capabilities, sink });

    const records = sink.value
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ kind: "event", type: "operation.started" });
    expect(records[1]).toMatchObject({ kind: "result", command: "devices", ok: true });
  });

  test("renders port lists without confusing them with saved sessions", () => {
    for (const mappings of [[], [{ direction: "forward", device: "tcp:8081", host: "tcp:8081" }]]) {
      const ports: ResultEnvelope<unknown> = {
        ...result,
        command: "ports forward list",
        data: {
          direction: "forward",
          action: "list",
          status: "listed",
          selected: { transport: { serial: "USB-1" } },
          mappings,
        },
      };
      const human = new MemorySink();
      const plain = new MemorySink();

      expect(() =>
        renderResult(ports, { format: "human", capabilities, sink: human }),
      ).not.toThrow();
      expect(() =>
        renderResult(ports, { format: "plain", capabilities, sink: plain }),
      ).not.toThrow();
      expect(human.value).toContain(`Mappings (${String(mappings.length)})`);
      expect(plain.value).toContain(`mapping_count=${String(mappings.length)}`);
    }
  });

  test("renders saved session timelines and problem summaries for humans", () => {
    const session = {
      schemaVersion: SCHEMA_VERSION,
      command: "sessions events",
      commandId: "command-2",
      ok: true,
      startedAt: "2026-09-10T11:00:00.000Z",
      finishedAt: "2026-09-10T11:00:00.000Z",
      durationMs: 0,
      data: {
        action: "events",
        session: {
          schemaVersion: 1 as const,
          sessionId: "session-1",
          status: "failed" as const,
          command: "dev",
          startedAt: "2026-09-10T10:00:00.000Z",
          updatedAt: "2026-09-10T10:01:00.000Z",
          eventFile: "session-1.ndjson",
          eventCount: 1,
          eventBytes: 120,
          problems: [],
        },
        events: [
          {
            schemaVersion: SCHEMA_VERSION,
            sequence: 1,
            timestamp: "2026-09-10T10:00:00.000Z",
            type: "session.degraded",
            source: "recovery",
            severity: "warning" as const,
            message: "A required port disappeared.",
            correlation: { commandId: "command-1", sessionId: "session-1" },
          },
        ],
      },
      problems: [],
    };
    const human = new MemorySink();
    renderResult(session, { format: "human", capabilities, sink: human });
    expect(human.value).toContain("Session  session-1");
    expect(human.value).toContain("Timeline (1)");
    expect(human.value).toContain("session.degraded · A required port disappeared.");

    const ndjson = new MemorySink();
    renderResult(session, { format: "ndjson", capabilities, sink: ndjson });
    const records = ndjson.value
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ kind: "event", type: "session.degraded" });
    expect(records[1]).toMatchObject({
      kind: "result",
      command: "sessions events",
      data: { action: "events", eventCount: 1 },
    });
    const summaryData = records[1]?.data;
    expect(summaryData).toBeObject();
    if (typeof summaryData !== "object" || summaryData === null) {
      throw new Error("Expected an NDJSON result summary");
    }
    expect((summaryData as Record<string, unknown>).events).toBeUndefined();

    const problems = new MemorySink();
    renderResult(
      {
        ...session,
        command: "problems",
        data: {
          sessionId: "session-1",
          status: "failed",
          problems: [
            {
              code: "SESSION_RECOVERY_FAILED",
              category: "session.recovery",
              severity: "error",
              summary: "Recovery stopped safely.",
              detail: "The retry budget was exhausted.",
              retryable: true,
            },
          ],
        },
      },
      { format: "human", capabilities, sink: problems },
    );
    expect(problems.value).toContain("Problems (1)");
    expect(problems.value).toContain("SESSION_RECOVERY_FAILED · Recovery stopped safely.");
  });

  test("sanitizes terminal control characters from human-facing device fields", () => {
    const sink = new MemorySink();
    const unsafe = structuredClone(result);
    const device = unsafe.data?.devices[0];
    if (device !== undefined) {
      device.model = "Pixel\u001b[31m\nspoofed";
    }
    renderResult(unsafe, { format: "human", capabilities, sink });

    expect(sink.value).toContain("Pixel spoofed");
    expect(sink.value).not.toContain("\u001b");
  });

  test("presents Ctrl-C as a safe interruption while retaining a failed envelope", () => {
    const sink = new MemorySink();
    renderResult(
      {
        ...result,
        command: "logs",
        ok: false,
        data: null,
        problems: [
          {
            code: "OPERATION_INTERRUPTED",
            category: "process.interrupted",
            severity: "error",
            summary: "Log streaming was interrupted.",
            detail: "The owned process was stopped safely.",
            retryable: true,
            evidence: [],
            actions: [],
            correlation: { commandId: "command-1" },
          },
        ],
      },
      { format: "human", capabilities, sink },
    );

    expect(sink.value).toContain("Interrupted safely in 10ms");
    expect(sink.value).not.toContain("Failed in");
  });

  test("renders every public result family in both human and stable plain output", () => {
    const target = {
      id: "target-1",
      name: "Pixel 9",
      serial: "USB-1",
      state: "device",
      transports: [{ serial: "USB-1", state: "device", kind: "usb", stable: true }],
    };
    const selected = { target, transport: { serial: "USB-1", transportId: "7" } };
    const session = {
      sessionId: "session-1",
      status: "completed",
      planScope: "target",
      selected,
      project: { root: "/workspace/app", name: "demo" },
      preset: "expo",
      ports: { requested: [], created: [], reused: [] },
      command: { executable: "npm", args: ["run", "start"] },
      child: { exitCode: 0, signal: null },
      readiness: { ready: true, assertions: [{ status: "passed" }] },
      verification: { passed: true, timedOut: false, exitCode: 0 },
      journal: { events: [], dropped: 0 },
      recovery: { failed: false, recoveries: 0 },
    };
    const fixtures: Array<{ command: string; data: unknown; expected: string }> = [
      {
        command: "doctor",
        data: {
          runtime: { name: "node", version: "22", platform: "linux", architecture: "x64" },
          adb: { path: "/sdk/adb", version: { platformToolsVersion: "37" }, hostFeatures: [] },
          devices: [],
          targets: [target],
          discovery: { mdns: { services: [] } },
        },
        expected: "Runtime",
      },
      {
        command: "connect",
        data: {
          endpoint: "10.0.0.2:4000",
          serial: "10.0.0.2:4000",
          state: "device",
          hardwareSerial: "PHONE-1",
        },
        expected: "Connected",
      },
      { command: "dev", data: session, expected: "Session" },
      {
        command: "run",
        data: { outcome: "success", evidence: { path: ".adb-ready/evidence.json" }, session },
        expected: "Outcome",
      },
      {
        command: "logs",
        data: {
          selected,
          filters: ["*:W"],
          packageName: "com.example",
          uid: 10_001,
          pid: 123,
          buffers: ["main"],
          records: [{ raw: "W/App: warning" }],
          dropped: 1,
          findings: [{ code: "ANDROID_CRASH", summary: "Crash found" }],
        },
        expected: "Findings",
      },
      {
        command: "apps list",
        data: { selected, scope: "user", filter: "example", packages: [{ name: "com.example" }] },
        expected: "Packages",
      },
      {
        command: "app resolve",
        data: {
          action: "resolve",
          resolution: {
            kind: "resolved",
            applicationId: "com.example",
            provenance: { source: "config", location: "adb-ready.json" },
          },
        },
        expected: "Source",
      },
      {
        command: "app info",
        data: {
          action: "info",
          selected,
          applicationId: "com.example",
          package: {
            applicationId: "com.example",
            installed: true,
            versionName: "1.0",
            debuggable: true,
          },
          foreground: { applicationId: "com.example", activity: ".MainActivity" },
        },
        expected: "Foreground",
      },
      {
        command: "app launch",
        data: {
          action: "launch",
          selected,
          applicationId: "com.example",
          status: "completed",
          verified: true,
          activity: ".MainActivity",
        },
        expected: "verified",
      },
      {
        command: "open",
        data: {
          selected,
          url: "demo://ready",
          status: "planned",
          verified: false,
          plan: {
            schemaVersion: 1,
            dryRun: true,
            steps: [{ id: "open-url", title: "Open demo URL", risk: "device-reversible" }],
          },
        },
        expected: "no changes made",
      },
      {
        command: "capture screenshot",
        data: {
          kind: "screenshot",
          selected,
          evidence: {
            path: "screen.png",
            mediaType: "image/png",
            bytes: 100,
            sha256: "a".repeat(64),
          },
        },
        expected: "SHA-256",
      },
      {
        command: "inspect app",
        data: {
          kind: "app",
          selected,
          app: {
            package: { applicationId: "com.example", versionName: "1.0" },
            foreground: { applicationId: "com.example", activity: ".MainActivity" },
          },
          logs: { available: true, records: [], findings: [] },
        },
        expected: "Privacy",
      },
      {
        command: "inspect ui",
        data: {
          kind: "ui",
          selected,
          snapshot: {
            digest: "b".repeat(64),
            complete: true,
            returnedNodes: 1,
            totalNodes: 1,
            truncated: false,
            nodes: [{ ref: "ui:bbbbbbbbbbbb:1", text: "Ready" }],
          },
        },
        expected: "Nodes",
      },
      {
        command: "ui tap",
        data: {
          action: "tap",
          selected,
          status: "completed",
          verified: true,
          verification: "ui-changed",
          attempts: 1,
          resolved: { ref: "ui:aaaaaaaaaaaa:1", x: 10, y: 20 },
          before: { digest: "a".repeat(64) },
          after: { digest: "b".repeat(64) },
        },
        expected: "UI digest",
      },
      {
        command: "sessions list",
        data: {
          action: "list",
          sessions: [
            {
              sessionId: "session-1",
              status: "completed",
              updatedAt: "2026-09-10",
              preset: "expo",
              projectFingerprint: "project",
            },
          ],
        },
        expected: "Sessions (1)",
      },
      {
        command: "sessions events",
        data: {
          action: "events",
          session: {
            sessionId: "session-1",
            status: "completed",
            startedAt: "2026-09-10",
            eventCount: 0,
            eventBytes: 0,
          },
          events: [
            {
              schemaVersion: 1,
              sequence: 1,
              timestamp: "2026-09-10T10:00:00.000Z",
              type: "target.selected",
              source: "target",
              severity: "info",
              message: "Target selected",
              correlation: { commandId: "command-1" },
            },
          ],
        },
        expected: "Started",
      },
      {
        command: "problems",
        data: {
          sessionId: "session-1",
          status: "completed",
          problems: [{ code: "TARGET_LOST", summary: "Target disconnected" }],
        },
        expected: "Target disconnected",
      },
      {
        command: "context",
        data: {
          sessionId: "session-1",
          status: "completed",
          markdown: "# Context\n",
          characterCount: 10,
          includedEvents: 1,
          omittedEvents: 2,
          filteredEvents: 3,
        },
        expected: "Privacy",
      },
      {
        command: "init",
        data: { status: "created", path: "adb-ready.json", document: {}, detectedPreset: "expo" },
        expected: "Preset",
      },
      {
        command: "agent setup",
        data: {
          client: "codex",
          status: "created",
          path: ".codex/config.toml",
          format: "toml",
          scope: "project",
          content: "[mcp_servers.adb_ready]\n",
          next: "Restart Codex",
        },
        expected: "Next:",
      },
      {
        command: "config explain",
        data: {
          action: "explain",
          valid: true,
          files: { project: "adb-ready.json", user: "/user/config.json" },
          values: [{ key: "preset", value: "expo", source: "project", location: "adb-ready.json" }],
        },
        expected: "Resolved values (1)",
      },
      {
        command: "pair",
        data: { paired: true, endpoint: "10.0.0.2:4001" },
        expected: "Paired",
      },
    ];

    for (const item of fixtures) {
      const envelope: ResultEnvelope<unknown> = {
        ...result,
        command: item.command,
        data: item.data,
      };
      const human = new MemorySink();
      const plain = new MemorySink();
      renderResult(envelope, { format: "human", capabilities, sink: human });
      renderResult(envelope, { format: "plain", capabilities, sink: plain });
      expect(human.value).toContain(item.expected);
      expect(plain.value).toContain(`command=${item.command}`);
    }

    const markdown = new MemorySink();
    renderResult(
      {
        ...result,
        command: "context",
        data: fixtures.find(({ command }) => command === "context")?.data,
      },
      { format: "markdown", capabilities, sink: markdown },
    );
    expect(markdown.value).toBe("# Context\n");
  });
});
