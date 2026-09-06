import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export class SnippetsApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'SnippetsApiError';
    this.status = status;
  }
}

export type SnippetItem = {
  name: string;
  content?: string;
  description?: string;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const parseSnippetsList = (payload: unknown): SnippetItem[] => {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(asRecord(payload)?.snippets)
      ? (asRecord(payload)!.snippets as unknown[])
      : null;
  if (!list) throw new SnippetsApiError('invalid_snippets_response', 200);
  return list.flatMap((item) => {
    const row = asRecord(item);
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    if (!name) return [];
    return [{
      name,
      content: typeof row?.content === 'string' ? row.content : undefined,
      description: typeof row?.description === 'string' ? row.description : undefined,
    }];
  });
};

/** GET /api/config/snippets */
export const loadSnippets = async (
  active: ActiveRuntime,
  options?: { signal?: AbortSignal; directory?: string | null },
): Promise<SnippetItem[]> => {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let path = '/api/config/snippets';
  if (options?.directory?.trim()) {
    headers['x-opencode-directory'] = options.directory.trim();
    path += `?directory=${encodeURIComponent(options.directory.trim())}`;
  }
  const response = await openchamberFetch(active, path, { method: 'GET', headers, signal: options?.signal });
  if (!response.ok) throw new SnippetsApiError('Failed to load snippets', response.status);
  return parseSnippetsList(await response.json());
};

/** POST /api/config/snippets/:name */
export const upsertSnippet = async (
  active: ActiveRuntime,
  name: string,
  body: Record<string, unknown>,
  options?: { directory?: string | null },
): Promise<void> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  let path = `/api/config/snippets/${encodeURIComponent(name)}`;
  if (options?.directory?.trim()) {
    headers['x-opencode-directory'] = options.directory.trim();
    path += `?directory=${encodeURIComponent(options.directory.trim())}`;
  }
  const response = await openchamberFetch(active, path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new SnippetsApiError('Failed to save snippet', response.status);
};
