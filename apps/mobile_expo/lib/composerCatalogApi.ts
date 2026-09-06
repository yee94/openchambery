/**
 * Cap catalog endpoints used by slash / @ / # autocomplete.
 * Failures throw — callers treat empty as honest miss, never fake catalogs.
 */

import type { ActiveRuntime } from '@/lib/connectionController';
import type { ComposerAutocompleteKind, ComposerAutocompleteRow } from '@/lib/composerAutocomplete';
import { filterRowsByQuery } from '@/lib/composerAutocomplete';
import { openchamberFetch } from '@/lib/openchamberClient';

export class ComposerCatalogError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ComposerCatalogError';
    this.status = status;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const directoryHeaders = (directory?: string | null): Record<string, string> =>
  directory ? { 'x-opencode-directory': directory } : {};

export type SlashCommandCatalogItem = {
  id: string;
  name: string;
  description?: string;
  isBuiltIn?: boolean;
  isSkill?: boolean;
};

export type SkillCatalogItem = {
  name: string;
  scope: string;
  description?: string;
};

export type SnippetCatalogItem = {
  name: string;
  description?: string;
  aliases?: string[];
};

export type AgentCatalogItem = {
  name: string;
  description?: string;
};

export type FileMentionHit = {
  path: string;
  relativePath: string;
};

/** POST /api/config/commands/metadata { catalog: true } */
export const loadSlashCommands = async (
  active: ActiveRuntime,
  directory?: string | null,
  signal?: AbortSignal,
): Promise<SlashCommandCatalogItem[]> => {
  const params = new URLSearchParams();
  if (directory) params.set('directory', directory);
  const qs = params.toString();
  const response = await openchamberFetch(
    active,
    `/api/config/commands/metadata${qs ? `?${qs}` : ''}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        ...directoryHeaders(directory),
      },
      body: JSON.stringify({ catalog: true }),
      signal,
    },
  );
  if (!response.ok) {
    throw new ComposerCatalogError(`commands metadata failed (${response.status})`, response.status);
  }
  const payload = asRecord(await response.json());
  const commands = Array.isArray(payload?.commands) ? payload.commands : [];
  return commands.flatMap((entry, index) => {
    const row = asRecord(entry);
    if (!row || typeof row.name !== 'string' || !row.name.trim()) return [];
    const name = row.name.trim();
    return [
      {
        id: typeof row.id === 'string' && row.id ? row.id : `cmd:${name}:${index}`,
        name,
        description: typeof row.description === 'string' ? row.description : undefined,
        isBuiltIn: row.isBuiltIn === true,
        isSkill: row.isSkill === true,
      },
    ];
  });
};

/** GET /api/config/skills?summary=true */
export const loadInstalledSkills = async (
  active: ActiveRuntime,
  directory?: string | null,
  signal?: AbortSignal,
): Promise<SkillCatalogItem[]> => {
  const params = new URLSearchParams({ summary: 'true' });
  if (directory) params.set('directory', directory);
  const response = await openchamberFetch(active, `/api/config/skills?${params.toString()}`, {
    method: 'GET',
    headers: directoryHeaders(directory),
    signal,
  });
  if (!response.ok) {
    throw new ComposerCatalogError(`skills failed (${response.status})`, response.status);
  }
  const payload = asRecord(await response.json());
  const skills = Array.isArray(payload?.skills) ? payload.skills : [];
  return skills.flatMap((entry) => {
    const row = asRecord(entry);
    if (!row || typeof row.name !== 'string' || !row.name.trim()) return [];
    return [
      {
        name: row.name.trim(),
        scope: typeof row.scope === 'string' && row.scope ? row.scope : 'user',
        description: typeof row.description === 'string' ? row.description : undefined,
      },
    ];
  });
};

/** GET /api/config/snippets */
export const loadSnippets = async (
  active: ActiveRuntime,
  directory?: string | null,
  signal?: AbortSignal,
): Promise<SnippetCatalogItem[]> => {
  const params = new URLSearchParams();
  if (directory) params.set('directory', directory);
  const qs = params.toString();
  const response = await openchamberFetch(active, `/api/config/snippets${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers: directoryHeaders(directory),
    signal,
  });
  if (!response.ok) {
    throw new ComposerCatalogError(`snippets failed (${response.status})`, response.status);
  }
  const payload = await response.json();
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(asRecord(payload)?.snippets)
      ? (asRecord(payload)?.snippets as unknown[])
      : [];
  return list.flatMap((entry) => {
    const row = asRecord(entry);
    if (!row || typeof row.name !== 'string' || !row.name.trim()) return [];
    const aliases = Array.isArray(row.aliases)
      ? row.aliases.filter((alias): alias is string => typeof alias === 'string')
      : undefined;
    return [
      {
        name: row.name.trim(),
        description: typeof row.description === 'string' ? row.description : undefined,
        aliases,
      },
    ];
  });
};

