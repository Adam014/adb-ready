import { randomUUID } from "node:crypto";
import {
  type CompiledContext,
  type ContextCompilerOptions,
  compileSessionContext,
} from "../ai/context-compiler.js";
import type { AdbReadyEvent, Problem, ResultEnvelope } from "../domain/contracts.js";
import { ExitCode, SCHEMA_VERSION } from "../domain/contracts.js";
import {
  listSessions,
  readSession,
  readSessionEvents,
  type SessionManifest,
  type SessionStoreOptions,
  type StoredProblem,
} from "../state/session-store.js";

export type SessionCommandAction = "events" | "list" | "show";

export type SessionCommandData =
  | {
      action: "list";
      sessions: SessionManifest[];
      total: number;
      nextCursor?: string;
    }
  | { action: "show"; session: SessionManifest }
  | { action: "events"; session: SessionManifest; events: AdbReadyEvent[] };

export interface ProblemsCommandData {
  sessionId: string;
  status: SessionManifest["status"];
  problems: StoredProblem[];
}

export interface ContextCommandData extends CompiledContext {
  sessionId: string;
  status: SessionManifest["status"];
}

export interface SessionCommandDependencies {
  clock?: () => Date;
  idFactory?: () => string;
}

export interface SessionListFilter {
  status?: SessionManifest["status"];
  preset?: string;
  sinceMs?: number;
  limit?: number;
  cursor?: string;
}

export interface SessionCommandExecution<T> {
  result: ResultEnvelope<T>;
  exitCode: number;
}

function storageProblem(code: string, summary: string, detail: string, commandId: string): Problem {
  return {
    code,
    category: "state.session-history",
    severity: "error",
    summary,
    detail,
    retryable: true,
    evidence: [],
    actions: [],
    correlation: { commandId },
  };
}

function execution<T>(
  command: string,
  data: T | null,
  problems: Problem[],
  dependencies: SessionCommandDependencies,
): SessionCommandExecution<T> {
  const now = (dependencies.clock ?? (() => new Date()))();
  const ok = problems.every(({ severity }) => severity !== "error");
  return {
    exitCode: ok ? ExitCode.Success : ExitCode.Environment,
    result: {
      schemaVersion: SCHEMA_VERSION,
      command,
      commandId: (dependencies.idFactory ?? randomUUID)(),
      ok,
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      durationMs: 0,
      data,
      problems,
    },
  };
}

async function resolveManifest(
  sessionId: string | undefined,
  options: SessionStoreOptions,
): Promise<
  | { ok: true; manifest: SessionManifest }
  | { ok: false; code: string; summary: string; detail: string }
> {
  if (sessionId !== undefined) {
    const stored = await readSession(sessionId, options);
    return stored.ok
      ? { ok: true, manifest: stored.value }
      : {
          ok: false,
          code: stored.code,
          summary: "The requested session is unavailable.",
          detail: stored.message,
        };
  }
  const listed = await listSessions(options);
  if (!listed.ok) {
    return {
      ok: false,
      code: listed.code,
      summary: "Session history is unavailable.",
      detail: listed.message,
    };
  }
  const latest = listed.value[0];
  return latest === undefined
    ? {
        ok: false,
        code: "SESSION_NOT_FOUND",
        summary: "No saved development session exists yet.",
        detail: "Run adb-ready dev first, then inspect the latest session.",
      }
    : { ok: true, manifest: latest };
}

