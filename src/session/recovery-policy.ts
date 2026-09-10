export interface RecoveryPolicy {
  enabled: boolean;
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  totalTimeoutMs: number;
}

export type RecoveryPolicyInput = Partial<RecoveryPolicy>;

export const DEFAULT_RECOVERY_POLICY: Readonly<RecoveryPolicy> = Object.freeze({
  enabled: true,
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 4_000,
  totalTimeoutMs: 30_000,
});

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

export function resolveRecoveryPolicy(input: RecoveryPolicyInput = {}): RecoveryPolicy {
  const policy = { ...DEFAULT_RECOVERY_POLICY, ...input };
  positiveInteger(policy.maxAttempts, "maxAttempts");
  positiveInteger(policy.initialDelayMs, "initialDelayMs");
  positiveInteger(policy.maxDelayMs, "maxDelayMs");
  positiveInteger(policy.totalTimeoutMs, "totalTimeoutMs");
  if (policy.maxDelayMs < policy.initialDelayMs) {
    throw new RangeError("maxDelayMs must be greater than or equal to initialDelayMs");
  }
  return policy;
}

export function recoveryDelayMs(policy: RecoveryPolicy, attempt: number): number {
  positiveInteger(attempt, "attempt");
  const exponent = Math.min(attempt - 1, 30);
  return Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** exponent);
}

export function recoveryAttemptAllowed(
  policy: RecoveryPolicy,
  attempt: number,
  elapsedMs: number,
): boolean {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new RangeError("elapsedMs must be a non-negative finite number");
  }
  return (
    policy.enabled &&
    attempt >= 1 &&
    attempt <= policy.maxAttempts &&
    elapsedMs < policy.totalTimeoutMs
  );
}
