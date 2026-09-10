export type SessionState =
  | "acquiring-target"
  | "attaching-child"
  | "degraded"
  | "ended"
  | "failed"
  | "planning"
  | "preparing-ports"
  | "ready"
  | "recovering"
  | "starting-child"
  | "stopping";

export interface SessionTransition {
  from: SessionState;
  to: SessionState;
  reason: string;
  timestamp: string;
}

const ALLOWED_TRANSITIONS: Readonly<Record<SessionState, ReadonlySet<SessionState>>> = {
  planning: new Set(["acquiring-target", "failed", "stopping"]),
  "acquiring-target": new Set(["preparing-ports", "failed", "stopping"]),
  "preparing-ports": new Set(["attaching-child", "starting-child", "failed", "stopping"]),
  "starting-child": new Set(["ready", "failed", "stopping"]),
  "attaching-child": new Set(["ready", "failed", "stopping"]),
  ready: new Set(["degraded", "failed", "stopping"]),
  degraded: new Set(["recovering", "failed", "stopping"]),
  recovering: new Set(["ready", "degraded", "failed", "stopping"]),
  failed: new Set(["stopping", "ended"]),
  stopping: new Set(["ended"]),
  ended: new Set(),
};

export class SessionStateMachine {
  readonly #clock: () => Date;
  readonly #history: SessionTransition[] = [];
  #state: SessionState = "planning";

  constructor(clock: () => Date = () => new Date()) {
    this.#clock = clock;
  }

  get state(): SessionState {
    return this.#state;
  }

  get history(): readonly SessionTransition[] {
    return this.#history.map((transition) => ({ ...transition }));
  }

  canTransition(to: SessionState): boolean {
    return ALLOWED_TRANSITIONS[this.#state].has(to);
  }

  transition(to: SessionState, reason: string): SessionTransition {
    const normalizedReason = reason.trim();
    if (normalizedReason === "") {
      throw new RangeError("A session transition requires a reason");
    }
    if (!this.canTransition(to)) {
      throw new Error(`Invalid session transition: ${this.#state} -> ${to}`);
    }
    const transition: SessionTransition = {
      from: this.#state,
      to,
      reason: normalizedReason,
      timestamp: this.#clock().toISOString(),
    };
    this.#state = to;
    this.#history.push(transition);
    return { ...transition };
  }
}
