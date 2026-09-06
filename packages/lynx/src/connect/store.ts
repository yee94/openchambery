import type { LynxJsonStore, LynxSecureStore } from '../host/adapters.ts';
import { createLynxId } from './ids.ts';
import {
  LYNX_CONNECTIONS_LIMIT,
  LYNX_METADATA_STORAGE_KEY,
  LYNX_SECURE_TOKEN_PREFIX,
  type LynxSavedConnection,
  type LynxTransportCandidate,
} from './types.ts';
import {
  candidateSetsMatch,
  connectionDisplayUrl,
  getConnectionLabel,
  normalizeConnectionUrl,
  parseRelayConfig,
  secureTokenKeyOf,
  serializeCandidate,
} from './urls.ts';

export const prefixedTokenKey = (key: string): string =>
  `${LYNX_SECURE_TOKEN_PREFIX}${encodeURIComponent(key)}`;

const parseCandidate = (value: unknown): LynxTransportCandidate | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'direct') {
    return typeof candidate.url === 'string' && candidate.url.trim()
      ? { kind: 'direct', url: candidate.url }
      : null;
  }
  if (candidate.kind === 'relay') {
    const relay = parseRelayConfig(candidate.relay);
    return relay ? { kind: 'relay', relay } : null;
  }
  return null;
};

const migrateLegacyCandidates = (record: Record<string, unknown>): LynxTransportCandidate[] => {
  if (record.mode === 'relay') {
    const relay = parseRelayConfig(record.relay);
    return relay ? [{ kind: 'relay', relay }] : [];
  }
  if (typeof record.url !== 'string') return [];
  try {
    const url = normalizeConnectionUrl(record.url);
    return url ? [{ kind: 'direct', url }] : [];
  } catch {
    return [];
  }
};

const parseSavedConnections = (raw: string | null): LynxSavedConnection[] => {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .flatMap((item): LynxSavedConnection[] => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string') return [];
      const candidates = Array.isArray(record.candidates)
        ? record.candidates.map(parseCandidate).filter((candidate): candidate is LynxTransportCandidate => Boolean(candidate))
        : migrateLegacyCandidates(record);
      if (candidates.length === 0) return [];
      const inlineToken = typeof record.clientToken === 'string' && record.clientToken.trim() ? record.clientToken : undefined;
      const label = typeof record.label === 'string' && record.label.trim()
        ? record.label
        : getConnectionLabel(connectionDisplayUrl({ candidates }));
      return [{
        id: record.id,
        label,
        candidates,
        lastUsedAt: typeof record.lastUsedAt === 'number' ? record.lastUsedAt : 0,
        hasToken: Boolean(record.hasToken) || Boolean(inlineToken),
      }];
    })
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt);
};

const serializeConnections = (connections: LynxSavedConnection[]): string =>
  JSON.stringify(connections.slice(0, LYNX_CONNECTIONS_LIMIT).map((connection) => ({
    id: connection.id,
    label: connection.label,
    candidates: connection.candidates.map(serializeCandidate),
    lastUsedAt: connection.lastUsedAt,
    hasToken: Boolean(connection.hasToken),
  })));

export type LynxConnectionStore = {
  load: () => LynxSavedConnection[];
  write: (connections: LynxSavedConnection[]) => void;
  upsert: (draft: {
    id?: string;
    label: string;
    candidates: LynxTransportCandidate[];
    hasToken?: boolean;
    now?: number;
    createId?: () => string;
  }) => LynxSavedConnection[];
  remove: (id: string) => { next: LynxSavedConnection[]; removed: LynxSavedConnection | null };
};

export const createLynxConnectionStore = (metadataStore: LynxJsonStore): LynxConnectionStore => {
  const load = (): LynxSavedConnection[] => parseSavedConnections(metadataStore.read(LYNX_METADATA_STORAGE_KEY));

  const write = (connections: LynxSavedConnection[]): void => {
    metadataStore.write(LYNX_METADATA_STORAGE_KEY, serializeConnections(connections));
  };

  const upsert: LynxConnectionStore['upsert'] = (draft) => {
    const connections = load();
    const existing = connections.find((item) => (
      (draft.id && item.id === draft.id) || candidateSetsMatch(item.candidates, draft.candidates)
    ));
    const nextEntry: LynxSavedConnection = {
      id: draft.id || existing?.id || (draft.createId ?? createLynxId)(),
      label: draft.label,
      candidates: draft.candidates,
      lastUsedAt: draft.now ?? Date.now(),
      hasToken: draft.hasToken ?? existing?.hasToken ?? false,
    };
    const next = [
      nextEntry,
      ...connections.filter((item) => item.id !== nextEntry.id && !candidateSetsMatch(item.candidates, draft.candidates)),
    ].slice(0, LYNX_CONNECTIONS_LIMIT);
    write(next);
    return next;
  };

  const remove = (id: string) => {
    const connections = load();
    const removed = connections.find((connection) => connection.id === id) ?? null;
    const next = connections.filter((connection) => connection.id !== id);
    write(next);
    return { next, removed };
  };

  return { load, write, upsert, remove };
};

export const readSecureToken = async (
  secureStore: LynxSecureStore,
  connection: { candidates: LynxTransportCandidate[] },
): Promise<string | undefined> => {
  const key = secureTokenKeyOf(connection);
  if (!key) return undefined;
  const token = await secureStore.getToken(prefixedTokenKey(key));
  return typeof token === 'string' && token.trim() ? token : undefined;
};

export const writeSecureToken = async (
  secureStore: LynxSecureStore,
  connection: { candidates: LynxTransportCandidate[] },
  token: string,
): Promise<boolean> => {
  const key = secureTokenKeyOf(connection);
  if (!key) return false;
  return secureStore.setToken(prefixedTokenKey(key), token);
};

export const deleteSecureToken = async (
  secureStore: LynxSecureStore,
  connection: { candidates: LynxTransportCandidate[] },
): Promise<void> => {
  const key = secureTokenKeyOf(connection);
  if (!key) return;
  await secureStore.deleteToken(prefixedTokenKey(key));
};

/** Move an inline legacy `clientToken` from metadata into the secure store. */
export const migrateLegacyInlineTokens = async (
  metadataStore: LynxJsonStore,
  secureStore: LynxSecureStore,
): Promise<void> => {
  const raw = metadataStore.read(LYNX_METADATA_STORAGE_KEY);
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  let moved = false;
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const token = typeof record.clientToken === 'string' ? record.clientToken.trim() : '';
    if (!token) continue;
    const candidates = Array.isArray(record.candidates)
      ? record.candidates.map(parseCandidate).filter((candidate): candidate is LynxTransportCandidate => Boolean(candidate))
      : migrateLegacyCandidates(record);
    if (candidates.length === 0) continue;
    await writeSecureToken(secureStore, { candidates }, token);
    moved = true;
  }
  if (!moved) return;
  const store = createLynxConnectionStore(metadataStore);
  const cleaned = store.load().map((connection) => ({ ...connection, hasToken: true }));
  store.write(cleaned);
};
