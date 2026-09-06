import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export class McpApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'McpApiError';
    this.status = status;
  }
}

export type McpServerConfig = {
  name: string;
  type?: string;
  command?: string;
  url?: string;
  enabled?: boolean;
  oauthEnabled?: boolean;
  [key: string]: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const parseMcpServerList = (payload: unknown): McpServerConfig[] => {
  if (!Array.isArray(payload)) throw new McpApiError('invalid_mcp_response', 200);
  return payload.flatMap((item) => {
    const row = asRecord(item);
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    if (!name) return [];
    return [{ ...row, name } as McpServerConfig];
  });
};

/** GET /api/config/mcp */
export const loadMcpServers = async (
  active: ActiveRuntime,
  options?: { signal?: AbortSignal; directory?: string | null },
): Promise<McpServerConfig[]> => {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let path = '/api/config/mcp';
  if (options?.directory?.trim()) {
    headers['x-opencode-directory'] = options.directory.trim();
    path += `?directory=${encodeURIComponent(options.directory.trim())}`;
  }
  const response = await openchamberFetch(active, path, { method: 'GET', headers, signal: options?.signal });
  if (!response.ok) throw new McpApiError('Failed to load MCP servers', response.status);
  return parseMcpServerList(await response.json());
};

/** POST /api/config/mcp/:name — create/update */
export const upsertMcpServer = async (
  active: ActiveRuntime,
  name: string,
  config: Record<string, unknown>,
  options?: { directory?: string | null },
): Promise<void> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  let path = `/api/config/mcp/${encodeURIComponent(name)}`;
  if (options?.directory?.trim()) {
    headers['x-opencode-directory'] = options.directory.trim();
    path += `?directory=${encodeURIComponent(options.directory.trim())}`;
  }
  const response = await openchamberFetch(active, path, {
    method: 'POST',
    headers,
    body: JSON.stringify(config),
  });
  if (!response.ok) throw new McpApiError('Failed to save MCP server', response.status);
};

/** DELETE /api/config/mcp/:name */
export const deleteMcpServer = async (
  active: ActiveRuntime,
  name: string,
  options?: { directory?: string | null },
): Promise<void> => {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let path = `/api/config/mcp/${encodeURIComponent(name)}`;
  if (options?.directory?.trim()) {
    headers['x-opencode-directory'] = options.directory.trim();
    path += `?directory=${encodeURIComponent(options.directory.trim())}`;
  }
  const response = await openchamberFetch(active, path, { method: 'DELETE', headers });
  if (!response.ok) throw new McpApiError('Failed to delete MCP server', response.status);
};

/** POST /api/mcp/auth/pending — Cap MCP OAuth pending context. */
export const queueMcpOAuthPending = async (
  active: ActiveRuntime,
  input: { state: string; name: string; directory?: string | null },
): Promise<void> => {
  const response = await openchamberFetch(active, '/api/mcp/auth/pending', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      state: input.state,
      name: input.name,
      directory: input.directory?.trim() || null,
    }),
  });
  if (!response.ok) throw new McpApiError('Failed to prepare MCP OAuth', response.status);
};

export const openMcpOAuthUrl = async (url: string): Promise<void> => {
  if (!url.trim()) throw new McpApiError('missing_oauth_url');
  const { openExternalBrowser, ExternalBrowserError } = await import('@/lib/systemShell/externalBrowser');
  try {
    await openExternalBrowser(url);
  } catch (error) {
    if (error instanceof ExternalBrowserError) throw new McpApiError('missing_oauth_url');
    throw error;
  }
};
