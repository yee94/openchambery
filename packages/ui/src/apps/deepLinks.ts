/**
 * OpenChamber deep-link vocabulary — the single source of truth for the `openchamber://`
 * URL scheme used across every native entry point: notification taps, home-screen / lock-
 * screen widgets, and (later) Live Activities. Anything that wants to drive navigation
 * builds a URL with {@link buildDeepLink} and anything that receives one parses it with
 * {@link parseDeepLink} into a typed {@link DeepLinkIntent}; the navigation layer
 * (deepLinkNavigation) is the only place that knows how to *apply* an intent.
 *
 * Desktop openers (Raycast / `open`) should prefer the OpenCode-aligned forms:
 *   openchamber://new-session?directory=${path}
 *   openchamber://open-project?directory=${path}
 * Legacy aliases (`dir`, `path`, `new`, `project/<path>`) remain accepted on parse.
 *
 * Keep this file pure (no React, no stores, no Capacitor) so it can be imported from any
 * context — including, eventually, a tiny encoder shared with the native widget/extension.
 */

import {
  encodePairingConnectionPayload,
  parsePairingConnectionPayload,
  type PairingConnectionPayload,
} from '@/lib/connectionPayload';

export const DEEP_LINK_SCHEME = 'openchamber';

export type SessionsFilter = 'all' | 'attention' | 'recent';
export type ViewTarget = 'files' | 'mcp' | 'instances' | 'update';

/**
 * Every external intent the app exposes, including connection handoff and navigation.
 * New widget/notification ideas should add a variant here first, then teach
 * deepLinkNavigation how to apply it — that keeps the "blocks" composable without
 * leaking ad-hoc URL parsing into features.
 */
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

// Prefer OpenCode's `directory`, then legacy mobile `dir`, then CodeX-style `path`.
const readDirectoryParam = (query: URLSearchParams): string | undefined => {
  const value = query.get('directory') || query.get('dir') || query.get('path');
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const segmentsOf = (url: URL): string[] => {
  // Custom-scheme URLs put the first route token in `host` (openchamber://session/<id>),
  // but be tolerant of authority-less forms (openchamber:/session/<id>) where it lands in
  // the pathname instead.
  const pathSegments = trimSlashes(url.pathname).split('/').filter(Boolean);
  if (url.host) {
    return [url.host, ...pathSegments];
  }
  return pathSegments;
};

/**
 * Parse a raw `openchamber://…` string into a typed intent, or `null` if it isn't a
 * recognised OpenChamber deep link. Tolerant by design: unknown routes return `null`
 * rather than throwing, so callers can fall back without a try/catch.
 */
export function parseDeepLink(raw: string | null | undefined): DeepLinkIntent | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) {
    return null;
  }

  const segments = segmentsOf(url);
  const route = (segments[0] ?? '').toLowerCase();
  const rest = segments.slice(1);
  const query = url.searchParams;

  switch (route) {
    case 'connect': {
      const pairing = parsePairingConnectionPayload(raw);
      return pairing ? { type: 'connect', pairing } : null;
    }

    case 'session': {
      const sessionId = rest[0] || query.get('id') || '';
      if (!sessionId) {
        return null;
      }
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

    // Align with OpenCode: openchamber://open-project?directory=${path}
    // Also accept legacy path-form openchamber://project/<path>.
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
      if (!directory) {
        return null;
      }
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
      // `changes` has its own richer intent (diff path); route the bare view token to it.
      if (target === 'changes') {
        return { type: 'changes' };
      }
      if (target === 'files' || target === 'mcp' || target === 'instances' || target === 'update') {
        return { type: 'view', target };
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * Build a canonical `openchamber://…` URL for an intent. Used by anything that needs to hand
 * a deep link to iOS — notification payloads, `widgetURL(...)`, Live Activity tap targets —
 * so every producer emits the exact shape {@link parseDeepLink} understands.
 */
export function buildDeepLink(intent: DeepLinkIntent): string {
  const base = `${DEEP_LINK_SCHEME}://`;
  const withQuery = (path: string, params: Record<string, string | undefined>): string => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && value.length > 0) {
        search.set(key, value);
      }
    }
    const query = search.toString();
    return query ? `${base}${path}?${query}` : `${base}${path}`;
  };

  switch (intent.type) {
    case 'connect':
      return encodePairingConnectionPayload(intent.pairing);
    case 'session':
      // Emit OpenCode-aligned `directory=` (parse still accepts legacy `dir` / `path`).
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
