/**
 * Cap SessionGoalRow helpers for Lynx.
 * Goal payload lives on session.metadata.openchamber.goal (Cap sessionGoalMetadata).
 * Pause/resume/set/clear patch session metadata via GET + PATCH /session/:id.
 * Objective file via Cap /api/goals/objective/:id. Never fake-success when runtime/HTTP is missing.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';

export type LynxSessionGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'budgetLimited'
  | 'complete';

const SESSION_GOAL_STATUSES: LynxSessionGoalStatus[] = [
  'active',
  'paused',
  'blocked',
  'budgetLimited',
  'complete',
];

export const SESSION_GOAL_OBJECTIVE_CHAR_LIMIT = 5000;

export type LynxSessionGoalPayload = {
  id: string;
  objective: string;
  objectiveFile: boolean;
  status: LynxSessionGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  turnsUsed: number;
  blockedStreak: number;
  note: string;
  statusReason: string;
  lastAccountedMessageID: string;
  createdAt: number;
  updatedAt: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isGoalStatus = (value: unknown): value is LynxSessionGoalStatus =>
  typeof value === 'string' && (SESSION_GOAL_STATUSES as string[]).includes(value);

/** Cap getSessionGoal — parse metadata.openchamber.goal from a session record. */
export function parseLynxSessionGoal(session: unknown): LynxSessionGoalPayload | null {
  if (!isRecord(session)) return null;
  const metadata = session.metadata;
  if (!isRecord(metadata)) return null;
  const namespace = metadata.openchamber;
  if (!isRecord(namespace)) return null;
  const goal = namespace.goal;
  if (!isRecord(goal)) return null;

  const id = typeof goal.id === 'string' ? goal.id : '';
  const objective = typeof goal.objective === 'string' ? goal.objective.trim() : '';
  const objectiveFile = goal.objectiveFile === true;
  if (!id || (!objective && !objectiveFile) || !isGoalStatus(goal.status)) return null;

  const tokenBudget = typeof goal.tokenBudget === 'number'
    && Number.isFinite(goal.tokenBudget)
    && goal.tokenBudget > 0
    ? Math.floor(goal.tokenBudget)
    : null;
  const asCount = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

  return {
    id,
    objective: objective.slice(0, SESSION_GOAL_OBJECTIVE_CHAR_LIMIT),
    objectiveFile,
    status: goal.status,
    tokenBudget,
    tokensUsed: asCount(goal.tokensUsed),
    turnsUsed: asCount(goal.turnsUsed),
    blockedStreak: asCount(goal.blockedStreak),
    note: typeof goal.note === 'string' ? goal.note : '',
    statusReason: typeof goal.statusReason === 'string' ? goal.statusReason : '',
    lastAccountedMessageID: typeof goal.lastAccountedMessageID === 'string'
      ? goal.lastAccountedMessageID
      : '',
    createdAt: typeof goal.createdAt === 'number' ? goal.createdAt : 0,
    updatedAt: typeof goal.updatedAt === 'number' ? goal.updatedAt : 0,
  };
}

/** Cap formatGoalTokens. */
export function formatLynxGoalTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count >= 1_000_000_000) {
    const value = count / 1_000_000_000;
    return `${value >= 10 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')}B`;
  }
  if (count >= 1_000_000) {
    const value = count / 1_000_000;
    return `${value >= 10 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (count >= 1_000) {
    const value = count / 1_000;
    return `${value >= 10 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')}K`;
  }
  return String(Math.floor(count));
}

/** Cap formatGoalDuration. */
export function formatLynxGoalDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${totalMinutes}m${seconds}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
}

export const lynxSessionGoalStatusLabelKey: Record<LynxSessionGoalStatus, string> = {
  active: 'lynx.chat.goal.status.active',
  paused: 'lynx.chat.goal.status.paused',
  blocked: 'lynx.chat.goal.status.blocked',
  budgetLimited: 'lynx.chat.goal.status.budgetLimited',
  complete: 'lynx.chat.goal.status.complete',
};

/** Cap sessionGoalStatusColor — CSS vars Cap themes already expose. */
export const lynxSessionGoalStatusColor: Record<LynxSessionGoalStatus, string> = {
  // Plain hex — Android Lynx drops inline style values containing var(...).
  active: '#4387be',
  paused: '#878580',
  blocked: '#d0a215',
  budgetLimited: '#d0a215',
  complete: '#66800B',
};

