import { createUuid } from '../uuid';
import { migrateLegacyCandidates, parseCandidate, serializeCandidate, candidateSetsMatch } from './candidates';
import type { LynxKvStore, LynxSavedConnection, LynxSecureStore, LynxTransportCandidate } from './types';
import { connectionDisplayUrl, getConnectionLabel, secureTokenKeyOf } from './urls';

export const CONNECTIONS_STORAGE_KEY = 'openchamber.mobile.connections.v1';
export const DEVICE_ID_STORAGE_KEY = 'openchamber.mobile.deviceId';
export const SECURE_STORAGE_PREFIX = 'openchamber.mobile.';
export const CONNECTIONS_LIMIT = 12;

export const prefixedTokenKey = (key: string): string =>
  `${SECURE_STORAGE_PREFIX}token.${encodeURIComponent(key)}`;

export const readDeviceId = (store: LynxKvStore): string => {
  const existing = store.getItem(DEVICE_ID_STORAGE_KEY);
  if (existing && existing.trim()) return existing.trim();
  const generated = createUuid();
  store.setItem(DEVICE_ID_STORAGE_KEY, generated);
  return generated;
};

export const mobileClientDedupeKey = (store: LynxKvStore): string => `mobile:${readDeviceId(store)}`;

const readRawConnections = (store: LynxKvStore): unknown => {
  try {
    return JSON.parse(store.getItem(CONNECTIONS_STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
};

export const readConnections = (store: LynxKvStore): LynxSavedConnection[] => {
  const parsed = readRawConnections(store);
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

export const writeConnections = (store: LynxKvStore, connections: LynxSavedConnection[]): void => {
  const serialized = connections.slice(0, CONNECTIONS_LIMIT).map((connection) => ({
    id: connection.id,
    label: connection.label,
    candidates: connection.candidates.map(serializeCandidate),
    lastUsedAt: connection.lastUsedAt,
    hasToken: Boolean(connection.hasToken),
  }));
  store.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(serialized));
};

export const upsertConnectionInList = (
  connections: LynxSavedConnection[],
  draft: {
    id?: string;
    label: string;
    candidates: LynxTransportCandidate[];
    hasToken?: boolean;
    now?: number;
  },
): LynxSavedConnection[] => {
  const existing = connections.find((item) => (
    (draft.id && item.id === draft.id) || candidateSetsMatch(item.candidates, draft.candidates)
  ));
  const next: LynxSavedConnection = {
    id: draft.id || existing?.id || createUuid(),
    label: draft.label,
    candidates: draft.candidates,
    lastUsedAt: draft.now ?? Date.now(),
    hasToken: draft.hasToken ?? existing?.hasToken ?? false,
  };
  return [
    next,
    ...connections.filter((item) => item.id !== next.id && !candidateSetsMatch(item.candidates, draft.candidates)),
  ].slice(0, CONNECTIONS_LIMIT);
};

export const readSecureToken = async (
  secure: LynxSecureStore,
  connection: { candidates: LynxTransportCandidate[] },
): Promise<string | undefined> => {
  const key = secureTokenKeyOf(connection);
  if (!key) return undefined;
  const value = await secure.get(prefixedTokenKey(key));
  return typeof value === 'string' && value.trim() ? value : undefined;
};

export const writeSecureToken = async (
  secure: LynxSecureStore,
  connection: { candidates: LynxTransportCandidate[] },
  token: string,
): Promise<boolean> => {
  const key = secureTokenKeyOf(connection);
  if (!key) return false;
  return secure.set(prefixedTokenKey(key), token);
};

export const deleteSecureToken = async (
  secure: LynxSecureStore,
  connection: { candidates: LynxTransportCandidate[] },
): Promise<void> => {
  const key = secureTokenKeyOf(connection);
  if (!key) return;
  await secure.delete(prefixedTokenKey(key));
};

export const createMemoryKvStore = (initial?: Record<string, string>): LynxKvStore => {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
};

export const createMemorySecureStore = (): LynxSecureStore => {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
      return true;
    },
    delete: async (key) => {
      map.delete(key);
    },
  };
};
