/**
 * Pure `openchamber://` vocabulary — port of Cap packages/ui deepLinks session subset
 * plus connect/settings used by Expo Track 8 push / Live Activity taps.
 */
import { DEEP_LINK_SCHEME } from './constants';

export type DeepLinkIntent =
  | { type: 'session'; sessionId: string; directory?: string }
  | { type: 'connect' }
  | { type: 'settings'; section?: string }
  | { type: 'sessions'; filter?: 'all' | 'attention' | 'recent' }
  | { type: 'status' }
  | { type: 'new-session' };

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, '');

const segmentsOf = (url: URL): string[] => {
  const pathSegments = trimSlashes(url.pathname).split('/').filter(Boolean);
  if (url.host) return [url.host, ...pathSegments];
  return pathSegments;
};

export function parseDeepLink(raw: string | null | undefined): DeepLinkIntent | null {
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
    case 'session': {
      const sessionId = rest[0] || query.get('id') || '';
      if (!sessionId) return null;
      const directory = query.get('directory') || query.get('dir') || query.get('path') || undefined;
      return { type: 'session', sessionId, directory: directory?.trim() || undefined };
    }
    case 'connect':
      return { type: 'connect' };
    case 'settings':
      return { type: 'settings', section: rest[0] || query.get('section') || undefined };
    case 'sessions': {
      const filter = query.get('filter');
      return {
        type: 'sessions',
        filter: filter === 'attention' || filter === 'recent' || filter === 'all' ? filter : undefined,
      };
    }
    case 'status':
      return { type: 'status' };
    case 'new':
    case 'new-session':
      return { type: 'new-session' };
    default:
      return null;
  }
}

export function buildDeepLink(intent: DeepLinkIntent): string {
  const base = `${DEEP_LINK_SCHEME}://`;
  switch (intent.type) {
    case 'session': {
      const encoded = encodeURIComponent(intent.sessionId);
      if (intent.directory) {
        return `${base}session/${encoded}?directory=${encodeURIComponent(intent.directory)}`;
      }
      return `${base}session/${encoded}`;
    }
    case 'connect':
      return `${base}connect`;
    case 'settings':
      return intent.section ? `${base}settings/${encodeURIComponent(intent.section)}` : `${base}settings`;
    case 'sessions':
      return intent.filter ? `${base}sessions?filter=${intent.filter}` : `${base}sessions`;
    case 'status':
      return `${base}status`;
    case 'new-session':
      return `${base}new`;
  }
}

/** Extract session id from push notification data / deep link. */
export function sessionIdFromPushData(data: Record<string, unknown> | null | undefined): string | null {
  if (!data) return null;
  const direct = data.sessionId ?? data.sessionID ?? data.session_id;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const url = data.url ?? data.deepLink ?? data.link;
  if (typeof url === 'string') {
    const parsed = parseDeepLink(url);
    if (parsed?.type === 'session') return parsed.sessionId;
  }
  return null;
}