export type LynxGoalPauseResume =
  | { kind: 'pause'; next: 'paused' }
  | { kind: 'resume'; next: 'active' }
  | null;

export function lynxGoalPauseResumeAction(status: LynxSessionGoalStatus): LynxGoalPauseResume {
  if (status === 'active') return { kind: 'pause', next: 'paused' };
  if (status === 'paused' || status === 'blocked' || status === 'budgetLimited') {
    return { kind: 'resume', next: 'active' };
  }
  return null;
}

export function lynxGoalElapsedMs(
  goal: LynxSessionGoalPayload,
  now: number,
): number {
  const end = goal.status === 'complete'
    || goal.status === 'blocked'
    || goal.status === 'budgetLimited'
    ? goal.updatedAt
    : now;
  return Math.max(0, end - (goal.createdAt || now));
}

export function lynxGoalTokensLabel(goal: LynxSessionGoalPayload): string | null {
  if (goal.tokenBudget) {
    return `${formatLynxGoalTokens(goal.tokensUsed)}/${formatLynxGoalTokens(goal.tokenBudget)}`;
  }
  return goal.tokensUsed > 0 ? formatLynxGoalTokens(goal.tokensUsed) : null;
}

export function lynxGoalTitleText(
  goal: LynxSessionGoalPayload,
  objectiveContent: string | null,
): string {
  return (goal.note || objectiveContent || goal.objective || '').trim();
}

const directoryQuery = (directory?: string | null): string => {
  const value = directory?.trim();
  return value ? `?directory=${encodeURIComponent(value)}` : '';
};

export type LynxSessionGoalFetchResult =
  | { status: 'ok'; goal: LynxSessionGoalPayload | null; session: unknown }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: string; httpStatus: number };

export async function fetchLynxSessionGoal(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { sessionId: string; directory?: string | null },
): Promise<LynxSessionGoalFetchResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    return { status: 'failed', error: 'session id required', httpStatus: 0 };
  }
  try {
    const response = await runtimeFetch(
      `/session/${encodeURIComponent(sessionId)}${directoryQuery(input.directory)}`,
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: `session.get failed (${response.status})`,
        httpStatus: response.status,
      };
    }
    const session = await response.json().catch(() => null);
    return { status: 'ok', goal: parseLynxSessionGoal(session), session };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}

export type LynxGoalObjectiveFetchResult =
  | { status: 'ok'; content: string | null }
  | { status: 'no-runtime' }
  | { status: 'unavailable' };

/** Cap GET /api/goals/objective/:sessionId — null/unavailable is honest, not failure toast. */
export async function fetchLynxGoalObjectiveContent(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  sessionId: string,
): Promise<LynxGoalObjectiveFetchResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const id = sessionId.trim();
  if (!id) return { status: 'unavailable' };
  try {
    const response = await runtimeFetch(`/api/goals/objective/${encodeURIComponent(id)}`);
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) return { status: 'unavailable' };
    const parsed = await response.json().catch(() => null) as { content?: unknown } | null;
    return {
      status: 'ok',
      content: typeof parsed?.content === 'string' ? parsed.content : null,
    };
  } catch {
    return { status: 'unavailable' };
  }
}

export type LynxSessionGoalStatusResult =
  | { status: 'ok' }
  | { status: 'no-runtime' }
  | { status: 'unavailable'; error: string }
  | { status: 'failed'; error: string; httpStatus: number };

/**
 * Cap setSessionGoalStatus via GET session + PATCH metadata.openchamber.goal.
 * Never invents success when the session/goal is missing.
 */
