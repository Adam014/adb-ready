export const SCHEMA_VERSION = 1 as const;

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Severity = "debug" | "info" | "warning" | "error";

export interface Correlation {
  commandId: string;
  operationId?: string;
  targetId?: string;
}

export interface AdbReadyEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  sequence: number;
  timestamp: string;
  type: string;
  source: string;
  severity: Severity;
  message: string;
  correlation: Correlation;
  data?: Record<string, JsonValue>;
}

export type Risk =
  | "none"
  | "read-only"
  | "local-additive"
  | "device-reversible"
  | "shared-global"
  | "destructive"
  | "open-world";

export interface Evidence {
  source: string;
  field?: string;
  value: JsonValue;
  redacted?: boolean;
}

export interface SuggestedAction {
  id: string;
  title: string;
  kind: "command" | "user" | "documentation";
  risk: Risk;
  automatic: boolean;
  idempotent?: boolean;
  command?: {
    executable: string;
    args: string[];
  };
}

export interface Problem {
  code: string;
  category: string;
  severity: Extract<Severity, "warning" | "error">;
  summary: string;
  detail: string;
  retryable: boolean;
  evidence: Evidence[];
  actions: SuggestedAction[];
  correlation: Correlation;
}

export interface OperationPlanStep {
  id: string;
  title: string;
  risk: Risk;
  executable?: string;
  args?: string[];
}

export interface OperationPlan {
  schemaVersion: typeof SCHEMA_VERSION;
  dryRun: boolean;
  steps: OperationPlanStep[];
}

export interface TargetReference {
  id: string;
  serial: string;
  state: string;
  transport: "emulator" | "tcp" | "tls-mdns" | "usb" | "unknown";
}

export interface ResultEnvelope<T = JsonValue> {
  schemaVersion: typeof SCHEMA_VERSION;
  command: string;
  commandId: string;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  data: T | null;
  problems: Problem[];
}

export enum ExitCode {
  Success = 0,
  InvalidInput = 2,
  Environment = 10,
  Target = 20,
  AdbOperation = 30,
  ChildProcess = 40,
  Interrupted = 130,
  Internal = 70,
}
