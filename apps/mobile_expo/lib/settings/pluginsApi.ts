import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export class PluginsApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'PluginsApiError';
    this.status = status;
  }
}

export type PluginEntry = {
  id: string;
  spec?: string;
  enabled?: boolean;
  scope?: string;
  [key: string]: unknown;
};

export type PluginFile = {
  id: string;
  fileName?: string;
  scope?: string;
  [key: string]: unknown;
};

export type PluginsList = {
  entries: PluginEntry[];
  files: PluginFile[];
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const parsePluginsList = (payload: unknown): PluginsList => {
  const row = asRecord(payload);
  if (!row) throw new PluginsApiError('invalid_plugins_response', 200);
  const entries = Array.isArray(row.entries)
    ? row.entries.flatMap((item) => {
        const e = asRecord(item);
        const id = typeof e?.id === 'string' ? e.id : typeof e?.spec === 'string' ? e.spec : '';
        if (!id) return [];
        return [{ ...(e as PluginEntry), id }];
      })
    : [];
  const files = Array.isArray(row.files)
    ? row.files.flatMap((item) => {
        const f = asRecord(item);
        const id = typeof f?.id === 'string' ? f.id : typeof f?.fileName === 'string' ? f.fileName : '';
        if (!id) return [];
        return [{ ...(f as PluginFile), id }];
      })
    : [];
  return { entries, files };
};

const withDirectory = (path: string, directory?: string | null): { path: string; headers: Record<string, string> } => {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (directory?.trim()) {
    headers['x-opencode-directory'] = directory.trim();
    const sep = path.includes('?') ? '&' : '?';
    return { path: `${path}${sep}directory=${encodeURIComponent(directory.trim())}`, headers };
  }
  return { path, headers };
};

/** GET /api/config/plugins */
export const loadPlugins = async (
  active: ActiveRuntime,
  options?: { signal?: AbortSignal; directory?: string | null },
): Promise<PluginsList> => {
  const { path, headers } = withDirectory('/api/config/plugins', options?.directory);
  const response = await openchamberFetch(active, path, { method: 'GET', headers, signal: options?.signal });
  if (!response.ok) throw new PluginsApiError('Failed to load plugins', response.status);
  return parsePluginsList(await response.json());
};

/** POST /api/config/plugins/entry */
export const createPluginEntry = async (
  active: ActiveRuntime,
  body: Record<string, unknown>,
  options?: { directory?: string | null },
): Promise<void> => {
  const { path, headers } = withDirectory('/api/config/plugins/entry', options?.directory);
  headers['Content-Type'] = 'application/json';
  const response = await openchamberFetch(active, path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new PluginsApiError('Failed to create plugin', response.status);
};

/** DELETE /api/config/plugins/entry/:id */
export const deletePluginEntry = async (
  active: ActiveRuntime,
  id: string,
  options?: { directory?: string | null },
): Promise<void> => {
  const { path, headers } = withDirectory(
    `/api/config/plugins/entry/${encodeURIComponent(id)}`,
    options?.directory,
  );
  const response = await openchamberFetch(active, path, { method: 'DELETE', headers });
  if (!response.ok) throw new PluginsApiError('Failed to delete plugin', response.status);
};

/** GET /api/config/plugins/file/:id — Cap plugins file API */
export const loadPluginFile = async (
  active: ActiveRuntime,
  id: string,
  options?: { directory?: string | null },
): Promise<{ fileName: string; content: string }> => {
  const { path, headers } = withDirectory(
    `/api/config/plugins/file/${encodeURIComponent(id)}`,
    options?.directory,
  );
  const response = await openchamberFetch(active, path, { method: 'GET', headers });
  if (!response.ok) throw new PluginsApiError('Failed to read plugin file', response.status);
  const row = asRecord(await response.json()) ?? {};
  return {
    fileName: typeof row.fileName === 'string' ? row.fileName : id,
    content: typeof row.content === 'string' ? row.content : '',
  };
};

/** PUT /api/config/plugins/file/:id */
export const putPluginFile = async (
  active: ActiveRuntime,
  id: string,
  content: string,
  options?: { directory?: string | null },
): Promise<void> => {
  const { path, headers } = withDirectory(
    `/api/config/plugins/file/${encodeURIComponent(id)}`,
    options?.directory,
  );
  headers['Content-Type'] = 'application/json';
  const response = await openchamberFetch(active, path, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ content }),
  });
  if (!response.ok) throw new PluginsApiError('Failed to save plugin file', response.status);
};
