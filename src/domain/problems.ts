import type { AdbDevice, AdbMdnsService } from "../adb/parsers.js";
import { redactText } from "../core/redaction.js";
import type { ProcessResult } from "../platform/process-runner.js";
import type { AndroidTarget } from "../target/model.js";
import type { TargetSelectionResult } from "../target/selection.js";
import type { Correlation, Evidence, Problem, SuggestedAction } from "./contracts.js";

export const ProblemCode = {
  AdbCommandFailed: "ADB_COMMAND_FAILED",
  AdbFeatureUnavailable: "ADB_FEATURE_UNAVAILABLE",
  AdbMdnsDisabled: "ADB_MDNS_DISABLED",
  AdbNotFound: "ADB_NOT_FOUND",
  AdbOptionalProbeFailed: "ADB_OPTIONAL_PROBE_FAILED",
  AdbServerUnavailable: "ADB_SERVER_UNAVAILABLE",
  AdbVersionMismatch: "ADB_VERSION_MISMATCH",
  AdbTimeout: "ADB_TIMEOUT",
  InteractiveSelectionUnavailable: "INTERACTIVE_SELECTION_UNAVAILABLE",
  MultipleTargets: "MULTIPLE_TARGETS",
  NoSelectableTarget: "NO_SELECTABLE_TARGET",
  NoTargets: "NO_TARGETS",
  OperationInterrupted: "OPERATION_INTERRUPTED",
  TargetSelectionCancelled: "TARGET_SELECTION_CANCELLED",
  TargetNoPermissions: "TARGET_NO_PERMISSIONS",
  TargetOffline: "TARGET_OFFLINE",
  TargetUnauthorized: "TARGET_UNAUTHORIZED",
  TargetUnknownState: "TARGET_UNKNOWN_STATE",
  TargetNotFound: "TARGET_NOT_FOUND",
  InvalidEndpoint: "INVALID_ENDPOINT",
  InvalidPairingCode: "INVALID_PAIRING_CODE",
  WirelessEndpointNotFound: "WIRELESS_ENDPOINT_NOT_FOUND",
  WirelessPairingRequired: "WIRELESS_PAIRING_REQUIRED",
  MultipleWirelessEndpoints: "MULTIPLE_WIRELESS_ENDPOINTS",
  WirelessConnectionFailed: "WIRELESS_CONNECTION_FAILED",
  WirelessPairingFailed: "WIRELESS_PAIRING_FAILED",
  DuplicateTargetTransport: "DUPLICATE_TARGET_TRANSPORT",
  UnstableTargetSerial: "UNSTABLE_TARGET_SERIAL",
  InvalidPort: "INVALID_PORT",
  PortMappingConflict: "PORT_MAPPING_CONFLICT",
  PortMappingVerificationFailed: "PORT_MAPPING_VERIFICATION_FAILED",
} as const;

function retryDevicesAction(): SuggestedAction {
  return {
    id: "retry_device_probe",
    title: "Check visible devices again",
    kind: "command",
    risk: "read-only",
    automatic: true,
    idempotent: true,
    command: { executable: "adb", args: ["devices", "-l"] },
  };
}

