import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export class UsageApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'UsageApiError';
    this.status = status;
  }
}

export type ProviderQuota = {
  providerId: string;
  ok: boolean;
  error?: string;
  payload?: unknown;
};

/** GET /api/quota/:providerId — one failure stays on that row. */
export const loadProviderQuota = async (
  active: ActiveRuntime,
  providerId: string,
  options?: { signal?: AbortSignal },
): Promise<ProviderQuota> => {
  const response = await openchamberFetch(
    active,
    `/api/quota/${encodeURIComponent(providerId)}`,
    { method: 'GET', signal: options?.signal },
  );
  if (!response.ok) {
    return {
      providerId,
      ok: false,
      error: `Failed to load quota (${response.status})`,
    };
  }
  return {
    providerId,
    ok: true,
    payload: await response.json(),
  };
};

export const loadProviderQuotas = async (
  active: ActiveRuntime,
  providerIds: string[],
  options?: { signal?: AbortSignal },
): Promise<ProviderQuota[]> => {
  return Promise.all(providerIds.map((id) => loadProviderQuota(active, id, options)));
};