/** GET /api/agent — Cap listAgents fallback. */
export const loadAgents = async (
  active: ActiveRuntime,
  directory?: string | null,
  signal?: AbortSignal,
): Promise<AgentCatalogItem[]> => {
  const params = new URLSearchParams();
  if (directory) params.set('directory', directory);
  const qs = params.toString();
  const response = await openchamberFetch(active, `/api/agent${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers: directoryHeaders(directory),
    signal,
  });
  if (!response.ok) {
    throw new ComposerCatalogError(`agents failed (${response.status})`, response.status);
  }
  const payload = await response.json();
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(asRecord(payload)?.agents)
      ? (asRecord(payload)?.agents as unknown[])
      : [];
  return list.flatMap((entry) => {
    const row = asRecord(entry);
    if (!row || typeof row.name !== 'string' || !row.name.trim()) return [];
    return [
      {
        name: row.name.trim(),
        description: typeof row.description === 'string' ? row.description : undefined,
      },
    ];
  });
};

/** GET /api/find/file — Cap web FilesAPI.search subset. */
export const searchMentionFiles = async (
  active: ActiveRuntime,
  input: { directory: string; query: string; limit?: number },
  signal?: AbortSignal,
): Promise<FileMentionHit[]> => {
  const directory = input.directory.trim();
  if (!directory) return [];
  const params = new URLSearchParams({
    directory,
    query: input.query.trim(),
    dirs: 'false',
    type: 'file',
  });
  if (typeof input.limit === 'number' && Number.isFinite(input.limit)) {
    params.set('limit', String(input.limit));
  }
  const response = await openchamberFetch(active, `/api/find/file?${params.toString()}`, {
    method: 'GET',
    headers: directoryHeaders(directory),
    signal,
  });
  if (!response.ok) {
    throw new ComposerCatalogError(`find file failed (${response.status})`, response.status);
  }
  const payload = await response.json();
  const files = Array.isArray(payload) ? payload : [];
  return files.flatMap((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) return [];
    const relativePath = entry.replace(/\\/g, '/').replace(/^\.\//, '');
    const path = `${directory.replace(/\/+$/, '')}/${relativePath}`.replace(/\/+/g, '/');
    return [{ path, relativePath }];
  });
};

export const buildAutocompleteRows = (
  kind: ComposerAutocompleteKind,
  query: string,
  catalogs: {
    commands: readonly SlashCommandCatalogItem[];
    skills: readonly SkillCatalogItem[];
    snippets: readonly SnippetCatalogItem[];
    agents: readonly AgentCatalogItem[];
    files: readonly FileMentionHit[];
  },
): ComposerAutocompleteRow[] => {
  if (kind === 'slash-command') {
    const rows: ComposerAutocompleteRow[] = catalogs.commands.map((command) => ({
      id: command.id,
      title: `/${command.name}`,
      subtitle: command.description,
      badge: command.isBuiltIn ? 'system' : command.isSkill ? 'skill' : 'command',
      insertText: `/${command.name}`,
    }));
    return filterRowsByQuery(rows, query);
  }

  if (kind === 'slash-skill') {
    const rows: ComposerAutocompleteRow[] = catalogs.skills.map((skill) => ({
      id: `skill:${skill.name}:${skill.scope}`,
      title: skill.name,
      subtitle: skill.description,
      badge: skill.scope,
      insertText: `/${skill.name}`,
    }));
    return filterRowsByQuery(rows, query);
  }

  if (kind === 'snippet') {
    const rows: ComposerAutocompleteRow[] = catalogs.snippets.map((snippet) => ({
      id: `snippet:${snippet.name}`,
      title: `#${snippet.name}`,
      subtitle: snippet.description,
      badge: 'snippet',
      insertText: `#${snippet.name}`,
    }));
    return filterRowsByQuery(rows, query);
  }

  const agentRows: ComposerAutocompleteRow[] = catalogs.agents.map((agent) => ({
    id: `agent:${agent.name}`,
    title: `@${agent.name}`,
    subtitle: agent.description,
    badge: 'agent',
    insertText: `@${agent.name}`,
  }));
  const fileRows: ComposerAutocompleteRow[] = catalogs.files.map((file) => ({
    id: `file:${file.path}`,
    title: file.relativePath || file.path,
    subtitle: file.path,
    badge: 'file',
    insertText: `@${file.relativePath || file.path}`,
  }));
  return filterRowsByQuery([...agentRows, ...fileRows], query);
};