export function targetSelectionProblem(
  result: Exclude<TargetSelectionResult, { kind: "selected" }>,
  correlation: Correlation,
): Problem {
  if (result.kind === "ambiguous") {
    return {
      code: ProblemCode.MultipleTargets,
      category: "target.selection",
      severity: "error",
      summary: "Multiple ready Android targets require an explicit selection.",
      detail: "Choose one with --device, --transport-id, or the interactive --select picker.",
      retryable: true,
      evidence: [
        {
          source: "target.inventory",
          field: "serials",
          value: result.candidates.map(({ serial }) => serial),
        },
      ],
      actions: [],
      correlation,
    };
  }
  if (result.kind === "duplicate") {
    return {
      code: ProblemCode.DuplicateTargetTransport,
      category: "target.selection",
      severity: "error",
      summary: "The target serial identifies multiple ADB transports.",
      detail: "Select the intended transport explicitly with --transport-id.",
      retryable: true,
      evidence: [
        { source: "target.inventory", field: "serial", value: result.target.serial },
        {
          source: "target.inventory",
          field: "transportIds",
          value: result.transports.map(({ transportId }) => transportId ?? null),
        },
      ],
      actions: [],
      correlation,
    };
  }
  if (result.kind === "not-found") {
    return {
      code: ProblemCode.TargetNotFound,
      category: "target.selection",
      severity: "error",
      summary: "The requested Android target was not found.",
      detail:
        "Check the selector with adb-ready devices, then retry with an exact serial or alias.",
      retryable: true,
      evidence: [{ source: "target.selector", field: "value", value: result.selector }],
      actions: [],
      correlation,
    };
  }
  if (result.kind === "unavailable") {
    return {
      code: ProblemCode.NoSelectableTarget,
      category: "target.selection",
      severity: "error",
      summary: "The requested Android target is not ready.",
      detail: `ADB reports ${result.target.state}; recover or authorize the target before retrying.`,
      retryable: true,
      evidence: [
        { source: "target.inventory", field: "serial", value: result.target.serial },
        { source: "target.inventory", field: "state", value: result.target.state },
      ],
      actions: [retryDevicesAction()],
      correlation,
    };
  }
  return {
    code: ProblemCode.NoSelectableTarget,
    category: "target.selection",
    severity: "error",
    summary: "No ready Android target is available.",
    detail: "Connect a target, start an emulator, or enable Wireless debugging, then retry.",
    retryable: true,
    evidence: [],
    actions: [retryDevicesAction()],
    correlation,
  };
}

export function targetInventoryProblems(
  targets: readonly AndroidTarget[],
  correlation: Correlation,
): Problem[] {
  const problems: Problem[] = [];
  for (const target of targets) {
    const serialCounts = new Map<string, number>();
    for (const transport of target.transports) {
      serialCounts.set(transport.serial, (serialCounts.get(transport.serial) ?? 0) + 1);
      if (!transport.stable) {
        problems.push({
          code: ProblemCode.UnstableTargetSerial,
          category: "target.identity",
          severity: "warning",
          summary: "ADB reported an unstable target identifier.",
          detail: "A transient mDNS service name cannot be used as a reliable final device serial.",
          retryable: true,
          evidence: [{ source: "adb.devices", field: "serial", value: transport.serial }],
          actions: [retryDevicesAction()],
          correlation,
        });
      }
    }
    for (const [serial, count] of serialCounts) {
      if (count > 1) {
        problems.push({
          code: ProblemCode.DuplicateTargetTransport,
          category: "target.identity",
          severity: "warning",
          summary: "ADB reported duplicate transports for one serial.",
          detail: "Use an explicit transport ID for operations until the duplicate disappears.",
          retryable: true,
          evidence: [
            { source: "adb.devices", field: "serial", value: serial },
            { source: "adb.devices", field: "count", value: count },
          ],
          actions: [retryDevicesAction()],
          correlation,
        });
      }
    }
  }
  return problems;
}

export function adbNotFoundProblem(correlation: Correlation, requestedPath?: string): Problem {
  return {
    code: ProblemCode.AdbNotFound,
    category: "environment.executable",
    severity: "error",
    summary: "ADB was not found.",
    detail:
      requestedPath === undefined
        ? "Install Android SDK Platform-Tools or provide an explicit ADB path."
        : `The configured ADB executable could not be used: ${requestedPath}`,
    retryable: true,
    evidence:
      requestedPath === undefined
        ? []
        : [{ source: "configuration", field: "adb.path", value: requestedPath }],
    actions: [
      {
        id: "configure_adb_path",
        title: "Provide the ADB executable with --adb PATH",
        kind: "user",
        risk: "none",
        automatic: false,
      },
    ],
    correlation,
  };
}

