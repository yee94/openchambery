/**
 * Cap GET /api/config/catalog/providers — used for context-usage ring limits.
 */

import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export class ProviderCatalogError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ProviderCatalogError';
    this.status = status;
  }
}

/** Returns raw catalog JSON (providers + default). Failure throws. */
export const loadProviderCatalog = async (
  active: ActiveRuntime,
  directory?: string | null,
  signal?: AbortSignal,
): Promise<unknown> => {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (directory) headers['x-opencode-directory'] = directory;
  const params = new URLSearchParams();
  if (directory) params.set('directory', directory);
  const qs = params.toString();
  const response = await openchamberFetch(
    active,
    `/api/config/catalog/providers${qs ? `?${qs}` : ''}`,
    { method: 'GET', headers, signal },
  );
  if (!response.ok) {
    throw new ProviderCatalogError(
      `provider catalog failed (${response.status})`,
      response.status,
    );
  }
  return response.json();
};
