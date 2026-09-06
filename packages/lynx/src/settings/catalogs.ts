import type { LynxRuntimeFetch } from '../runtime/fetch';

export type LynxCatalogKind =
  | 'providers'
  | 'agents'
  | 'mcp'
  | 'plugins'
  | 'skills'
  | 'commands'
  | 'magic-prompts'
  | 'snippets'
  | 'usage'
  | 'assistants';

export type LynxCatalogItem = {
  id: string;
  title: string;
  subtitle?: string;
};

export type LynxCatalogLoadResult =
  | { status: 'ok'; items: LynxCatalogItem[] }
  | { status: 'no-runtime' }
  | { status: 'unsupported' }
  | { status: 'failed'; error: Error; httpStatus?: number };

export type LynxUsageRow = {
  providerId: string;
  status: 'ok' | 'failed';
  label: string;
  detail?: string;
  error?: string;
};

export type LynxUsageLoadResult =
  | { status: 'ok'; rows: LynxUsageRow[] }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: Error };

const directoryHeaders = (directory?: string | null): Record<string, string> => (
  directory?.trim()
    ? { 'x-opencode-directory': directory.trim() }
    : {}
);

const asRecord = (data: unknown): Record<string, unknown> => (
  data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
);

const listFromUnknown = (data: unknown, keys: string[]): unknown[] => {
  if (Array.isArray(data)) return data;
  const record = asRecord(data);
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
};

const itemFromEntry = (entry: unknown, fallbackIndex: number): LynxCatalogItem | null => {
  if (typeof entry === 'string' && entry.trim()) {
    return { id: entry.trim(), title: entry.trim() };
  }
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const id = typeof record.id === 'string' && record.id.trim()
    ? record.id.trim()
    : typeof record.name === 'string' && record.name.trim()
      ? record.name.trim()
      : typeof record.providerID === 'string' && record.providerID.trim()
        ? record.providerID.trim()
        : `item-${fallbackIndex}`;
  const title = typeof record.name === 'string' && record.name.trim()
    ? record.name.trim()
    : typeof record.title === 'string' && record.title.trim()
      ? record.title.trim()
      : typeof record.label === 'string' && record.label.trim()
        ? record.label.trim()
        : id;
  const subtitle = typeof record.description === 'string'
    ? record.description
    : typeof record.model === 'string'
      ? record.model
      : typeof record.status === 'string'
        ? record.status
        : undefined;
  return { id, title, subtitle };
};

