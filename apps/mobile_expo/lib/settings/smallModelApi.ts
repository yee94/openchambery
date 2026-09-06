import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export class SmallModelApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'SmallModelApiError';
    this.status = status;
  }
}

export type SmallModelInfo = {
  providerID?: string;
  modelID?: string;
  [key: string]: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const parseSmallModelInfo = (payload: unknown): SmallModelInfo => {
  const row = asRecord(payload);
  if (!row) throw new SmallModelApiError('invalid_small_model_response', 200);
  return {
    ...row,
    providerID: typeof row.providerID === 'string' ? row.providerID : undefined,
    modelID: typeof row.modelID === 'string' ? row.modelID : undefined,
  };
};

/** GET /api/small-model */
export const loadSmallModel = async (
  active: ActiveRuntime,
  options?: { signal?: AbortSignal },
): Promise<SmallModelInfo> => {
  const response = await openchamberFetch(active, '/api/small-model', {
    method: 'GET',
    signal: options?.signal,
  });
  if (!response.ok) throw new SmallModelApiError('Failed to load small-model', response.status);
  return parseSmallModelInfo(await response.json());
};
