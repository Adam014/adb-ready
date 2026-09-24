import { type SelectInput, selectOne } from "./select.js";
import type { TextSink } from "./spinner.js";
import { sanitizeTerminalText, style } from "./style.js";
import type { TerminalCapabilities } from "./terminal.js";

export type DeviceSetupAction = "connect" | "devices" | "pair";

export type DeviceSetupResult =
  | { kind: "action"; action: DeviceSetupAction }
  | { kind: "cancelled"; reason: "escape" | "interrupt" | "signal" }
  | { kind: "unavailable" };

export interface DeviceSetupOptions {
  input: SelectInput;
  sink: TextSink;
  capabilities: TerminalCapabilities;
  signal?: AbortSignal;
}

function wrap(value: string, width: number): string[] {
  const words = sanitizeTerminalText(value).split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length <= width) {
      current = candidate;
      continue;
    }
    if (current !== "") lines.push(current);
    current = word;
  }
  if (current !== "") lines.push(current);
  return lines;
}

function guide(
  title: string,
  steps: readonly string[],
  capabilities: TerminalCapabilities,
): string[] {
  const width = Math.max(18, capabilities.columns - 8);
  const rail = capabilities.unicode ? "│" : "|";
  const lines = [style.accent(`DEVICE SETUP · ${title}`, capabilities), ""];
  for (const [index, step] of steps.entries()) {
    const prefix = `${String(index + 1)}. `;
    const wrapped = wrap(step, Math.max(12, width - prefix.length));
    for (const [lineIndex, line] of wrapped.entries()) {
      const marker = lineIndex === 0 ? prefix : " ".repeat(prefix.length);
      lines.push(`${style.dim(rail, capabilities)} ${marker}${line}`);
    }
  }
  lines.push("");
  return lines;
}

function intro(title: string, detail: string, capabilities: TerminalCapabilities): string[] {
  return [
    style.accent(`DEVICE SETUP · ${title}`, capabilities),
    ...wrap(detail, Math.max(18, capabilities.columns - 4)).map((line) =>
      style.dim(line, capabilities),
    ),
    "",
  ];
}

async function nextStep(
  options: DeviceSetupOptions,
  title: string,
  steps: readonly string[],
  action: DeviceSetupAction,
  label: string,
): Promise<DeviceSetupResult | { kind: "back" }> {
  const selected = await selectOne<DeviceSetupAction | "back">({
    title: "READY FOR ADB READY?",
    options: [
      {
        value: action,
        label,
        description: "ADB Ready will verify the target before using it.",
        recommended: true,
      },
      { value: "back", label: "Choose another method" },
    ],
    input: options.input,
    sink: options.sink,
    capabilities: options.capabilities,
    preamble: () => guide(title, steps, options.capabilities),
    escapeLabel: "back",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (selected.kind !== "selected") return selected;
  return selected.value === "back" ? { kind: "back" } : { kind: "action", action: selected.value };
}

export async function showDeviceSetup(options: DeviceSetupOptions): Promise<DeviceSetupResult> {
  while (true) {
    const target = await selectOne<"emulator" | "physical">({
      title: "SET UP YOUR FIRST ANDROID TARGET",
      options: [
        {
          value: "physical",
          label: "Physical Android device",
          description: "Connect a phone, tablet, foldable, watch, TV, car, or XR target.",
          recommended: true,
        },
        {
          value: "emulator",
          label: "Android emulator",
          description: "Use an existing Android Virtual Device on this computer.",
        },
      ],
      input: options.input,
      sink: options.sink,
      capabilities: options.capabilities,
      preamble: () =>
        intro(
          "ANDROID",
          "Choose how this project will reach its development target.",
          options.capabilities,
        ),
      escapeLabel: "home",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (target.kind !== "selected") return target;

    if (target.value === "emulator") {
      const result = await nextStep(
        options,
        "ANDROID EMULATOR",
        [
          "Open Android Studio, then open Device Manager.",
          "Start an existing Android Virtual Device and wait for its home screen.",
          "Continue here; ADB Ready will list and verify the running emulator.",
        ],
        "devices",
        "Verify running emulator",
      );
      if (result.kind === "back") continue;
      return result;
    }

    while (true) {
      const method = await selectOne<"usb" | "wireless">({
        title: "HOW SHOULD THIS DEVICE CONNECT?",
        options: [
          {
            value: "usb",
            label: "USB cable",
            description:
              "The most direct first connection; Android asks you to trust this computer.",
            recommended: true,
          },
          {
            value: "wireless",
            label: "Wireless debugging",
            description: "Pair Android 11 or newer over the same trusted network.",
          },
        ],
        input: options.input,
        sink: options.sink,
        capabilities: options.capabilities,
        preamble: () => [style.accent("DEVICE SETUP · PHYSICAL DEVICE", options.capabilities), ""],
        escapeLabel: "back",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (method.kind !== "selected") {
        if (method.kind === "cancelled" && method.reason === "escape") break;
        return method;
      }

      if (method.value === "usb") {
        const result = await nextStep(
          options,
          "USB",
          [
            "On Android, open Settings > About phone and tap Build number seven times. Manufacturer paths can vary; Settings search can find Build number.",
            "Open Developer options and enable USB debugging.",
            "Connect a data-capable USB cable, unlock the device, and approve the RSA trust prompt.",
          ],
          "devices",
          "Verify USB device",
        );
        if (result.kind === "back") continue;
        return result;
      }

      const wireless = await selectOne<"connect" | "pair">({
        title: "WIRELESS DEBUGGING",
        options: [
          {
            value: "pair",
            label: "Pair this computer",
            description: "Use Android's temporary six-digit pairing code.",
            recommended: true,
          },
          {
            value: "connect",
            label: "Connect an already paired device",
            description: "Discover and verify a device this computer already trusts.",
          },
        ],
        input: options.input,
        sink: options.sink,
        capabilities: options.capabilities,
        preamble: () =>
          guide(
            "WIRELESS",
            [
              "Keep the computer and Android device on the same trusted network.",
              "On Android 11 or newer, open Developer options > Wireless debugging and turn it on.",
            ],
            options.capabilities,
          ),
        escapeLabel: "back",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (wireless.kind !== "selected") {
        if (wireless.kind === "cancelled" && wireless.reason === "escape") continue;
        return wireless;
      }

      const result = await nextStep(
        options,
        wireless.value === "pair" ? "PAIR WIRELESSLY" : "CONNECT WIRELESSLY",
        wireless.value === "pair"
          ? [
              "In Wireless debugging, choose Pair device with pairing code.",
              "Keep that screen open. Its pairing address and six-digit code are temporary.",
              "Continue here; the code is read through a hidden prompt and is never placed in shell history.",
            ]
          : [
              "Keep Wireless debugging enabled and stay on the same trusted network.",
              "Return to the main Wireless debugging screen; its connection port normally differs from the pairing port.",
              "Continue here; ADB Ready will discover and verify the connected target.",
            ],
        wireless.value,
        wireless.value === "pair" ? "Start secure pairing" : "Find and connect device",
      );
      if (result.kind === "back") continue;
      return result;
    }
  }
}
