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
});
