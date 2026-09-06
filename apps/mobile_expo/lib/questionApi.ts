/**
 * Minimal Cap question client for Expo Chat interactive QuestionCard.
 * Contracts: GET /api/question?directory=…, POST /api/question/:id/reply|reject
 * Event types: question.asked / question.replied / question.rejected
 */

import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export type QuestionOption = {
  label: string;
  description: string;
};

export type QuestionInfo = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
};

export type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: {
    messageID: string;
    callID: string;
  };
};

export class QuestionApiError extends Error {
  readonly status: number | null;
  readonly code: string;

  constructor(message: string, status: number | null = null, code = 'unavailable') {
    super(message);
    this.name = 'QuestionApiError';
    this.status = status;
    this.code = code;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const parseOption = (value: unknown): QuestionOption | null => {
  const row = asRecord(value);
  if (!row || typeof row.label !== 'string') return null;
  return {
    label: row.label,
    description: typeof row.description === 'string' ? row.description : '',
  };
};

const parseInfo = (value: unknown): QuestionInfo | null => {
  const row = asRecord(value);
  if (!row || typeof row.question !== 'string') return null;
  const options = Array.isArray(row.options)
    ? row.options.map(parseOption).filter((o): o is QuestionOption => o != null)
    : [];
  return {
    question: row.question,
    header: typeof row.header === 'string' ? row.header : '',
    options,
    multiple: Boolean(row.multiple),
  };
};

export const parseQuestionRequest = (value: unknown): QuestionRequest | null => {
  const row = asRecord(value);
  if (!row || typeof row.id !== 'string' || typeof row.sessionID !== 'string') return null;
  const questions = Array.isArray(row.questions)
    ? row.questions.map(parseInfo).filter((q): q is QuestionInfo => q != null)
    : [];
  const toolRow = asRecord(row.tool);
  const tool =
    toolRow && typeof toolRow.messageID === 'string' && typeof toolRow.callID === 'string'
      ? { messageID: toolRow.messageID, callID: toolRow.callID }
      : undefined;
  return {
    id: row.id,
    sessionID: row.sessionID,
    questions,
    ...(tool ? { tool } : {}),
  };
};

export const parseQuestionList = (payload: unknown): QuestionRequest[] => {
  if (Array.isArray(payload)) {
    return payload.map(parseQuestionRequest).filter((q): q is QuestionRequest => q != null);
  }
  const body = asRecord(payload);
  if (body && Array.isArray(body.data)) {
    return body.data.map(parseQuestionRequest).filter((q): q is QuestionRequest => q != null);
  }
  return [];
};

const withDirectory = (path: string, directory?: string | null): string => {
  if (!directory?.trim()) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}directory=${encodeURIComponent(directory.trim())}`;
};

export async function listPendingQuestions(
  active: ActiveRuntime,
  options?: { directory?: string | null; sessionId?: string | null },
): Promise<QuestionRequest[]> {
  const path = withDirectory('/api/question', options?.directory);
  const response = await openchamberFetch(active, path, { method: 'GET' });
  if (!response.ok) {
    throw new QuestionApiError(
      `question.list failed (${response.status})`,
      response.status,
      'list_failed',
    );
  }
  const payload = await response.json();
  const all = parseQuestionList(payload);
  const sessionId = options?.sessionId?.trim();
  if (!sessionId) return all;
  return all.filter((q) => q.sessionID === sessionId);
}

export async function replyToQuestion(
  active: ActiveRuntime,
  input: {
    requestId: string;
    answers: string[][];
    directory?: string | null;
  },
): Promise<void> {
  const path = withDirectory(`/api/question/${encodeURIComponent(input.requestId)}/reply`, input.directory);
  const response = await openchamberFetch(active, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers: input.answers }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const notFound = response.status === 404 || /not\s*found/i.test(text);
    throw new QuestionApiError(
      notFound ? 'question no longer pending' : `question.reply failed (${response.status})`,
      response.status,
      notFound ? 'not_found' : 'reply_failed',
    );
  }
}

export async function rejectQuestion(
  active: ActiveRuntime,
  input: {
    requestId: string;
    directory?: string | null;
  },
): Promise<void> {
  const path = withDirectory(`/api/question/${encodeURIComponent(input.requestId)}/reject`, input.directory);
  const response = await openchamberFetch(active, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const notFound = response.status === 404 || /not\s*found/i.test(text);
    throw new QuestionApiError(
      notFound ? 'question no longer pending' : `question.reject failed (${response.status})`,
      response.status,
      notFound ? 'not_found' : 'reject_failed',
    );
  }
}

/** Apply Cap question.* events onto a pending list for one session. */
export function applyQuestionEvent(
  pending: QuestionRequest[],
  event: { type: string; properties?: Record<string, unknown> },
  sessionId: string,
): QuestionRequest[] {
  if (event.type === 'question.asked') {
    const next = parseQuestionRequest(event.properties);
    if (!next || next.sessionID !== sessionId) return pending;
    const index = pending.findIndex((q) => q.id === next.id);
    if (index < 0) return [...pending, next];
    const copy = pending.slice();
    copy[index] = next;
    return copy;
  }
  if (event.type === 'question.replied' || event.type === 'question.rejected') {
    const props = event.properties ?? {};
    const requestID = typeof props.requestID === 'string' ? props.requestID : null;
    const sid = typeof props.sessionID === 'string' ? props.sessionID : null;
    if (!requestID || (sid && sid !== sessionId)) return pending;
    if (sid && sid !== sessionId) return pending;
    return pending.filter((q) => q.id !== requestID);
  }
  return pending;
}

export const isQuestionNotFoundError = (error: unknown): boolean =>
  error instanceof QuestionApiError && error.code === 'not_found';