export async function setLynxSessionGoalStatus(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: {
    sessionId: string;
    directory?: string | null;
    nextStatus: Extract<LynxSessionGoalStatus, 'active' | 'paused' | 'complete'>;
    /** When pausing, Cap also aborts the current turn — caller may call abortSession. */
  },
): Promise<LynxSessionGoalStatusResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    return { status: 'failed', error: 'session id required', httpStatus: 0 };
  }
  try {
    const getResponse = await runtimeFetch(
      `/session/${encodeURIComponent(sessionId)}${directoryQuery(input.directory)}`,
    );
    if (getResponse.status === 0) return { status: 'no-runtime' };
    if (!getResponse.ok) {
      return {
        status: 'failed',
        error: `session.get failed (${getResponse.status})`,
        httpStatus: getResponse.status,
      };
    }
    const session = await getResponse.json().catch(() => null);
    if (!isRecord(session)) {
      return { status: 'unavailable', error: 'session payload missing' };
    }
    const metadata = isRecord(session.metadata) ? { ...session.metadata } : {};
    const openchamber = isRecord(metadata.openchamber)
      ? { ...metadata.openchamber }
      : {};
    const currentGoal = isRecord(openchamber.goal) ? { ...openchamber.goal } : null;
    if (!currentGoal) {
      return { status: 'unavailable', error: 'no session goal on metadata' };
    }
    const now = Date.now();
    openchamber.goal = {
      ...currentGoal,
      status: input.nextStatus,
      statusReason: input.nextStatus === 'active'
        ? 'resumed'
        : (input.nextStatus === 'complete' ? 'marked by user' : ''),
      blockedStreak: 0,
      ...(input.nextStatus === 'active' ? { turnsUsed: 0 } : {}),
      updatedAt: now,
    };
    metadata.openchamber = openchamber;

    const patchResponse = await runtimeFetch(
      `/session/${encodeURIComponent(sessionId)}${directoryQuery(input.directory)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata }),
      },
    );
    if (patchResponse.status === 0) return { status: 'no-runtime' };
    if (!patchResponse.ok) {
      return {
        status: 'failed',
        error: `session.patch goal failed (${patchResponse.status})`,
        httpStatus: patchResponse.status,
      };
    }
    return { status: 'ok' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}


export type LynxSetSessionGoalInput = {
  objective: string;
  tokenBudget: number | null;
};

export type LynxSessionGoalWriteResult =
  | { status: 'ok'; goal: LynxSessionGoalPayload }
  | { status: 'no-runtime' }
  | { status: 'unavailable'; error: string }
  | { status: 'failed'; error: string; httpStatus: number };

const createLynxGoalId = (): string =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const TRIM_MARKER =
  '\n\n[… objective trimmed for the auditor — the full text was delivered in the chat message …]\n\n';

/**
 * Cap fitObjective fallback (no Cap distill small-model on Lynx) — head+tail
 * excerpt when over the auditor limit. Never pretends distillation succeeded.
 */
export function fitLynxGoalObjective(raw: string): string {
  if (raw.length <= SESSION_GOAL_OBJECTIVE_CHAR_LIMIT) return raw;
  const half = Math.max(0, Math.floor((SESSION_GOAL_OBJECTIVE_CHAR_LIMIT - TRIM_MARKER.length) / 2));
  return `${raw.slice(0, half)}${TRIM_MARKER}${raw.slice(-half)}`;
}

/** Cap PUT /api/goals/objective/:id — false when route/runtime missing (inline fallback). */
async function writeLynxObjectiveFile(
  runtimeFetch: LynxRuntimeFetch,
  sessionId: string,
  content: string,
): Promise<boolean> {
  try {
    const response = await runtimeFetch(`/api/goals/objective/${encodeURIComponent(sessionId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (response.status === 0) return false;
    return response.ok;
  } catch {
    return false;
  }
}

/** Cap DELETE /api/goals/objective/:id — best-effort; clear still requires metadata PATCH. */
function deleteLynxObjectiveFile(
  runtimeFetch: LynxRuntimeFetch,
  sessionId: string,
): void {
  void runtimeFetch(`/api/goals/objective/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
    .catch(() => undefined);
}

/**
 * Cap setSessionGoal — GET session + optional objective PUT + PATCH metadata.openchamber.goal.
 * Create (fresh id) or edit in place when existing id matches and not complete.
 * Never fake-success when runtime/HTTP is missing.
 */
export async function setLynxSessionGoal(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: {
    sessionId: string;
    directory?: string | null;
    objective: string;
    tokenBudget: number | null;
    existing?: LynxSessionGoalPayload | null;
  },
): Promise<LynxSessionGoalWriteResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    return { status: 'failed', error: 'session id required', httpStatus: 0 };
  }
  const rawObjective = input.objective.trim();
  if (!rawObjective) {
    return { status: 'failed', error: 'Goal objective must not be empty', httpStatus: 0 };
  }
  const objective = fitLynxGoalObjective(rawObjective);
  const tokenBudget = typeof input.tokenBudget === 'number'
    && Number.isFinite(input.tokenBudget)
    && input.tokenBudget > 0
    ? Math.floor(input.tokenBudget)
    : null;

  try {
    const getResponse = await runtimeFetch(
      `/session/${encodeURIComponent(sessionId)}${directoryQuery(input.directory)}`,
    );
    if (getResponse.status === 0) return { status: 'no-runtime' };
    if (!getResponse.ok) {
      return {
        status: 'failed',
        error: `session.get failed (${getResponse.status})`,
        httpStatus: getResponse.status,
      };
    }
    const session = await getResponse.json().catch(() => null);
    if (!isRecord(session)) {
      return { status: 'unavailable', error: 'session payload missing' };
    }

    const objectiveFile = await writeLynxObjectiveFile(runtimeFetch, sessionId, objective);
    const metadata = isRecord(session.metadata) ? { ...session.metadata } : {};
    const openchamber = isRecord(metadata.openchamber)
      ? { ...metadata.openchamber }
      : {};
    const currentGoal = isRecord(openchamber.goal) ? { ...openchamber.goal } : null;
    const existing = input.existing ?? null;
    const now = Date.now();

    let nextGoal: Record<string, unknown>;
    if (
      existing
      && currentGoal
      && typeof currentGoal.id === 'string'
      && currentGoal.id === existing.id
      && existing.status !== 'complete'
    ) {
      nextGoal = {
        ...currentGoal,
        objective: objectiveFile ? '' : objective,
        objectiveFile,
        tokenBudget,
        status: 'active',
        statusReason: 'resumed',
        blockedStreak: 0,
        updatedAt: now,
      };
    } else {
      nextGoal = {
        id: createLynxGoalId(),
        objective: objectiveFile ? '' : objective,
        objectiveFile,
        status: 'active',
        tokenBudget,
        tokensUsed: 0,
        turnsUsed: 0,
        blockedStreak: 0,
        note: '',
        statusReason: '',
        lastAccountedMessageID: '',
        createdAt: now,
        updatedAt: now,
      };
    }
    openchamber.goal = nextGoal;
    metadata.openchamber = openchamber;

    const patchResponse = await runtimeFetch(
      `/session/${encodeURIComponent(sessionId)}${directoryQuery(input.directory)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata }),
      },
    );
    if (patchResponse.status === 0) return { status: 'no-runtime' };
    if (!patchResponse.ok) {
      return {
        status: 'failed',
        error: `session.patch goal failed (${patchResponse.status})`,
        httpStatus: patchResponse.status,
      };
    }
    const parsed = parseLynxSessionGoal({ metadata });
    if (!parsed) {
      return { status: 'unavailable', error: 'goal payload missing after patch' };
    }
    return { status: 'ok', goal: parsed };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}