function processEvidence(result: ProcessResult): Evidence[] {
  const redactedStderr = redactText(result.stderr.trim());
  const redactedStdout = redactText(result.stdout.trim());
  return [
    { source: "process", field: "exitCode", value: result.exitCode },
    { source: "process", field: "signal", value: result.signal },
    { source: "process", field: "timedOut", value: result.timedOut },
    ...(redactedStderr.value === ""
      ? []
      : [
          {
            source: "process",
            field: "stderr",
            value: redactedStderr.value.slice(0, 2_000),
            redacted: redactedStderr.replacements > 0,
          } satisfies Evidence,
        ]),
    ...(redactedStdout.value === ""
      ? []
      : [
          {
            source: "process",
            field: "stdout",
            value: redactedStdout.value.slice(0, 2_000),
            redacted: redactedStdout.replacements > 0,
          } satisfies Evidence,
        ]),
  ];
}

function manualServerRestartAction(title: string): SuggestedAction {
  return {
    id: "review_adb_server_restart",
    title,
    kind: "user",
    risk: "shared-global",
    automatic: false,
  };
}

function unquoted(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

function versionCore(value: string | undefined): string | undefined {
  return unquoted(value)?.match(/^\d+\.\d+\.\d+/u)?.[0];
}

export function problemsForServerStatus(
  status: Readonly<Record<string, string>>,
  clientVersion: string | undefined,
  correlation: Correlation,
): Problem[] {
  const problems: Problem[] = [];
  const mdnsEnabled = unquoted(status.mdns_enabled)?.toLowerCase();
  if (mdnsEnabled === "false") {
    problems.push({
      code: ProblemCode.AdbMdnsDisabled,
      category: "adb.discovery",
      severity: "warning",
      summary: "ADB network discovery is disabled.",
      detail:
        "Explicit wireless endpoints can still work, but automatic mDNS discovery is unavailable.",
      retryable: true,
      evidence: [{ source: "adb.server-status", field: "mdns_enabled", value: false }],
      actions: [
        manualServerRestartAction(
          "Enable ADB mDNS and restart the shared ADB server when it is safe",
        ),
      ],
      correlation,
    });
  }

  const clientCore = versionCore(clientVersion);
  const serverCore = versionCore(status.version);
  if (clientCore !== undefined && serverCore !== undefined && clientCore !== serverCore) {
    problems.push({
      code: ProblemCode.AdbVersionMismatch,
      category: "adb.server",
      severity: "warning",
      summary: "The ADB client and running server use different versions.",
      detail:
        "Mixed Platform-Tools versions can expose different capabilities and make diagnostics inconsistent.",
      retryable: true,
      evidence: [
        { source: "adb.client", field: "version", value: clientCore },
        { source: "adb.server-status", field: "version", value: serverCore },
      ],
      actions: [
        manualServerRestartAction(
          "Align Platform-Tools versions and restart the shared ADB server when it is safe",
        ),
      ],
      correlation,
    });
  }
  return problems;
}

export function adbProcessProblem(
  operation: string,
  result: ProcessResult,
  correlation: Correlation,
): Problem {
  if (result.spawnError?.code === "ENOENT") {
    return adbNotFoundProblem(correlation, result.executable);
  }

  if (result.aborted) {
    return {
      code: ProblemCode.OperationInterrupted,
      category: "process.interrupted",
      severity: "error",
      summary: `ADB ${operation} was interrupted.`,
      detail: "The operation stopped after receiving an interruption request.",
      retryable: true,
      evidence: processEvidence(result),
      actions: [],
      correlation,
    };
  }

  if (result.timedOut) {
    return {
      code: ProblemCode.AdbTimeout,
      category: "adb.timeout",
      severity: "error",
      summary: `ADB ${operation} timed out.`,
      detail: "The operation did not finish within the configured timeout.",
      retryable: true,
      evidence: processEvidence(result),
      actions: [retryDevicesAction()],
      correlation,
    };
  }

  const combinedOutput = `${result.stderr}\n${result.stdout}`;
  if (
    /(?:unknown|unrecognized)\s+(?:command|option)\b|(?:command|option)\s+.+\s+is not supported\b/iu.test(
      combinedOutput,
    )
  ) {
    return {
      code: ProblemCode.AdbFeatureUnavailable,
      category: "environment.compatibility",
      severity: "error",
      summary: `The installed ADB does not support ${operation}.`,
      detail: "Update Android SDK Platform-Tools, then retry the requested operation.",
      retryable: true,
      evidence: processEvidence(result),
      actions: [
        {
          id: "update_platform_tools",
          title: "Update Android SDK Platform-Tools",
          kind: "user",
          risk: "local-additive",
          automatic: false,
        },
      ],
      correlation,
    };
  }

  const daemonUnavailable = /cannot connect to daemon|failed to start daemon|server.*failed/iu.test(
    result.stderr,
  );
  return {
    code: daemonUnavailable ? ProblemCode.AdbServerUnavailable : ProblemCode.AdbCommandFailed,
    category: daemonUnavailable ? "adb.server" : "adb.operation",
    severity: "error",
    summary: daemonUnavailable ? "The ADB server is unavailable." : `ADB ${operation} failed.`,
    detail: daemonUnavailable
      ? "ADB Ready could not communicate with the configured ADB server."
      : "ADB returned an unsuccessful result for this operation.",
    retryable: true,
    evidence: processEvidence(result),
    actions: [retryDevicesAction()],
    correlation,
  };
}

export function adbOptionalProbeProblem(
  operation: string,
  result: ProcessResult,
  correlation: Correlation,
): Problem {
  const failure = adbProcessProblem(operation, result, correlation);

  return {
    ...failure,
    code: ProblemCode.AdbOptionalProbeFailed,
    category: "adb.capability",
    severity: "warning",
    summary: `Optional ADB ${operation} probe failed.`,
    detail:
      "Core diagnostics can continue, but this ADB capability could not be inspected reliably.",
  };
}

function targetEvidence(device: AdbDevice): Evidence[] {
  return [
    { source: "adb.devices", field: "serial", value: device.serial },
    { source: "adb.devices", field: "state", value: device.state },
  ];
}

export function problemsForDevices(
  devices: readonly AdbDevice[],
  correlation: Correlation,
  severity: Problem["severity"] = "error",
): Problem[] {
  const problems: Problem[] = [];

  for (const device of devices) {
    if (device.state === "unauthorized") {
      problems.push({
        code: ProblemCode.TargetUnauthorized,
        category: "target.authorization",
        severity,
        summary: "An Android target has not authorized this computer.",
        detail: "Accept the RSA authorization prompt on the target, then retry the probe.",
        retryable: true,
        evidence: targetEvidence(device),
        actions: [
          {
            id: "accept_device_prompt",
            title: "Accept the RSA prompt on the Android target",
            kind: "user",
            risk: "none",
            automatic: false,
          },
          retryDevicesAction(),
        ],
        correlation,
      });
    } else if (device.state === "offline") {
      problems.push({
        code: ProblemCode.TargetOffline,
        category: "target.transport",
        severity,
        summary: "An Android target is offline.",
        detail: "ADB knows this transport, but it cannot currently communicate with the target.",
        retryable: true,
        evidence: targetEvidence(device),
        actions: [retryDevicesAction()],
        correlation,
      });
    } else if (device.state === "no-permissions") {
      problems.push({
        code: ProblemCode.TargetNoPermissions,
        category: "target.permissions",
        severity,
        summary: "The host does not have permission to use an Android target.",
        detail: "Check the host USB permissions and Android developer authorization setup.",
        retryable: true,
        evidence: targetEvidence(device),
        actions: [
          {
            id: "review_usb_permissions",
            title: "Review host USB permission setup",
            kind: "documentation",
            risk: "none",
            automatic: false,
          },
        ],
        correlation,
      });
    } else if (device.state === "unknown") {
      problems.push({
        code: ProblemCode.TargetUnknownState,
        category: "target.state",
        severity: "warning",
        summary: "ADB reported an unknown target state.",
        detail: "The target remains visible, but ADB Ready will not assume it is usable.",
        retryable: true,
        evidence: targetEvidence(device),
        actions: [retryDevicesAction()],
        correlation,
      });
    }
  }

  return problems;
}

export function noTargetsProblem(
  correlation: Correlation,
  discoveredServices: readonly AdbMdnsService[] = [],
): Problem {
  const connectEndpoints = [
    ...new Set(
      discoveredServices
        .filter(
          ({ knownDevice, serviceType }) =>
            serviceType === "legacy" || (serviceType === "connect" && knownDevice !== false),
        )
        .map(({ endpoint }) => endpoint.serial),
    ),
  ].sort();
  const oneEndpoint = connectEndpoints.length === 1 ? connectEndpoints[0] : undefined;
  const pairingEndpoints = [
    ...new Set(
      discoveredServices
        .filter(({ serviceType }) => serviceType === "pairing")
        .map(({ endpoint }) => endpoint.serial),
    ),
  ].sort();
  const onePairingEndpoint =
    connectEndpoints.length === 0 && pairingEndpoints.length === 1
      ? pairingEndpoints[0]
      : undefined;
  return {
    code: ProblemCode.NoTargets,
    category: "target.selection",
    severity: "warning",
    summary:
      discoveredServices.length === 0
        ? "No Android targets are visible."
        : "Wireless Android services are visible, but no target is connected.",
    detail:
      discoveredServices.length === 0
        ? "Connect a target over USB, start an emulator, or enable Wireless debugging."
        : oneEndpoint !== undefined
          ? `Run adb-ready connect ${oneEndpoint} to establish and verify the target.`
          : onePairingEndpoint !== undefined
            ? `Run adb-ready pair ${onePairingEndpoint}, then connect the verified target.`
            : "Choose the matching wireless service, or connect a target over USB.",
    retryable: true,
    evidence: [
      { source: "adb.devices", field: "count", value: 0 },
      ...(discoveredServices.length === 0
        ? []
        : [
            {
              source: "adb.mdns",
              field: "services",
              value: discoveredServices.map(({ endpoint, serviceType }) => ({
                endpoint: endpoint.serial,
                serviceType,
              })),
            } satisfies Evidence,
          ]),
    ],
    actions:
      oneEndpoint !== undefined
        ? [
            {
              id: "connect_discovered_target",
              title: `Connect ${oneEndpoint}`,
              kind: "command",
              risk: "local-additive",
              automatic: false,
              idempotent: true,
              command: { executable: "adb-ready", args: ["connect", oneEndpoint] },
            },
          ]
        : onePairingEndpoint !== undefined
          ? [
              {
                id: "pair_discovered_target",
                title: `Pair ${onePairingEndpoint}`,
                kind: "command",
                risk: "device-reversible",
                automatic: false,
                idempotent: false,
                command: { executable: "adb-ready", args: ["pair", onePairingEndpoint] },
              },
            ]
          : [retryDevicesAction()],
    correlation,
  };
}

export function multipleTargetsProblem(
  devices: readonly AdbDevice[],
  correlation: Correlation,
): Problem {
  return {
    code: ProblemCode.MultipleTargets,
    category: "target.selection",
    severity: "error",
    summary: "Multiple Android targets require an explicit selection.",
    detail: "Choose one interactively or provide an explicit target selector.",
    retryable: true,
    evidence: [
      { source: "adb.devices", field: "serials", value: devices.map(({ serial }) => serial) },
    ],
    actions: [
      {
        id: "select_target",
        title: "Select one Android target",
        kind: "user",
        risk: "none",
        automatic: false,
      },
    ],
    correlation,
  };
}
