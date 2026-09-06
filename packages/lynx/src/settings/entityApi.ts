/**
 * Settings entity detail + save/delete against Cap mobile CRUD routes.
 * failure ≠ empty / fake-success.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { loadLynxSettings, saveLynxSettings } from './api';
import { catalogLoaderForSlug, type LynxCatalogItem } from './catalogs';

export type LynxEntityKind =
  | 'providers'
  | 'agents'
  | 'assistants'
  | 'mcp'
  | 'plugins'
  | 'commands'
  | 'snippets'
  | 'magic-prompts'
  | 'skills.installed'
  | 'projects';

export type LynxEntityFieldKey =
  | 'title'
  | 'description'
  | 'content'
  | 'prompt'
  | 'instructions'
  | 'path'
  | 'model'
  | 'mode'
  | 'spec'
  | 'command'
  | 'name';

export type LynxEntityDetail = {
  kind: LynxEntityKind;
  id: string;
  title: string;
  /** Editable text fields shown in the detail push. */
  fields: Partial<Record<LynxEntityFieldKey, string>>;
  /** Opaque Cap payload retained for save/delete (revision, scope, …). */
  meta: Record<string, unknown>;
  /** Providers: Cap auth clear only — no generic entity PUT. */
  saveUnsupportedReason?: string;
};

export type LynxEntityLoadResult =
  | { status: 'ok'; detail: LynxEntityDetail }
  | { status: 'no-runtime' }
  | { status: 'unsupported' }
  | { status: 'not-found' }
  | { status: 'failed'; error: Error; httpStatus?: number };

export type LynxEntityMutationResult =
  | { status: 'ok' }
  | { status: 'no-runtime' }
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; error: Error; httpStatus?: number };

const asRecord = (data: unknown): Record<string, unknown> => (
  data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
);

const directoryQuery = (directory?: string | null): string => {
  const trimmed = directory?.trim();
  return trimmed ? `?directory=${encodeURIComponent(trimmed)}` : '';
};

const directoryHeaders = (directory?: string | null): Record<string, string> => (
  directory?.trim()
    ? { 'x-opencode-directory': directory.trim() }
    : {}
);

const str = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