export async function runSessionCommand(
  action: SessionCommandAction,
  sessionId: string | undefined,
  options: SessionStoreOptions = {},
  dependencies: SessionCommandDependencies = {},
  filter: SessionListFilter = {},
): Promise<SessionCommandExecution<SessionCommandData>> {
  const command = `sessions ${action}`;
  if (action === "list") {
    const listed = await listSessions(options);
    const now = (dependencies.clock ?? (() => new Date()))().getTime();
    const cutoff = filter.sinceMs === undefined ? undefined : now - filter.sinceMs;
    const matching = listed.ok
      ? listed.value
          .filter((session) => filter.status === undefined || session.status === filter.status)
          .filter((session) => filter.preset === undefined || session.preset === filter.preset)
          .filter((session) => cutoff === undefined || Date.parse(session.updatedAt) >= cutoff)
      : [];
    const cursorIndex =
      filter.cursor === undefined
        ? -1
        : matching.findIndex(({ sessionId }) => sessionId === filter.cursor);
    if (listed.ok && filter.cursor !== undefined && cursorIndex === -1) {
      return execution<SessionCommandData>(
        command,
        null,
        [
          storageProblem(
            "SESSION_CURSOR_INVALID",
            "The session page cursor is no longer available.",
            "Start a new listing without a cursor.",
            "session-history",
          ),
        ],
        dependencies,
      );
    }
    const remaining = matching.slice(cursorIndex + 1);
    const sessions = filter.limit === undefined ? remaining : remaining.slice(0, filter.limit);
    const hasMore = sessions.length < remaining.length;
    const nextCursor = hasMore ? sessions.at(-1)?.sessionId : undefined;
    return listed.ok
      ? execution(
          command,
          {
            action,
            sessions,
            total: matching.length,
            ...(nextCursor === undefined ? {} : { nextCursor }),
          },
          [],
          dependencies,
        )
      : execution<SessionCommandData>(
          command,
          null,
          [
            storageProblem(
              listed.code,
              "Session history is unavailable.",
              listed.message,
              "session-history",
            ),
          ],
          dependencies,
        );
  }
  const resolved = await resolveManifest(sessionId, options);
  if (!resolved.ok) {
    return execution<SessionCommandData>(
      command,
      null,
      [storageProblem(resolved.code, resolved.summary, resolved.detail, "session-history")],
      dependencies,
    );
  }
  if (action === "show") {
    return execution(command, { action, session: resolved.manifest }, [], dependencies);
  }
  const events = await readSessionEvents(resolved.manifest.sessionId, options);
  return events.ok
    ? execution(
        command,
        { action, session: resolved.manifest, events: events.value },
        [],
        dependencies,
      )
    : execution<SessionCommandData>(
        command,
        null,
        [
          storageProblem(
            events.code,
            "The requested session events are unavailable.",
            events.message,
            "session-history",
          ),
        ],
        dependencies,
      );
}

export async function runProblemsCommand(
  sessionId: string | undefined,
  options: SessionStoreOptions = {},
  dependencies: SessionCommandDependencies = {},
): Promise<SessionCommandExecution<ProblemsCommandData>> {
  const resolved = await resolveManifest(sessionId, options);
  if (!resolved.ok) {
    return execution<ProblemsCommandData>(
      "problems",
      null,
      [storageProblem(resolved.code, resolved.summary, resolved.detail, "session-problems")],
      dependencies,
    );
  }
  return execution(
    "problems",
    {
      sessionId: resolved.manifest.sessionId,
      status: resolved.manifest.status,
      problems: resolved.manifest.problems,
    },
    [],
    dependencies,
  );
}

export async function runContextCommand(
  sessionId: string | undefined,
  characterBudget: number | undefined,
  options: SessionStoreOptions = {},
  dependencies: SessionCommandDependencies = {},
  compilerOptions: Omit<ContextCompilerOptions, "characterBudget"> = {},
): Promise<SessionCommandExecution<ContextCommandData>> {
  const resolved = await resolveManifest(sessionId, options);
  if (!resolved.ok) {
    return execution<ContextCommandData>(
      "context",
      null,
      [storageProblem(resolved.code, resolved.summary, resolved.detail, "session-context")],
      dependencies,
    );
  }
  const events = await readSessionEvents(resolved.manifest.sessionId, options);
  if (!events.ok) {
    return execution<ContextCommandData>(
      "context",
      null,
      [
        storageProblem(
          events.code,
          "The requested session events are unavailable.",
          events.message,
          "session-context",
        ),
      ],
      dependencies,
    );
  }
  const compiled = compileSessionContext(resolved.manifest, events.value, {
    ...(characterBudget === undefined ? {} : { characterBudget }),
    ...compilerOptions,
  });
  return execution(
    "context",
    {
      sessionId: resolved.manifest.sessionId,
      status: resolved.manifest.status,
      ...compiled,
    },
    [],
    dependencies,
  );
}
