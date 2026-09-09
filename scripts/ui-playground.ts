import process from "node:process";
import { EventBus } from "../src/core/event-bus.js";
import { type Problem, type ResultEnvelope, SCHEMA_VERSION } from "../src/domain/contracts.js";
import { confirmAction } from "../src/ui/confirm.js";
import { ProgressRenderer } from "../src/ui/progress-renderer.js";
import { renderResult } from "../src/ui/result-renderer.js";
import { selectOne } from "../src/ui/select.js";
import { resolveTerminalCapabilities } from "../src/ui/terminal.js";

type ScenarioName =
  | "success"
  | "missing-adb"
  | "no-devices"
  | "multiple-devices"
  | "unavailable-devices"
  | "slow-progress"
  | "recovery"
  | "interrupt"
  | "confirmation"
  | "output-modes";

const SCENARIOS: Array<{ value: ScenarioName; label: string; description: string }> = [
  { value: "success", label: "Successful discovery", description: "One ready USB target" },
  { value: "missing-adb", label: "Missing ADB", description: "Environment error and next action" },
  { value: "no-devices", label: "No devices", description: "Non-fatal empty inventory" },
  {
    value: "multiple-devices",
    label: "Multiple devices",
    description: "Keyboard target selection",
  },
  {
    value: "unavailable-devices",
    label: "Unavailable devices",
    description: "Unauthorized and offline states",
  },
  { value: "slow-progress", label: "Slow progress", description: "Animated operation lifecycle" },
  {
    value: "recovery",
    label: "Warning and recovery",
    description: "Failed probe followed by success",
  },
  { value: "interrupt", label: "Ctrl-C cleanup", description: "Cursor and animation restoration" },
  {
    value: "confirmation",
    label: "Safe confirmation",
    description: "Action, scope, risk, and automation equivalent",
  },
  { value: "output-modes", label: "Output modes", description: "Plain, JSON, and NDJSON previews" },
];

const argv = process.argv.slice(2);
const nonInteractive = argv.includes("--non-interactive");
const all = argv.includes("--all");
const list = argv.includes("--list");
const scenarioArgument = argv.find((argument) => argument.startsWith("--scenario="))?.slice(11);
const capabilities = resolveTerminalCapabilities({
  format: "human",
  nonInteractive,
  env: process.env,
  inputIsTTY: process.stdin.isTTY === true,
  outputIsTTY: process.stderr.isTTY === true,
  columns: process.stderr.columns,
});

const readyDevice = {
  serial: "R5CT-DEMO-001",
  state: "device" as const,
  model: "Pixel 9",
  properties: { model: "Pixel_9", transport_id: "1" },
  unparsed: [],
};
const emulator = {
  serial: "emulator-5554",
  state: "device" as const,
  model: "Android SDK emulator",
  properties: { model: "Android_SDK_emulator", transport_id: "2" },
  unparsed: [],
};

function problem(overrides: Partial<Problem> & Pick<Problem, "code" | "summary">): Problem {
  return {
    category: "playground.fixture",
    severity: "warning",
    detail: "This is deterministic fixture data; no host or Android target was changed.",
    retryable: true,
    evidence: [],
    actions: [],
    correlation: { commandId: "playground" },
    ...overrides,
  };
}

function result(
  devices: Array<typeof readyDevice | typeof emulator | Record<string, unknown>>,
  problems: Problem[] = [],
  ok = true,
): ResultEnvelope<unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    command: "devices",
    commandId: "playground",
    ok,
    startedAt: "2026-09-09T10:00:00.000Z",
    finishedAt: "2026-09-09T10:00:00.120Z",
    durationMs: 120,
    data: { adbPath: "~/Android/sdk/platform-tools/adb", devices },
    problems,
  };
}

function human(value: ResultEnvelope<unknown>): void {
  renderResult(value, { format: "human", capabilities, sink: process.stderr, verbose: true });
}

async function progress(
  messages: Array<{ type: "failed" | "completed"; message: string }>,
  slow: boolean,
) {
  const bus = new EventBus();
  const renderer = new ProgressRenderer({ bus, sink: process.stderr, capabilities, verbose: true });
  try {
    for (const [index, item] of messages.entries()) {
      const source = `playground.step-${String(index + 1)}`;
      bus.emit({
        type: "operation.started",
        source,
        severity: "info",
        message: item.message,
        correlation: { commandId: "playground" },
      });
      if (slow) {
        await new Promise((resolve) => setTimeout(resolve, nonInteractive ? 1 : 700));
      }
      bus.emit({
        type: `operation.${item.type}`,
        source,
        severity: item.type === "failed" ? "error" : "info",
        message: `${item.message} ${item.type}`,
        correlation: { commandId: "playground" },
      });
    }
  } finally {
    renderer.dispose();
  }
}