async function mutateJson(
  runtimeFetch: LynxRuntimeFetch,
  path: string,
  init: {
    method: string;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
): Promise<LynxEntityMutationResult> {
  try {
    const response = await runtimeFetch(path, {
      method: init.method,
      headers: {
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 404 || response.status === 501) {
      return { status: 'unsupported', reason: `HTTP ${response.status}` };
    }
    if (!response.ok) {
      const payload = asRecord(await response.json().catch(() => null));
      const message = str(payload.error) || `${init.method} ${path} failed (${response.status})`;
      return { status: 'failed', error: new Error(message), httpStatus: response.status };
    }
    return { status: 'ok' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

async function getJson(
  runtimeFetch: LynxRuntimeFetch,
  path: string,
  options?: { headers?: Record<string, string>; signal?: AbortSignal },
): Promise<
  | { status: 'ok'; data: unknown }
  | { status: 'no-runtime' }
  | { status: 'unsupported' }
  | { status: 'failed'; error: Error; httpStatus?: number }
> {
  try {
    const response = await runtimeFetch(path, {
      method: 'GET',
      headers: { Accept: 'application/json', ...options?.headers },
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 404 || response.status === 501) return { status: 'unsupported' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`GET ${path} failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    return { status: 'ok', data: await response.json() };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

const listFromUnknown = (data: unknown, keys: string[]): unknown[] => {
  if (Array.isArray(data)) return data;
  const record = asRecord(data);
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
};

const findInList = (entries: unknown[], id: string): Record<string, unknown> | null => {
  for (const entry of entries) {
    if (typeof entry === 'string' && entry === id) return { id, name: entry };
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const candidate = str(record.id) || str(record.name) || str(record.providerID);
    if (candidate === id) return record;
  }
  return null;
};

export const isLynxEntityKind = (value: string): value is LynxEntityKind => (
  value === 'providers'
  || value === 'agents'
  || value === 'assistants'
  || value === 'mcp'
  || value === 'plugins'
  || value === 'commands'
  || value === 'snippets'
  || value === 'magic-prompts'
  || value === 'skills.installed'
  || value === 'projects'
);

/** Cap detail GET + field projection. Never invents a successful empty entity. */
export const loadLynxEntityDetail = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  kind: LynxEntityKind,
  id: string,
  options?: { directory?: string | null; signal?: AbortSignal; listItem?: LynxCatalogItem },
): Promise<LynxEntityLoadResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const directory = options?.directory ?? null;
  const q = directoryQuery(directory);
  const headers = directoryHeaders(directory);

  try {
    switch (kind) {
      case 'providers': {
        const source = await getJson(
          runtimeFetch,
          `/api/provider/${encodeURIComponent(id)}/source`,
          { signal: options?.signal },
        );
        if (source.status === 'ok') {
          const payload = asRecord(source.data);
          return {
            status: 'ok',
            detail: {
              kind,
              id,
              title: options?.listItem?.title ?? id,
              fields: {
                title: options?.listItem?.title ?? id,
                description: options?.listItem?.subtitle ?? str(payload.message) ?? '',
              },
              meta: payload,
              saveUnsupportedReason: 'Cap provider auth flows are not a generic entity PUT; use delete to clear auth.',
            },
          };
        }
        // Fall back to list item chrome when source endpoint is missing — still not fake-success empty.
        if (options?.listItem) {
          return {
            status: 'ok',
            detail: {
              kind,
              id,
              title: options.listItem.title,
              fields: { title: options.listItem.title, description: options.listItem.subtitle ?? '' },
              meta: {},
              saveUnsupportedReason: 'Cap provider auth flows are not a generic entity PUT; use delete to clear auth.',
            },
          };
        }
        if (source.status === 'failed') return source;
        if (source.status === 'no-runtime') return source;
        return { status: 'unsupported' };
      }
      case 'agents': {
        const result = await getJson(runtimeFetch, `/api/config/agents/${encodeURIComponent(id)}${q}`, {
          headers,
          signal: options?.signal,
        });
        if (result.status === 'ok') {
          const record = asRecord(result.data);
          return {
            status: 'ok',
            detail: {
              kind,
              id,
              title: str(record.name) ?? id,
              fields: {
                name: str(record.name) ?? id,
                description: str(record.description) ?? '',
                prompt: str(record.prompt) ?? '',
                model: str(record.model) ?? '',
                mode: str(record.mode) ?? '',
              },
              meta: record,
            },
          };
        }
        // Cap list is `/api/agent` — detail may 404; use list item + empty editable fields.
        if (options?.listItem && (result.status === 'unsupported' || result.status === 'failed')) {
          return {
            status: 'ok',
            detail: {
              kind,
              id,
              title: options.listItem.title,
              fields: {
                name: options.listItem.title,
                description: options.listItem.subtitle ?? '',
                prompt: '',
                model: '',
                mode: '',
              },
              meta: {},
            },
          };
        }
        return result.status === 'failed' ? result : result.status === 'no-runtime' ? result : { status: 'not-found' };
      }
      case 'mcp': {
        const list = await getJson(runtimeFetch, `/api/config/mcp${q}`, { signal: options?.signal });
        if (list.status !== 'ok') return list.status === 'failed' ? list : list;
        const record = findInList(listFromUnknown(list.data, ['servers', 'mcp', 'items']), id);
        if (!record) return { status: 'not-found' };
        return {
          status: 'ok',
          detail: {
            kind,
            id,
            title: str(record.name) ?? id,
            fields: {
              name: str(record.name) ?? id,
              description: str(record.description) ?? '',
              command: str(record.command) ?? str(asRecord(record.config).command) ?? '',
            },
            meta: record,
          },
        };
      }
      case 'plugins': {
        const list = await getJson(runtimeFetch, `/api/config/plugins${q}`, { signal: options?.signal });
        if (list.status !== 'ok') return list.status === 'failed' ? list : list;
        const entries = listFromUnknown(list.data, ['plugins', 'entries', 'items']);
        const files = listFromUnknown(asRecord(list.data).files, []);
        const record = findInList([...entries, ...files], id);
        if (!record && options?.listItem) {
          return {
            status: 'ok',
            detail: {
              kind,
              id,
              title: options.listItem.title,
              fields: { title: options.listItem.title, spec: options.listItem.subtitle ?? '' },
              meta: { pluginKind: 'entry' },
            },
          };
        }
        if (!record) return { status: 'not-found' };
        const pluginKind = 'entry';
        return {
          status: 'ok',
          detail: {
            kind,
            id,
            title: str(record.name) ?? str(record.spec) ?? id,
            fields: {
              title: str(record.name) ?? str(record.spec) ?? id,
              spec: str(record.spec) ?? '',
              description: str(record.description) ?? '',
            },
            meta: { ...record, pluginKind },
          },
        };
      }
      case 'commands': {
        const loader = catalogLoaderForSlug('commands');
        const catalog = loader ? await loader(runtimeFetch, { directory, signal: options?.signal }) : null;
        if (!catalog) return { status: 'failed', error: new Error('no commands loader') };
        if (catalog.status !== 'ok') {
          return catalog.status === 'failed'
            ? { status: 'failed', error: catalog.error, httpStatus: catalog.httpStatus }
            : catalog.status === 'no-runtime'
              ? { status: 'no-runtime' }
              : { status: 'unsupported' };
        }
        const item = catalog.items.find((row) => row.id === id);
        if (!item && !options?.listItem) return { status: 'not-found' };
        const title = item?.title ?? options?.listItem?.title ?? id;
        const detailGet = await getJson(
          runtimeFetch,
          `/api/config/commands/${encodeURIComponent(id)}${q}`,
          { headers, signal: options?.signal },
        );
        const record = detailGet.status === 'ok' ? asRecord(detailGet.data) : {};
        return {
          status: 'ok',
          detail: {
            kind,
            id,
            title,
            fields: {
              name: str(record.name) ?? title,
              description: str(record.description) ?? item?.subtitle ?? '',
              content: str(record.template) ?? str(record.content) ?? str(record.prompt) ?? '',
            },
            meta: record,
          },
        };
      }
      case 'snippets': {
        const detailGet = await getJson(
          runtimeFetch,
          `/api/config/snippets/${encodeURIComponent(id)}${q}`,
          { headers, signal: options?.signal },
        );
        if (detailGet.status === 'ok') {
          const record = asRecord(detailGet.data);
          return {
            status: 'ok',
            detail: {
              kind,
              id,
              title: str(record.name) ?? id,
              fields: {
                name: str(record.name) ?? id,
                description: str(record.description) ?? '',
                content: str(record.content) ?? '',
              },
              meta: record,
            },
          };
        }
        if (options?.listItem && detailGet.status !== 'no-runtime') {
          return {
            status: 'ok',
            detail: {
              kind,
              id,
              title: options.listItem.title,
              fields: {
                name: options.listItem.title,
                description: options.listItem.subtitle ?? '',
                content: '',
              },
              meta: {},
            },
          };
        }
        return detailGet.status === 'failed' ? detailGet : detailGet.status === 'no-runtime' ? detailGet : { status: 'not-found' };
      }
      case 'magic-prompts': {
        const list = await getJson(runtimeFetch, '/api/magic-prompts', { signal: options?.signal });
        if (list.status !== 'ok') return list.status === 'failed' ? list : list;
        const record = findInList(listFromUnknown(list.data, ['prompts', 'items']), id)
          ?? (options?.listItem ? { id, name: options.listItem.title } : null);
        if (!record) return { status: 'not-found' };
        return {
          status: 'ok',
          detail: {
            kind,
            id,
            title: str(record.name) ?? str(record.title) ?? id,
            fields: {
              title: str(record.name) ?? str(record.title) ?? id,
              content: str(record.text) ?? str(record.content) ?? str(record.override) ?? '',
            },
            meta: record,
          },
        };
      }
      case 'skills.installed': {
        const detailGet = await getJson(
          runtimeFetch,
          `/api/config/skills/${encodeURIComponent(id)}${q}`,
          { signal: options?.signal },
        );
        if (detailGet.status === 'ok') {
          const record = asRecord(detailGet.data);
          return {
            status: 'ok',
            detail: {
              kind,
              id,
              title: str(record.name) ?? id,
              fields: {
                name: str(record.name) ?? id,
                description: str(record.description) ?? '',
                instructions: str(record.instructions) ?? '',
              },
              meta: record,
            },
          };
        }
        if (options?.listItem && detailGet.status !== 'no-runtime') {
          return {
            status: 'ok',
            detail: {
              kind,
              id,
              title: options.listItem.title,
              fields: {
                name: options.listItem.title,
                description: options.listItem.subtitle ?? '',
                instructions: '',
              },
              meta: {},
            },
          };
        }
        return detailGet.status === 'failed' ? detailGet : detailGet.status === 'no-runtime' ? detailGet : { status: 'not-found' };
      }
      case 'assistants': {
        const snap = await getJson(runtimeFetch, '/api/openchamber/assistants/snapshot', {
          signal: options?.signal,
        });
        if (snap.status !== 'ok') return snap.status === 'failed' ? snap : snap;
        const payload = asRecord(snap.data);
        const assistants = listFromUnknown(payload.assistants ?? payload, ['assistants']);
        const record = findInList(assistants, id);
        if (!record) return { status: 'not-found' };
        return {
          status: 'ok',
          detail: {
            kind,
            id,
            title: str(record.name) ?? id,
            fields: {
              name: str(record.name) ?? id,
              description: str(record.description) ?? '',
              mode: str(record.mode) ?? '',
              path: str(record.effectiveWorkspacePath) ?? str(record.workspacePath) ?? '',
            },
            meta: record,
          },
        };
      }
      case 'projects': {
        const settings = await loadLynxSettings(runtimeFetch, { signal: options?.signal });
        if (settings.status !== 'ok') {
          return settings.status === 'failed'
            ? { status: 'failed', error: settings.error, httpStatus: settings.httpStatus }
            : { status: 'no-runtime' };
        }
        const projects = Array.isArray(settings.settings.projects) ? settings.settings.projects : [];
        const match = projects.find((project) => {
          const projectId = str(project.id) || str(project.path);
          return projectId === id;
        });
        if (!match) return { status: 'not-found' };
        return {
          status: 'ok',
          detail: {
            kind,
            id,
            title: str(match.name) ?? str(match.path) ?? id,
            fields: {
              name: str(match.name) ?? '',
              path: str(match.path) ?? '',
            },
            meta: { ...match },
          },
        };
      }
    }
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/** Cap save for the entity kind. Providers return unsupported (auth-only). */
export const saveLynxEntity = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  detail: LynxEntityDetail,
  fields: Partial<Record<LynxEntityFieldKey, string>>,
  options?: { directory?: string | null; signal?: AbortSignal },
): Promise<LynxEntityMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  if (detail.saveUnsupportedReason) {
    return { status: 'unsupported', reason: detail.saveUnsupportedReason };
  }
  const directory = options?.directory ?? null;
  const q = directoryQuery(directory);
  const headers = directoryHeaders(directory);
  const id = detail.id;

  switch (detail.kind) {
    case 'providers':
      return { status: 'unsupported', reason: 'provider auth is not a generic entity PUT' };
    case 'agents':
      return mutateJson(runtimeFetch, `/api/config/agents/${encodeURIComponent(id)}${q}`, {
        method: 'PATCH',
        headers,
        body: {
          description: fields.description,
          prompt: fields.prompt,
          model: fields.model || undefined,
          mode: fields.mode || undefined,
        },
        signal: options?.signal,
      });
    case 'mcp':
      return mutateJson(runtimeFetch, `/api/config/mcp/${encodeURIComponent(id)}${q}`, {
        method: 'PATCH',
        headers,
        body: {
          description: fields.description,
          ...(fields.command ? { command: fields.command } : {}),
        },
        signal: options?.signal,
      });
    case 'plugins':
      return mutateJson(runtimeFetch, `/api/config/plugins/entry/${encodeURIComponent(id)}${q}`, {
        method: 'PATCH',
        headers,
        body: {
          ...(fields.spec ? { spec: fields.spec } : {}),
          ...(fields.description ? { description: fields.description } : {}),
        },
        signal: options?.signal,
      });
    case 'commands':
      return mutateJson(runtimeFetch, `/api/config/commands/${encodeURIComponent(id)}${q}`, {
        method: 'PATCH',
        headers,
        body: {
          description: fields.description,
          template: fields.content,
        },
        signal: options?.signal,
      });
    case 'snippets':
      return mutateJson(runtimeFetch, `/api/config/snippets/${encodeURIComponent(id)}${q}`, {
        method: 'PATCH',
        headers,
        body: {
          description: fields.description,
          content: fields.content,
        },
        signal: options?.signal,
      });
    case 'magic-prompts':
      return mutateJson(runtimeFetch, `/api/magic-prompts/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: { text: fields.content ?? '' },
        signal: options?.signal,
      });
    case 'skills.installed':
      return mutateJson(runtimeFetch, `/api/config/skills/${encodeURIComponent(id)}${q}`, {
        method: 'PATCH',
        body: {
          description: fields.description,
          instructions: fields.instructions,
        },
        signal: options?.signal,
      });
    case 'assistants': {
      const revision = detail.meta.revision;
      return mutateJson(runtimeFetch, `/api/openchamber/assistants/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: {
          name: fields.name,
          description: fields.description,
          mode: fields.mode,
          expectedRevision: revision,
        },
        signal: options?.signal,
      });
    }
    case 'projects': {
      const loaded = await loadLynxSettings(runtimeFetch, { signal: options?.signal });
      if (loaded.status === 'no-runtime') return { status: 'no-runtime' };
      if (loaded.status === 'failed') {
        return { status: 'failed', error: loaded.error, httpStatus: loaded.httpStatus };
      }
      const projects = Array.isArray(loaded.settings.projects) ? [...loaded.settings.projects] : [];
      const index = projects.findIndex((project) => {
        const projectId = str(project.id) || str(project.path);
        return projectId === id;
      });
      if (index < 0) {
        return { status: 'failed', error: new Error('project not found') };
      }
      projects[index] = {
        ...projects[index],
        name: fields.name ?? projects[index]?.name,
        path: fields.path ?? projects[index]?.path,
      };
      const saved = await saveLynxSettings(runtimeFetch, { projects }, { signal: options?.signal });
      if (saved.status === 'ok') return { status: 'ok' };
      if (saved.status === 'no-runtime') return { status: 'no-runtime' };
      return { status: 'failed', error: saved.error, httpStatus: saved.httpStatus };
    }
  }
};

/** Cap delete / reset for the entity kind. */
export const deleteLynxEntity = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  detail: LynxEntityDetail,
  options?: { directory?: string | null; signal?: AbortSignal },
): Promise<LynxEntityMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const directory = options?.directory ?? null;
  const q = directoryQuery(directory);
  const headers = directoryHeaders(directory);
  const id = detail.id;

  switch (detail.kind) {
    case 'providers':
      return mutateJson(runtimeFetch, `/api/provider/${encodeURIComponent(id)}/auth?scope=all`, {
        method: 'DELETE',
        signal: options?.signal,
      });
    case 'agents':
      return mutateJson(runtimeFetch, `/api/config/agents/${encodeURIComponent(id)}${q}`, {
        method: 'DELETE',
        headers,
        body: { scope: detail.meta.scope },
        signal: options?.signal,
      });
    case 'mcp':
      return mutateJson(runtimeFetch, `/api/config/mcp/${encodeURIComponent(id)}${q}`, {
        method: 'DELETE',
        headers,
        signal: options?.signal,
      });
    case 'plugins':
      return mutateJson(runtimeFetch, `/api/config/plugins/entry/${encodeURIComponent(id)}${q}`, {
        method: 'DELETE',
        headers,
        signal: options?.signal,
      });
    case 'commands':
      return mutateJson(runtimeFetch, `/api/config/commands/${encodeURIComponent(id)}${q}`, {
        method: 'DELETE',
        headers,
        signal: options?.signal,
      });
    case 'snippets':
      return mutateJson(runtimeFetch, `/api/config/snippets/${encodeURIComponent(id)}${q}`, {
        method: 'DELETE',
        headers,
        signal: options?.signal,
      });
    case 'magic-prompts':
      return mutateJson(runtimeFetch, `/api/magic-prompts/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        signal: options?.signal,
      });
    case 'skills.installed':
      return mutateJson(runtimeFetch, `/api/config/skills/${encodeURIComponent(id)}${q}`, {
        method: 'DELETE',
        signal: options?.signal,
      });
    case 'assistants':
      return mutateJson(runtimeFetch, `/api/openchamber/assistants/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: { expectedRevision: detail.meta.revision },
        signal: options?.signal,
      });
    case 'projects': {
      const loaded = await loadLynxSettings(runtimeFetch, { signal: options?.signal });
      if (loaded.status === 'no-runtime') return { status: 'no-runtime' };
      if (loaded.status === 'failed') {
        return { status: 'failed', error: loaded.error, httpStatus: loaded.httpStatus };
      }
      const projects = (Array.isArray(loaded.settings.projects) ? loaded.settings.projects : [])
        .filter((project) => {
          const projectId = str(project.id) || str(project.path);
          return projectId !== id;
        });
      const saved = await saveLynxSettings(runtimeFetch, { projects }, { signal: options?.signal });
      if (saved.status === 'ok') return { status: 'ok' };
      if (saved.status === 'no-runtime') return { status: 'no-runtime' };
      return { status: 'failed', error: saved.error, httpStatus: saved.httpStatus };
    }
  }
};