const loadList = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal },
  parseKeys: string[],
): Promise<LynxCatalogLoadResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const response = await runtimeFetch(path, {
      method: init.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...init.headers,
      },
      body: init.body,
      signal: init.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 404 || response.status === 501) return { status: 'unsupported' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`catalog ${path} failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    const payload = await response.json();
    const items = listFromUnknown(payload, parseKeys)
      .map((entry, index) => itemFromEntry(entry, index))
      .filter((item): item is LynxCatalogItem => Boolean(item));
    return { status: 'ok', items };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/** Cap `/api/config/catalog/providers` — failure ≠ empty. */
export const loadProvidersCatalog = (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { directory?: string | null; signal?: AbortSignal },
): Promise<LynxCatalogLoadResult> => loadList(
  runtimeFetch,
  '/api/config/catalog/providers',
  {
    headers: directoryHeaders(options?.directory),
    signal: options?.signal,
  },
  ['providers'],
);

/** Cap agents via OpenCode-compatible `/api/agent` (gap board). */
export const loadAgentsCatalog = (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { directory?: string | null; signal?: AbortSignal },
): Promise<LynxCatalogLoadResult> => loadList(
  runtimeFetch,
  '/api/agent',
  {
    headers: directoryHeaders(options?.directory),
    signal: options?.signal,
  },
  ['agents'],
);

export const loadMcpCatalog = (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { directory?: string | null; signal?: AbortSignal },
): Promise<LynxCatalogLoadResult> => {
  const directory = options?.directory?.trim();
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  return loadList(
    runtimeFetch,
    `/api/config/mcp${query}`,
    { signal: options?.signal },
    ['servers', 'mcp', 'items'],
  );
};

export const loadPluginsCatalog = (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { directory?: string | null; signal?: AbortSignal },
): Promise<LynxCatalogLoadResult> => {
  const directory = options?.directory?.trim();
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  return loadList(
    runtimeFetch,
    `/api/config/plugins${query}`,
    { signal: options?.signal },
    ['plugins', 'items'],
  );
};

export const loadInstalledSkillsCatalog = (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { directory?: string | null; signal?: AbortSignal },
): Promise<LynxCatalogLoadResult> => {
  const params = new URLSearchParams({ summary: 'true' });
  const directory = options?.directory?.trim();
  if (directory) params.set('directory', directory);
  return loadList(
    runtimeFetch,
    `/api/config/skills?${params.toString()}`,
    { signal: options?.signal },
    ['skills', 'items'],
  );
};

export const loadCommandsCatalog = (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { directory?: string | null; signal?: AbortSignal },
): Promise<LynxCatalogLoadResult> => loadList(
  runtimeFetch,
  '/api/config/commands/metadata',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...directoryHeaders(options?.directory),
    },
    body: JSON.stringify({ catalog: true }),
    signal: options?.signal,
  },
  ['commands', 'items'],
);

export const loadMagicPromptsCatalog = (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { signal?: AbortSignal },
): Promise<LynxCatalogLoadResult> => loadList(
  runtimeFetch,
  '/api/magic-prompts',
  { signal: options?.signal },
  ['prompts', 'items'],
);

export const loadSnippetsCatalog = (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { directory?: string | null; signal?: AbortSignal },
): Promise<LynxCatalogLoadResult> => {
  const directory = options?.directory?.trim();
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  return loadList(
    runtimeFetch,
    `/api/config/snippets${query}`,
    { signal: options?.signal },
    ['snippets', 'items'],
  );
};

const DEFAULT_USAGE_PROVIDERS = ['openai', 'anthropic', 'google'] as const;

/**
 * Cap usage page: per-provider `/api/quota/:id`. One failure stays on that row.
 */
export const loadUsageRows = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  providerIds: readonly string[] = DEFAULT_USAGE_PROVIDERS,
  options?: { signal?: AbortSignal },
): Promise<LynxUsageLoadResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const rows: LynxUsageRow[] = [];
    for (const providerId of providerIds) {
      try {
        const response = await runtimeFetch(`/api/quota/${encodeURIComponent(providerId)}`, {
          signal: options?.signal,
        });
        if (response.status === 0) {
          rows.push({
            providerId,
            status: 'failed',
            label: providerId,
            error: 'no-runtime',
          });
          continue;
        }
        if (!response.ok) {
          rows.push({
            providerId,
            status: 'failed',
            label: providerId,
            error: `HTTP ${response.status}`,
          });
          continue;
        }
        const data = asRecord(await response.json());
        const label = typeof data.displayName === 'string' ? data.displayName : providerId;
        const detail = typeof data.status === 'string'
          ? data.status
          : typeof data.message === 'string'
            ? data.message
            : undefined;
        rows.push({ providerId, status: 'ok', label, detail });
      } catch (error) {
        rows.push({
          providerId,
          status: 'failed',
          label: providerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { status: 'ok', rows };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

export const catalogLoaderForSlug = (
  slug: string,
): ((
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { directory?: string | null; signal?: AbortSignal },
) => Promise<LynxCatalogLoadResult>) | null => {
  switch (slug) {
    case 'providers':
      return loadProvidersCatalog;
    case 'agents':
      return loadAgentsCatalog;
    case 'mcp':
      return loadMcpCatalog;
    case 'plugins':
      return loadPluginsCatalog;
    case 'skills.installed':
      return loadInstalledSkillsCatalog;
    case 'commands':
      return loadCommandsCatalog;
    case 'magic-prompts':
      return loadMagicPromptsCatalog;
    case 'snippets':
      return loadSnippetsCatalog;
    default:
      return null;
  }
};
