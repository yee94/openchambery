import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';
import {
  parseProjectsSettingsSlice,
  type ProjectsSettingsSlice,
} from '@/lib/projectsSettingsApi';

export class ProjectIconApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ProjectIconApiError';
    this.status = status;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

export type DiscoverProjectIconResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  settings?: ProjectsSettingsSlice;
};

/** POST /api/projects/:id/icon/discover */
export const discoverProjectIcon = async (
  active: ActiveRuntime,
  projectId: string,
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<DiscoverProjectIconResult> => {
  const response = await openchamberFetch(
    active,
    `/api/projects/${encodeURIComponent(projectId)}/icon/discover`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ force: options?.force === true }),
      signal: options?.signal,
    },
  );
  const payload = asRecord(await response.json());
  if (!response.ok) {
    return {
      ok: false,
      error: typeof payload?.error === 'string' ? payload.error : 'Failed to discover project icon',
    };
  }
  return {
    ok: true,
    skipped: payload?.skipped === true,
    reason: typeof payload?.reason === 'string' ? payload.reason : undefined,
    settings: payload?.settings ? parseProjectsSettingsSlice(payload.settings) : undefined,
  };
};

/** DELETE /api/projects/:id/icon */
export const removeProjectIcon = async (
  active: ActiveRuntime,
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<{ ok: boolean; error?: string; settings?: ProjectsSettingsSlice }> => {
  const response = await openchamberFetch(
    active,
    `/api/projects/${encodeURIComponent(projectId)}/icon`,
    {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
      signal: options?.signal,
    },
  );
  const payload = asRecord(await response.json());
  if (!response.ok) {
    return {
      ok: false,
      error: typeof payload?.error === 'string' ? payload.error : 'Failed to remove project icon',
    };
  }
  return {
    ok: true,
    settings: payload?.settings ? parseProjectsSettingsSlice(payload.settings) : undefined,
  };
};
