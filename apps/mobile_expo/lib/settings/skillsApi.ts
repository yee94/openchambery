import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export class SkillsApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'SkillsApiError';
    this.status = status;
  }
}

export type SkillSummary = {
  name: string;
  description?: string;
  location?: string;
  scope?: string;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const parseSkillsSummary = (payload: unknown): SkillSummary[] => {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(asRecord(payload)?.skills)
      ? (asRecord(payload)!.skills as unknown[])
      : null;
  if (!list) throw new SkillsApiError('invalid_skills_response', 200);
  return list.flatMap((item) => {
    const row = asRecord(item);
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    if (!name) return [];
    return [{
      name,
      description: typeof row?.description === 'string' ? row.description : undefined,
      location: typeof row?.location === 'string' ? row.location : undefined,
      scope: typeof row?.scope === 'string' ? row.scope : undefined,
    }];
  });
};

/** GET /api/config/skills?summary=true */
export const loadInstalledSkills = async (
  active: ActiveRuntime,
  options?: { signal?: AbortSignal; directory?: string | null },
): Promise<SkillSummary[]> => {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let path = '/api/config/skills?summary=true';
  if (options?.directory?.trim()) {
    headers['x-opencode-directory'] = options.directory.trim();
    path += `&directory=${encodeURIComponent(options.directory.trim())}`;
  }
  const response = await openchamberFetch(active, path, { method: 'GET', headers, signal: options?.signal });
  if (!response.ok) throw new SkillsApiError('Failed to load skills', response.status);
  return parseSkillsSummary(await response.json());
};
