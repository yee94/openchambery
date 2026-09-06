import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';
import { createProjectIdFromPath } from '@/lib/projectId';
import { isProjectColorKey, isProjectIconKey } from '@/lib/projectMeta';
import { normalizePath } from '@/lib/sessionHomeModel';

export type ProjectEntry = {
  id: string;
  path: string;
  label?: string;
  icon?: string | null;
  iconImage?: {
    mime: string;
    updatedAt: number;
    source: 'custom' | 'auto';
  } | null;
  iconBackground?: string | null;
  color?: string | null;
  defaultModel?: string;
  addedAt?: number;
  lastOpenedAt?: number;
};

export type ProjectsSettingsSlice = {
  projects: ProjectEntry[];
  activeProjectId: string | null;
};

export class ProjectsSettingsError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ProjectsSettingsError';
    this.status = status;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

export const parseProjectEntry = (value: unknown): ProjectEntry | null => {
  const row = asRecord(value);
  if (!row) return null;
  const path = typeof row.path === 'string' ? normalizePath(row.path) : '';
  if (!path) return null;
  const id =
    typeof row.id === 'string' && row.id.trim()
      ? row.id.trim()
      : createProjectIdFromPath(path);
  const iconImageRaw = asRecord(row.iconImage);
  const iconImage =
    iconImageRaw &&
    typeof iconImageRaw.mime === 'string' &&
    typeof iconImageRaw.updatedAt === 'number'
      ? {
          mime: iconImageRaw.mime,
          updatedAt: iconImageRaw.updatedAt,
          source: iconImageRaw.source === 'custom' ? ('custom' as const) : ('auto' as const),
        }
      : null;
  return {
    id,
    path,
    label: typeof row.label === 'string' ? row.label : undefined,
    icon: isProjectIconKey(row.icon) ? row.icon : typeof row.icon === 'string' ? row.icon : null,
    iconImage,
    iconBackground: typeof row.iconBackground === 'string' ? row.iconBackground : null,
    color: isProjectColorKey(row.color) ? row.color : typeof row.color === 'string' ? row.color : null,
    defaultModel: typeof row.defaultModel === 'string' ? row.defaultModel : undefined,
    addedAt: typeof row.addedAt === 'number' ? row.addedAt : undefined,
    lastOpenedAt: typeof row.lastOpenedAt === 'number' ? row.lastOpenedAt : undefined,
  };
};

export const parseProjectsSettingsSlice = (payload: unknown): ProjectsSettingsSlice => {
  const record = asRecord(payload);
  const projects = Array.isArray(record?.projects)
    ? record.projects.flatMap((entry) => {
        const parsed = parseProjectEntry(entry);
        return parsed ? [parsed] : [];
      })
    : [];
  const activeProjectId =
    typeof record?.activeProjectId === 'string' && record.activeProjectId.trim()
      ? record.activeProjectId.trim()
      : null;
  return { projects, activeProjectId };
};

/** GET /api/config/settings — projects + activeProjectId slice. */
export const loadProjectsSettings = async (
  active: ActiveRuntime,
  options?: { signal?: AbortSignal },
): Promise<ProjectsSettingsSlice> => {
  const response = await openchamberFetch(active, '/api/config/settings', {
    method: 'GET',
    signal: options?.signal,
  });
  if (!response.ok) {
    throw new ProjectsSettingsError('Failed to load projects settings', response.status);
  }
  return parseProjectsSettingsSlice(await response.json());
};

/**
 * PUT /api/config/settings — Cap projects settings write.
 * Pass the full projects array (plus optional activeProjectId).
 */
export const putProjectsSettings = async (
  active: ActiveRuntime,
  changes: { projects: ProjectEntry[]; activeProjectId?: string | null },
  options?: { signal?: AbortSignal },
): Promise<ProjectsSettingsSlice> => {
  const body: Record<string, unknown> = { projects: changes.projects };
  if (changes.activeProjectId !== undefined) {
    body.activeProjectId = changes.activeProjectId;
  }
  const response = await openchamberFetch(active, '/api/config/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: options?.signal,
  });
  if (!response.ok) {
    throw new ProjectsSettingsError('Failed to save projects settings', response.status);
  }
  const payload = await response.json();
  // Some hosts echo full settings; others may return empty — prefer response, else echo request.
  const parsed = parseProjectsSettingsSlice(payload);
  if (parsed.projects.length > 0 || changes.projects.length === 0) return parsed;
  return {
    projects: changes.projects,
    activeProjectId: changes.activeProjectId ?? null,
  };
};

export const projectLabelFromPath = (path: string, label?: string | null): string => {
  if (label?.trim()) return label.trim();
  const normalized = normalizePath(path);
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] || normalized;
};

export const buildProjectEntry = (
  path: string,
  options?: { label?: string; id?: string; icon?: string | null; color?: string | null },
): ProjectEntry => {
  const normalized = normalizePath(path);
  return {
    id: options?.id?.trim() || createProjectIdFromPath(normalized),
    path: normalized,
    label: options?.label?.trim() || projectLabelFromPath(normalized),
    icon: options?.icon ?? null,
    color: options?.color ?? null,
    addedAt: Date.now(),
    lastOpenedAt: Date.now(),
  };
};
