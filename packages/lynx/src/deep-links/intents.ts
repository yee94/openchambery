import {
  encodePairingConnectionPayload,
  parsePairingConnectionPayload,
  type PairingConnectionPayload,
} from '../pairing/payload';

export const DEEP_LINK_SCHEME = 'openchamber';

export type SessionsFilter = 'all' | 'attention' | 'recent';
export type ViewTarget = 'files' | 'mcp' | 'instances' | 'update';

export type DeepLinkIntent =
  | { type: 'connect'; pairing: PairingConnectionPayload }
  | { type: 'session'; sessionId: string; directory?: string }
  | { type: 'new-session'; directory?: string; projectId?: string; agent?: string; model?: string; prompt?: string }
  | { type: 'open-project'; directory: string }
  | { type: 'sessions'; filter?: SessionsFilter }
  | { type: 'status' }
  | { type: 'settings'; section?: string }
  | { type: 'changes'; path?: string; staged?: boolean }
  | { type: 'view'; target: ViewTarget };

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, '');

const readDirectoryParam = (query: URLSearchParams): string | undefined => {
  const value = query.get('directory') || query.get('dir') || query.get('path');
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const segmentsOf = (url: URL): string[] => {
  const pathSegments = trimSlashes(url.pathname).split('/').filter(Boolean);
  if (url.host) return [url.host, ...pathSegments];
  return pathSegments;
};

export function parseDeepLink(raw: string | null | undefined, nowMs: number = Date.now()): DeepLinkIntent | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;

  const segments = segmentsOf(url);
  const route = (segments[0] ?? '').toLowerCase();
  const rest = segments.slice(1);
  const query = url.searchParams;

  switch (route) {
    case 'connect': {
      const pairing = parsePairingConnectionPayload(raw, nowMs);
      return pairing ? { type: 'connect', pairing } : null;
    }
    case 'session': {
      const sessionId = rest[0] || query.get('id') || '';
      if (!sessionId) return null;
      return { type: 'session', sessionId, directory: readDirectoryParam(query) };
    }
    case 'new':
    case 'new-session': {
      const prompt = query.get('prompt')?.trim();
      return {
        type: 'new-session',
        directory: readDirectoryParam(query),
        projectId: query.get('project') ?? undefined,
        agent: query.get('agent') ?? undefined,
        model: query.get('model') ?? undefined,
        prompt: prompt || undefined,
      };
    }
    case 'project':
    case 'open-project': {
      let fromPath: string | undefined;
      if (rest.length > 0) {
        try {
          fromPath = decodeURIComponent(rest.join('/'));
        } catch {
          fromPath = rest.join('/');
        }
      }
      const directory = readDirectoryParam(query) || fromPath;
      if (!directory) return null;
      return { type: 'open-project', directory };
    }
    case 'sessions': {
      const filter = query.get('filter');
      return {
        type: 'sessions',
        filter: filter === 'attention' || filter === 'recent' || filter === 'all' ? filter : undefined,
      };
    }
    case 'status':
      return { type: 'status' };
    case 'settings':
      return { type: 'settings', section: rest[0] || query.get('section') || undefined };
    case 'changes':
      return {
        type: 'changes',
        path: rest.join('/') || query.get('path') || undefined,
        staged: query.get('staged') === 'true',
      };
    case 'view': {
      const target = (rest[0] || '').toLowerCase();
      if (target === 'changes') return { type: 'changes' };
      if (target === 'files' || target === 'mcp' || target === 'instances' || target === 'update') {
        return { type: 'view', target };
      }
      return null;
    }
    default:
      return null;
  }
}

export function buildDeepLink(intent: DeepLinkIntent): string {
  const base = `${DEEP_LINK_SCHEME}://`;
  const withQuery = (path: string, params: Record<string, string | undefined>): string => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && value.length > 0) search.set(key, value);
    }
    const query = search.toString();
    return query ? `${base}${path}?${query}` : `${base}${path}`;
  };

  switch (intent.type) {
    case 'connect':
      return encodePairingConnectionPayload(intent.pairing);
    case 'session':
      return withQuery(`session/${encodeURIComponent(intent.sessionId)}`, { directory: intent.directory });
    case 'new-session':
      return withQuery('new-session', {
        directory: intent.directory,
        project: intent.projectId,
        agent: intent.agent,
        model: intent.model,
        prompt: intent.prompt,
      });
    case 'open-project':
      return withQuery('open-project', { directory: intent.directory });
    case 'sessions':
      return withQuery('sessions', { filter: intent.filter });
    case 'status':
      return `${base}status`;
    case 'settings':
      return intent.section ? `${base}settings/${encodeURIComponent(intent.section)}` : `${base}settings`;
    case 'changes':
      return withQuery(intent.path ? `changes/${intent.path}` : 'changes', {
        staged: intent.staged ? 'true' : undefined,
      });
    case 'view':
      return `${base}view/${intent.target}`;
  }
}
