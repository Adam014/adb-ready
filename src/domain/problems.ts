import type { AdbDevice } from "../adb/parsers.js";
import { redactText } from "../core/redaction.js";
import type { ProcessResult } from "../platform/process-runner.js";
import type { TargetSelectionResult } from "../target/selection.js";
import type { Correlation, Evidence, Problem, SuggestedAction } from "./contracts.js";

export const ProblemCode = {
  AdbCommandFailed: "ADB_COMMAND_FAILED",
  AdbNotFound: "ADB_NOT_FOUND",
  AdbOptionalProbeFailed: "ADB_OPTIONAL_PROBE_FAILED",
  AdbServerUnavailable: "ADB_SERVER_UNAVAILABLE",
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
  MultipleWirelessEndpoints: "MULTIPLE_WIRELESS_ENDPOINTS",
  WirelessConnectionFailed: "WIRELESS_CONNECTION_FAILED",
  WirelessPairingFailed: "WIRELESS_PAIRING_FAILED",
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
  const redacted = redactText(result.stderr.trim());
  return [
    { source: "process", field: "exitCode", value: result.exitCode },
    { source: "process", field: "signal", value: result.signal },
    { source: "process", field: "timedOut", value: result.timedOut },
    ...(redacted.value === ""
      ? []
      : [
          {
            source: "process",
            field: "stderr",
            value: redacted.value.slice(0, 2_000),
            redacted: redacted.replacements > 0,
          } satisfies Evidence,
        ]),
  ];
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

export function noTargetsProblem(correlation: Correlation): Problem {
  return {
    code: ProblemCode.NoTargets,
    category: "target.selection",
    severity: "warning",
    summary: "No Android targets are visible.",
    detail: "Connect a target over USB, start an emulator, or enable Wireless debugging.",
    retryable: true,
    evidence: [{ source: "adb.devices", field: "count", value: 0 }],
    actions: [retryDevicesAction()],
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
