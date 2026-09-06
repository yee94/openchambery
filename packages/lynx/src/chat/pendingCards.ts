/**
 * Cap question / permission pending cards for Lynx chat footer.
 * Routes mirror OpenCode SDK: GET/POST /question, /permission.
 * Never invent request shapes.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';
import {
  parseLynxPermissionRequest,
  parseLynxQuestionRequest,
  type LynxPermissionRequest,
  type LynxQuestionRequest,
} from './messageParts';

export type LynxPendingCardsResult =
  | {
    status: 'ok';
    questions: LynxQuestionRequest[];
    permissions: LynxPermissionRequest[];
  }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: string; httpStatus: number };

export type LynxPermissionReply = 'once' | 'always' | 'reject';

export type LynxCardActionResult =
  | { status: 'ok' }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: string; httpStatus: number };

const directoryQuery = (directory?: string | null): string => {
  const value = directory?.trim();
  return value ? `?directory=${encodeURIComponent(value)}` : '';
};

const listFromPayload = (payload: unknown): unknown[] => {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const record = payload as { data?: unknown; items?: unknown; questions?: unknown; permissions?: unknown };
    if (Array.isArray(record.data)) return record.data;
    if (Array.isArray(record.items)) return record.items;
    if (Array.isArray(record.questions)) return record.questions;
    if (Array.isArray(record.permissions)) return record.permissions;
  }
  return [];
};

export async function fetchLynxPendingCards(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { directory?: string | null; sessionId?: string },
): Promise<LynxPendingCardsResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const query = directoryQuery(input.directory);
  try {
    const [questionResponse, permissionResponse] = await Promise.all([
      runtimeFetch(`/question${query}`, { method: 'GET' }),
      runtimeFetch(`/permission${query}`, { method: 'GET' }),
    ]);

    if (questionResponse.status === 0 || permissionResponse.status === 0) {
      return { status: 'no-runtime' };
    }

    const failures: string[] = [];
    let questions: LynxQuestionRequest[] = [];
    let permissions: LynxPermissionRequest[] = [];

    if (questionResponse.ok) {
      const payload = await questionResponse.json().catch(() => null);
      questions = listFromPayload(payload)
        .map((row) => parseLynxQuestionRequest(row))
        .filter((row): row is LynxQuestionRequest => row !== null);
      if (input.sessionId) {
        questions = questions.filter((q) => q.sessionID === input.sessionId);
      }
    } else if (questionResponse.status !== 404 && questionResponse.status !== 501) {
      failures.push(`question.list failed (${questionResponse.status})`);
    }

    if (permissionResponse.ok) {
      const payload = await permissionResponse.json().catch(() => null);
      permissions = listFromPayload(payload)
        .map((row) => parseLynxPermissionRequest(row))
        .filter((row): row is LynxPermissionRequest => row !== null);
      if (input.sessionId) {
        permissions = permissions.filter((p) => p.sessionID === input.sessionId);
      }
    } else if (permissionResponse.status !== 404 && permissionResponse.status !== 501) {
      failures.push(`permission.list failed (${permissionResponse.status})`);
    }

    if (failures.length > 0 && questions.length === 0 && permissions.length === 0) {
      return {
        status: 'failed',
        error: failures.join('; '),
        httpStatus: questionResponse.ok ? permissionResponse.status : questionResponse.status,
      };
    }

    return { status: 'ok', questions, permissions };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}

export async function replyLynxQuestion(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: {
    requestId: string;
    answers: string[][];
    directory?: string | null;
  },
): Promise<LynxCardActionResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const id = input.requestId.trim();
  if (!id) return { status: 'failed', error: 'question request id required', httpStatus: 0 };
  try {
    const query = directoryQuery(input.directory);
    const response = await runtimeFetch(`/question/${encodeURIComponent(id)}/reply${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: input.answers }),
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: `question.reply failed (${response.status})`,
        httpStatus: response.status,
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

export async function rejectLynxQuestion(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { requestId: string; directory?: string | null },
): Promise<LynxCardActionResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const id = input.requestId.trim();
  if (!id) return { status: 'failed', error: 'question request id required', httpStatus: 0 };
  try {
    const query = directoryQuery(input.directory);
    const response = await runtimeFetch(`/question/${encodeURIComponent(id)}/reject${query}`, {
      method: 'POST',
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: `question.reject failed (${response.status})`,
        httpStatus: response.status,
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

export async function replyLynxPermission(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: {
    requestId: string;
    reply: LynxPermissionReply;
    directory?: string | null;
  },
): Promise<LynxCardActionResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const id = input.requestId.trim();
  if (!id) return { status: 'failed', error: 'permission request id required', httpStatus: 0 };
  try {
    const query = directoryQuery(input.directory);
    const response = await runtimeFetch(`/permission/${encodeURIComponent(id)}/reply${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply: input.reply }),
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: `permission.reply failed (${response.status})`,
        httpStatus: response.status,
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
