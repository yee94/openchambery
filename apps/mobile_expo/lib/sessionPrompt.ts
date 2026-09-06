import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export class SessionPromptError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'SessionPromptError';
    this.status = status;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

export type CreatedSession = {
  id: string;
  title?: string;
  directory?: string | null;
};

export type CreateSessionInput = {
  title?: string;
  directory?: string | null;
  parentID?: string;
};

/** POST /api/session — materialize draft on first send. */
export const createSession = async (
  active: ActiveRuntime,
  input: CreateSessionInput = {},
): Promise<CreatedSession> => {
  const body: Record<string, unknown> = {};
  if (input.title) body.title = input.title;
  if (input.parentID) body.parentID = input.parentID;
  if (input.directory) body.directory = input.directory;

  const query = input.directory
    ? `?directory=${encodeURIComponent(input.directory)}`
    : '';

  let response;
  try {
    response = await openchamberFetch(active, `/api/session${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new SessionPromptError(
      error instanceof Error ? error.message : 'create session failed',
      null,
    );
  }

  if (!response.ok) {
    throw new SessionPromptError(`create session failed (${response.status})`, response.status);
  }

  const payload = await response.json();
  const record = asRecord(payload) ?? asRecord(asRecord(payload)?.data);
  const id = typeof record?.id === 'string' ? record.id : null;
  if (!id) throw new SessionPromptError('create session: missing id');
  return {
    id,
    title: typeof record?.title === 'string' ? record.title : undefined,
    directory:
      typeof record?.directory === 'string'
        ? record.directory
        : input.directory ?? null,
  };
};

export type PromptFilePart = {
  type: 'file';
  mime: string;
  url: string;
  filename?: string;
};

export type PromptAsyncInput = {
  sessionId: string;
  text: string;
  directory?: string | null;
  messageId?: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  /** Cap file:// parts after PUT /api/fs/prompt-attachments/:id */
  fileParts?: PromptFilePart[];
};

/** POST /api/session/:id/prompt_async */
export const promptAsync = async (
  active: ActiveRuntime,
  input: PromptAsyncInput,
): Promise<void> => {
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new SessionPromptError('prompt_async: sessionId required');
  const text = input.text.trim();
  const hasFiles = (input.fileParts?.length ?? 0) > 0;
  if (!text && !hasFiles) throw new SessionPromptError('prompt_async: empty text');

  const params = new URLSearchParams();
  if (input.directory) params.set('directory', input.directory);
  const qs = params.toString();
  const path = `/api/session/${encodeURIComponent(sessionId)}/prompt_async${qs ? `?${qs}` : ''}`;

  const parts: Array<Record<string, unknown>> = [];
  const fileParts = input.fileParts ?? [];
  for (const file of fileParts) {
    parts.push({
      type: 'file',
      mime: file.mime,
      url: file.url,
      ...(file.filename ? { filename: file.filename } : {}),
    });
  }
  // Cap citation style: path refs before user text when attachments present.
  const textWithCitations =
    fileParts.length > 0
      ? `${fileParts.map((file) => `[${file.url.replace(/^file:\/\//, '')}]`).join(' ')} ${text}`.trim()
      : text;
  parts.push({ type: 'text', text: textWithCitations });

  const body: Record<string, unknown> = {
    parts,
  };
  if (input.messageId) body.messageID = input.messageId;
  if (input.agent) body.agent = input.agent;
  if (input.model) body.model = input.model;

  let response;
  try {
    response = await openchamberFetch(active, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new SessionPromptError(
      error instanceof Error ? error.message : 'prompt_async failed',
      null,
    );
  }

  if (!response.ok) {
    throw new SessionPromptError(`prompt_async failed (${response.status})`, response.status);
  }
};

export type AbortSessionInput = {
  sessionId: string;
  directory?: string | null;
};

/** POST /api/session/:id/abort */
export const abortSession = async (
  active: ActiveRuntime,
  input: AbortSessionInput,
): Promise<void> => {
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new SessionPromptError('abort: sessionId required');

  const params = new URLSearchParams();
  if (input.directory) params.set('directory', input.directory);
  const qs = params.toString();
  const path = `/api/session/${encodeURIComponent(sessionId)}/abort${qs ? `?${qs}` : ''}`;

  let response;
  try {
    response = await openchamberFetch(active, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch (error) {
    throw new SessionPromptError(
      error instanceof Error ? error.message : 'abort failed',
      null,
    );
  }

  if (!response.ok) {
    throw new SessionPromptError(`abort failed (${response.status})`, response.status);
  }
};

/**
 * Draft first-send: POST /api/session then prompt_async.
 * Returns the materialized session id.
 */
export const materializeDraftAndPrompt = async (
  active: ActiveRuntime,
  input: {
    text: string;
    directory?: string | null;
    title?: string;
    messageId?: string;
    fileParts?: PromptFilePart[];
  },
): Promise<CreatedSession> => {
  const session = await createSession(active, {
    directory: input.directory,
    title: input.title,
  });
  await promptAsync(active, {
    sessionId: session.id,
    text: input.text,
    directory: input.directory ?? session.directory,
    messageId: input.messageId,
    fileParts: input.fileParts,
  });
  return session;
};
