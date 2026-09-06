import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export class ProvidersApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ProvidersApiError';
    this.status = status;
  }
}

export type CatalogModel = {
  id: string;
  name: string;
};

export type CatalogProvider = {
  id: string;
  name: string;
  models: CatalogModel[];
};

export type ProviderCatalog = {
  schemaVersion: 1;
  providers: CatalogProvider[];
  default: Record<string, string>;
  partial: boolean;
};

export type ProviderOAuthAuthorizeResult = {
  url?: string;
  instructions?: string;
  userCode?: string;
  mode?: 'auto' | 'code';
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const identifier = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() && value.trim() === value ? value : null;

export const parseProviderCatalog = (payload: unknown): ProviderCatalog => {
  const row = asRecord(payload);
  if (!row) throw new ProvidersApiError('invalid_provider_catalog', 200);
  const providersRaw = Array.isArray(row.providers) ? row.providers : null;
  if (!providersRaw) throw new ProvidersApiError('invalid_provider_catalog', 200);
  const providers: CatalogProvider[] = [];
  for (const item of providersRaw) {
    const p = asRecord(item);
    const id = identifier(p?.id);
    const name = typeof p?.name === 'string' && p.name.trim() ? p.name : id;
    if (!id || !name) continue;
    const models: CatalogModel[] = [];
    const modelsRaw = p?.models;
    if (modelsRaw && typeof modelsRaw === 'object' && !Array.isArray(modelsRaw)) {
      for (const [mid, model] of Object.entries(modelsRaw as Record<string, unknown>)) {
        const m = asRecord(model);
        const modelId = identifier(m?.id) ?? identifier(mid);
        const modelName = typeof m?.name === 'string' && m.name.trim() ? m.name : modelId;
        if (modelId && modelName) models.push({ id: modelId, name: modelName });
      }
    } else if (Array.isArray(modelsRaw)) {
      for (const model of modelsRaw) {
        const m = asRecord(model);
        const modelId = identifier(m?.id);
        const modelName = typeof m?.name === 'string' && m.name.trim() ? m.name : modelId;
        if (modelId && modelName) models.push({ id: modelId, name: modelName });
      }
    }
    providers.push({ id, name, models });
  }
  const defaults: Record<string, string> = {};
  const def = asRecord(row.default);
  if (def) {
    for (const [k, v] of Object.entries(def)) {
      if (typeof v === 'string' && v.trim()) defaults[k] = v;
    }
  }
  return {
    schemaVersion: 1,
    providers,
    default: defaults,
    partial: row.partial === true,
  };
};

/** GET /api/config/catalog/providers — failure ≠ empty success. */
export const loadProviderCatalog = async (
  active: ActiveRuntime,
  options?: { signal?: AbortSignal; directory?: string | null },
): Promise<ProviderCatalog> => {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options?.directory?.trim()) headers['x-opencode-directory'] = options.directory.trim();
  const response = await openchamberFetch(active, '/api/config/catalog/providers', {
    method: 'GET',
    headers,
    signal: options?.signal,
  });
  if (!response.ok) {
    throw new ProvidersApiError('Failed to load provider catalog', response.status);
  }
  return parseProviderCatalog(await response.json());
};

/** PUT /api/auth/:providerId — API key. Never log the key. */
export const putProviderApiKey = async (
  active: ActiveRuntime,
  providerId: string,
  key: string,
): Promise<void> => {
  const response = await openchamberFetch(
    active,
    `/api/auth/${encodeURIComponent(providerId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ type: 'api', key }),
    },
  );
  if (!response.ok) {
    throw new ProvidersApiError('Failed to save provider credentials', response.status);
  }
};

/** DELETE /api/provider/:providerId/auth */
export const deleteProviderAuth = async (
  active: ActiveRuntime,
  providerId: string,
): Promise<void> => {
  const response = await openchamberFetch(
    active,
    `/api/provider/${encodeURIComponent(providerId)}/auth`,
    { method: 'DELETE' },
  );
  if (!response.ok) {
    throw new ProvidersApiError('Failed to disconnect provider', response.status);
  }
};

/** POST /api/provider/:id/oauth/authorize */
export const authorizeProviderOAuth = async (
  active: ActiveRuntime,
  providerId: string,
  method = 0,
): Promise<ProviderOAuthAuthorizeResult> => {
  const response = await openchamberFetch(
    active,
    `/api/provider/${encodeURIComponent(providerId)}/oauth/authorize`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ method }),
    },
  );
  if (!response.ok) {
    throw new ProvidersApiError('Failed to start provider OAuth', response.status);
  }
  const row = asRecord(await response.json()) ?? {};
  return {
    url: typeof row.url === 'string' ? row.url : undefined,
    instructions: typeof row.instructions === 'string' ? row.instructions : undefined,
    userCode: typeof row.userCode === 'string' ? row.userCode : undefined,
    mode: row.mode === 'code' || row.mode === 'auto' ? row.mode : undefined,
  };
};

/** POST /api/provider/:id/oauth/callback */
export const completeProviderOAuth = async (
  active: ActiveRuntime,
  providerId: string,
  input: { method?: number; code?: string },
): Promise<void> => {
  const response = await openchamberFetch(
    active,
    `/api/provider/${encodeURIComponent(providerId)}/oauth/callback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ method: input.method ?? 0, code: input.code }),
    },
  );
  if (!response.ok) {
    throw new ProvidersApiError('Failed to complete provider OAuth', response.status);
  }
};

/** Cap external-browser OAuth path via expo-web-browser — http(s) only. */
export const openExternalOAuthUrl = async (url: string): Promise<void> => {
  if (!url.trim()) throw new ProvidersApiError('missing_oauth_url');
  const { openExternalBrowser, ExternalBrowserError } = await import('@/lib/systemShell/externalBrowser');
  try {
    await openExternalBrowser(url);
  } catch (error) {
    if (error instanceof ExternalBrowserError) throw new ProvidersApiError('missing_oauth_url');
    throw error;
  }
};
