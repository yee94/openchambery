import { runtimeFetch } from '@yuriai/ui/lib/runtime-fetch';
import type {
  ConversationsAPI,
  ConversationCreateWithPromptInput,
  ConversationCreateWithPromptResult,
} from '@yuriai/ui/lib/api/types';

// --- runtime parser: validate result shape without blind `as` ---

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

const isValidResult = (body: unknown): body is ConversationCreateWithPromptResult => {
  if (!isRecord(body)) return false;
  if (typeof body.ok !== 'boolean') return false;

  if (body.ok === true) {
    return (
      isRecord(body.session) &&
      typeof body.session.id === 'string' &&
      typeof body.messageID === 'string'
    );
  }

  // ok === false — must have phase
  const phase = body.phase;
  if (typeof phase !== 'string') return false;

  switch (phase) {
    case 'validate':
      return (
        typeof body.error === 'string' &&
        Array.isArray(body.errors) &&
        body.errors.every((e) => typeof e === 'string')
      );
    case 'create': {
      if (typeof body.error !== 'string') return false;
      // status is optional; if present must be a finite number
      if ('status' in body && body.status !== undefined && !isFiniteNumber(body.status)) return false;
      return true;
    }
    case 'prompt':
      return (
        isRecord(body.session) &&
        typeof body.session.id === 'string' &&
        typeof body.messageID === 'string' &&
        typeof body.ambiguous === 'boolean' &&
        typeof body.error === 'string' &&
        (!('status' in body) || body.status === undefined || isFiniteNumber(body.status))
      );
    case 'conflict':
      return typeof body.error === 'string';
    case 'unavailable':
      return typeof body.error === 'string';
    case 'internal':
      return typeof body.error === 'string';
    default:
      return false;
  }
};

// --- implementation ---

export const createWebConversationsAPI = (): ConversationsAPI => ({
  async createWithPrompt(
    input: ConversationCreateWithPromptInput,
    signal?: AbortSignal,
  ): Promise<ConversationCreateWithPromptResult> {
    let response: Response;
    try {
      response = await runtimeFetch('/api/yuri/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal,
      });
    } catch {
      throw new Error('Conversation request failed');
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error('Unexpected server response: invalid JSON');
    }

    if (!isValidResult(body)) {
      throw new Error('Unexpected server response: result shape mismatch');
    }

    return body;
  },
});