async function runScenario(name: ScenarioName): Promise<void> {
  process.stderr.write(
    `\n--- ${SCENARIOS.find(({ value }) => value === name)?.label ?? name} ---\n`,
  );
  if (name === "success") {
    await progress([{ type: "completed", message: "Discovering Android targets" }], false);
    human(result([readyDevice]));
  } else if (name === "missing-adb") {
    human(
      result(
        [],
        [
          problem({
            code: "ADB_NOT_FOUND",
            category: "environment.executable",
            severity: "error",
            summary: "ADB was not found.",
            actions: [
              {
                id: "configure_adb",
                title: "Provide the ADB executable with --adb PATH",
                kind: "user",
                risk: "none",
                automatic: false,
              },
            ],
          }),
        ],
        false,
      ),
    );
  } else if (name === "no-devices") {
    human(
      result([], [problem({ code: "NO_TARGETS", summary: "No Android targets are visible." })]),
    );
  } else if (name === "multiple-devices") {
    let fixture = result([readyDevice, emulator]);
    if (capabilities.interactive) {
      const selection = await selectOne({
        title: "Select a fixture target",
        options: [
          { value: readyDevice, label: readyDevice.model, description: readyDevice.serial },
          { value: emulator, label: emulator.model, description: emulator.serial },
        ],
        input: process.stdin,
        sink: process.stderr,
        capabilities,
      });
      if (selection.kind === "selected") {
        fixture = { ...fixture, data: { ...(fixture.data as object), selected: selection.value } };
      }
    }
    human(fixture);
  } else if (name === "unavailable-devices") {
    human(
      result(
        [
          {
            ...readyDevice,
            serial: "R5CT-UNAUTHORIZED",
            state: "unauthorized",
          },
          { ...readyDevice, serial: "192.0.2.10:5555", state: "offline" },
        ],
        [
          problem({ code: "TARGET_UNAUTHORIZED", summary: "A target requires authorization." }),
          problem({ code: "TARGET_OFFLINE", summary: "A target is offline." }),
        ],
      ),
    );
  } else if (name === "slow-progress") {
    await progress(
      [
        { type: "completed", message: "Locating ADB" },
        { type: "completed", message: "Checking ADB capabilities" },
        { type: "completed", message: "Discovering Android targets" },
      ],
      true,
    );
    human(result([readyDevice]));
  } else if (name === "recovery") {
    await progress(
      [
        { type: "failed", message: "Connecting wireless target" },
        { type: "completed", message: "Recovering over USB" },
      ],
      true,
    );
    human(result([readyDevice]));
  } else if (name === "interrupt") {
    const bus = new EventBus();
    const renderer = new ProgressRenderer({ bus, sink: process.stderr, capabilities });
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    try {
      bus.emit({
        type: "operation.started",
        source: "playground.interrupt",
        severity: "info",
        message: nonInteractive ? "Simulating interrupted operation" : "Press Ctrl-C to interrupt",
        correlation: { commandId: "playground" },
      });
      if (nonInteractive) {
        controller.abort();
      } else {
        await Promise.race([
          new Promise<void>((resolve) =>
            controller.signal.addEventListener("abort", () => resolve()),
          ),
          new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
        ]);
      }
      bus.emit({
        type: "operation.failed",
        source: "playground.interrupt",
        severity: "error",
        message: "Interrupted operation failed",
        correlation: { commandId: "playground" },
      });
    } finally {
      process.removeListener("SIGINT", abort);
      renderer.dispose();
    }
  } else if (name === "confirmation") {
    if (capabilities.interactive) {
      const confirmation = await confirmAction({
        action: "Clear app data",
        scope: `${readyDevice.serial} · com.example.fixture`,
        risk: "destructive",
        nonInteractiveFlag: "--yes",
        input: process.stdin,
        sink: process.stderr,
        capabilities,
      });
      process.stderr.write(`Fixture result: ${confirmation.kind}. No target was changed.\n`);
    } else {
      process.stderr.write(
        "Confirmation unavailable in non-interactive mode. No target was changed.\n",
      );
    }
  } else {
    const fixture = result([readyDevice]);
    renderResult(fixture, { format: "plain", capabilities, sink: process.stdout });
    renderResult(fixture, { format: "json", capabilities, sink: process.stdout });
    const bus = new EventBus(() => new Date("2026-09-09T10:00:00.000Z"));
    const { NdjsonEventRenderer } = await import("../src/ui/result-renderer.js");
    const events = new NdjsonEventRenderer(bus, process.stdout);
    bus.emit({
      type: "operation.completed",
      source: "playground.output",
      severity: "info",
      message: "Fixture completed",
      correlation: { commandId: "playground" },
    });
    events.dispose();
    renderResult(fixture, { format: "ndjson", capabilities, sink: process.stdout });
  }
}

if (list) {
  process.stdout.write(`${SCENARIOS.map(({ value }) => value).join("\n")}\n`);
} else if (all) {
  for (const scenario of SCENARIOS) {
    await runScenario(scenario.value);
  }
} else if (scenarioArgument !== undefined) {
  const scenario = SCENARIOS.find(({ value }) => value === scenarioArgument);
  if (scenario === undefined) {
    process.stderr.write(
      `Unknown scenario: ${scenarioArgument}\nUse --list to see available scenarios.\n`,
    );
    process.exitCode = 2;
  } else {
    await runScenario(scenario.value);
  }
} else if (!capabilities.interactive) {
  process.stderr.write(
    "The playground menu needs a TTY. Use --all --non-interactive in automation.\n",
  );
  process.exitCode = 2;
} else {
  let open = true;
  while (open) {
    const selected = await selectOne({
      title: "ADB Ready UI playground",
      options: [
        ...SCENARIOS,
        { value: "exit" as const, label: "Exit", description: "Close the playground" },
      ],
      input: process.stdin,
      sink: process.stderr,
      capabilities,
    });
    if (selected.kind !== "selected" || selected.value === "exit") {
      open = false;
    } else {
      await runScenario(selected.value);
    }
  }
}
