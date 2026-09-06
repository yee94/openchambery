import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export class BehaviorApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'BehaviorApiError';
    this.status = status;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const parseAgentsMd = (payload: unknown): string => {
  if (typeof payload === 'string') return payload;
  const row = asRecord(payload);
  if (typeof row?.content === 'string') return row.content;
  if (typeof row?.text === 'string') return row.text;
  throw new BehaviorApiError('invalid_agents_md_response', 200);
};

/** GET /api/behavior/agents-md */
export const loadAgentsMd = async (
  active: ActiveRuntime,
  options?: { signal?: AbortSignal },
): Promise<string> => {
  const response = await openchamberFetch(active, '/api/behavior/agents-md', {
    method: 'GET',
    signal: options?.signal,
  });
  if (!response.ok) throw new BehaviorApiError('Failed to load agents.md', response.status);
  return parseAgentsMd(await response.json());
};

/** PUT /api/behavior/agents-md */
export const putAgentsMd = async (active: ActiveRuntime, content: string): Promise<void> => {
  const response = await openchamberFetch(active, '/api/behavior/agents-md', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) throw new BehaviorApiError('Failed to save agents.md', response.status);
};
