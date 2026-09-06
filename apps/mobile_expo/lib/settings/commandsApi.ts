import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export class CommandsApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'CommandsApiError';
    this.status = status;
  }
}

export type CommandItem = {
  name: string;
  description?: string;
  agent?: string | null;
  model?: string | null;
  template?: string;
  isBuiltIn?: boolean;
  scope?: 'user' | 'project';
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const parseCommandsCatalog = (payload: unknown): CommandItem[] => {
  const row = asRecord(payload);
  const list = Array.isArray(row?.commands) ? row!.commands as unknown[] : null;
  if (!list) throw new CommandsApiError('invalid_commands_response', 200);
  return list.flatMap((item) => {
    const c = asRecord(item);
    const name = typeof c?.name === 'string' ? c.name.trim() : '';
    if (!name) return [];
    return [{
      name,
      description: typeof c?.description === 'string' ? c.description : undefined,
      agent: typeof c?.agent === 'string' || c?.agent === null ? (c.agent as string | null) : undefined,
      model: typeof c?.model === 'string' || c?.model === null ? (c.model as string | null) : undefined,
      template: typeof c?.template === 'string' ? c.template : undefined,
      isBuiltIn: typeof c?.isBuiltIn === 'boolean' ? c.isBuiltIn : undefined,
      scope: c?.scope === 'user' || c?.scope === 'project' ? c.scope : undefined,
    }];
  });
};

/** POST /api/config/commands/metadata { catalog: true } */
export const loadCommandsCatalog = async (
  active: ActiveRuntime,
  options?: { signal?: AbortSignal; directory?: string | null },
): Promise<CommandItem[]> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Cache-Control': 'no-cache',
  };
  let path = '/api/config/commands/metadata';
  if (options?.directory?.trim()) {
    headers['x-opencode-directory'] = options.directory.trim();
    path += `?directory=${encodeURIComponent(options.directory.trim())}`;
  }
  const response = await openchamberFetch(active, path, {
    method: 'POST',
    headers,
    body: JSON.stringify({ catalog: true }),
    signal: options?.signal,
  });
  if (!response.ok) throw new CommandsApiError('Failed to load commands', response.status);
  return parseCommandsCatalog(await response.json());
};
