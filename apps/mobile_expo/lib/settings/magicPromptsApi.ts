import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export class MagicPromptsApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'MagicPromptsApiError';
    this.status = status;
  }
}

export type MagicPromptItem = {
  id: string;
  title?: string;
  visiblePrompt?: string;
  instructions?: string;
  overridden?: boolean;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const parseMagicPrompts = (payload: unknown): MagicPromptItem[] => {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(asRecord(payload)?.prompts)
      ? (asRecord(payload)!.prompts as unknown[])
      : null;
  if (!list) throw new MagicPromptsApiError('invalid_magic_prompts_response', 200);
  return list.flatMap((item) => {
    const row = asRecord(item);
    const id = typeof row?.id === 'string' ? row.id.trim() : '';
    if (!id) return [];
    return [{
      id,
      title: typeof row?.title === 'string' ? row.title : undefined,
      visiblePrompt: typeof row?.visiblePrompt === 'string' ? row.visiblePrompt : undefined,
      instructions: typeof row?.instructions === 'string' ? row.instructions : undefined,
      overridden: typeof row?.overridden === 'boolean' ? row.overridden : undefined,
    }];
  });
};

/** GET /api/magic-prompts */
export const loadMagicPrompts = async (
  active: ActiveRuntime,
  options?: { signal?: AbortSignal },
): Promise<MagicPromptItem[]> => {
  const response = await openchamberFetch(active, '/api/magic-prompts', {
    method: 'GET',
    signal: options?.signal,
  });
  if (!response.ok) throw new MagicPromptsApiError('Failed to load magic prompts', response.status);
  return parseMagicPrompts(await response.json());
};

/** PUT /api/magic-prompts/:id */
export const putMagicPrompt = async (
  active: ActiveRuntime,
  id: string,
  body: Record<string, unknown>,
): Promise<void> => {
  const response = await openchamberFetch(active, `/api/magic-prompts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new MagicPromptsApiError('Failed to save magic prompt', response.status);
};

/** DELETE /api/magic-prompts — reset all overrides */
export const resetMagicPromptOverrides = async (active: ActiveRuntime): Promise<void> => {
  const response = await openchamberFetch(active, '/api/magic-prompts', { method: 'DELETE' });
  if (!response.ok) throw new MagicPromptsApiError('Failed to reset magic prompts', response.status);
};
