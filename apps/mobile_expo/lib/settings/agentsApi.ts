import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export class AgentsApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'AgentsApiError';
    this.status = status;
  }
}

export type AgentListItem = {
  name: string;
  description?: string;
  mode?: string;
  native?: boolean;
  hidden?: boolean;
  scope?: 'user' | 'project';
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const parseAgentList = (payload: unknown): AgentListItem[] => {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(asRecord(payload)?.agents)
      ? (asRecord(payload)!.agents as unknown[])
      : null;
  if (!list) throw new AgentsApiError('invalid_agents_response', 200);
  return list.flatMap((item) => {
    const row = asRecord(item);
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    if (!name) return [];
    return [{
      name,
      description: typeof row?.description === 'string' ? row.description : undefined,
      mode: typeof row?.mode === 'string' ? row.mode : undefined,
      native: typeof row?.native === 'boolean' ? row.native : undefined,
      hidden: typeof row?.hidden === 'boolean' ? row.hidden : undefined,
      scope: row?.scope === 'user' || row?.scope === 'project' ? row.scope : undefined,
    }];
  });
};

/** GET /api/agent — Cap inventory contract. Failure ≠ empty. */
export const loadAgents = async (
  active: ActiveRuntime,
  options?: { signal?: AbortSignal; directory?: string | null },
): Promise<AgentListItem[]> => {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options?.directory?.trim()) headers['x-opencode-directory'] = options.directory.trim();
  const response = await openchamberFetch(active, '/api/agent', {
    method: 'GET',
    headers,
    signal: options?.signal,
  });
  if (!response.ok) throw new AgentsApiError('Failed to load agents', response.status);
  return parseAgentList(await response.json());
};

/** POST /api/config/agents/metadata — attach scope when available. */
export const loadAgentMetadata = async (
  active: ActiveRuntime,
  names: string[],
  options?: { signal?: AbortSignal; directory?: string | null },
): Promise<Record<string, { scope?: 'user' | 'project' }>> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Cache-Control': 'no-cache',
  };
  if (options?.directory?.trim()) headers['x-opencode-directory'] = options.directory.trim();
  const response = await openchamberFetch(active, '/api/config/agents/metadata', {
    method: 'POST',
    headers,
    body: JSON.stringify({ names }),
    signal: options?.signal,
  });
  if (!response.ok) throw new AgentsApiError('Failed to load agent metadata', response.status);
  const row = asRecord(await response.json());
  const agents = asRecord(row?.agents) ?? {};
  const out: Record<string, { scope?: 'user' | 'project' }> = {};
  for (const [name, value] of Object.entries(agents)) {
    const meta = asRecord(value);
    const scope = meta?.scope;
    out[name] = {
      scope: scope === 'user' || scope === 'project' ? scope : undefined,
    };
  }
  return out;
};