/**
 * Cap clearSessionGoal — GET + PATCH remove metadata.openchamber.goal + DELETE objective file.
 * Never fake-success. Caller may abort when the cleared goal was active.
 */
export async function clearLynxSessionGoal(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: {
    sessionId: string;
    directory?: string | null;
  },
): Promise<LynxSessionGoalStatusResult & { wasActive?: boolean }> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    return { status: 'failed', error: 'session id required', httpStatus: 0 };
  }
  try {
    const getResponse = await runtimeFetch(
      `/session/${encodeURIComponent(sessionId)}${directoryQuery(input.directory)}`,
    );
    if (getResponse.status === 0) return { status: 'no-runtime' };
    if (!getResponse.ok) {
      return {
        status: 'failed',
        error: `session.get failed (${getResponse.status})`,
        httpStatus: getResponse.status,
      };
    }
    const session = await getResponse.json().catch(() => null);
    if (!isRecord(session)) {
      return { status: 'unavailable', error: 'session payload missing' };
    }
    const metadata = isRecord(session.metadata) ? { ...session.metadata } : {};
    const openchamber = isRecord(metadata.openchamber)
      ? { ...metadata.openchamber }
      : {};
    const currentGoal = isRecord(openchamber.goal) ? openchamber.goal : null;
    if (!currentGoal) {
      return { status: 'unavailable', error: 'no session goal on metadata' };
    }
    const wasActive = currentGoal.status === 'active';
    delete openchamber.goal;
    metadata.openchamber = openchamber;

    const patchResponse = await runtimeFetch(
      `/session/${encodeURIComponent(sessionId)}${directoryQuery(input.directory)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata }),
      },
    );
    if (patchResponse.status === 0) return { status: 'no-runtime' };
    if (!patchResponse.ok) {
      return {
        status: 'failed',
        error: `session.patch clear goal failed (${patchResponse.status})`,
        httpStatus: patchResponse.status,
      };
    }
    deleteLynxObjectiveFile(runtimeFetch, sessionId);
    return { status: 'ok', wasActive };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}
