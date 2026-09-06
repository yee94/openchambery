import {
  candidateSetsMatch,
  connectionDisplayUrl,
  getConnectionLabel,
  parseTransportCandidates,
  secureTokenKeyOf,
  serializeTransportCandidates,
  type MobileTransportCandidate,
} from '@/lib/connectionCandidates';
import { createUuid } from '@/lib/deviceId';
import { getMetaStoreBackend } from '@/lib/metaStore';
import { deleteSecureToken, readSecureToken, writeSecureToken } from '@/lib/secureStore';

export const MOBILE_CONNECTIONS_STORAGE_KEY = 'openchamber.mobile.connections.v1';
export const MOBILE_CONNECTIONS_LIMIT = 12;

export type MobileSavedConnection = {
  id: string;
  label: string;
  candidates: MobileTransportCandidate[];
  lastUsedAt: number;
  hasToken?: boolean;
};

const migrateLegacyCandidates = (c: Record<string, unknown>): MobileTransportCandidate[] => {
  if (c.mode === 'relay' && c.relay && typeof c.relay === 'object') {
    const parsed = parseTransportCandidates([{ kind: 'relay', relay: c.relay }]);
    return parsed;
  }
  if (typeof c.url === 'string' && c.url.trim() && !/^relay:\/\//i.test(c.url.trim())) {
    return parseTransportCandidates([{ kind: 'direct', url: c.url }]);
  }
  return [];
};

export const loadMobileConnections = async (): Promise<MobileSavedConnection[]> => {
  const raw = await getMetaStoreBackend().getItem(MOBILE_CONNECTIONS_STORAGE_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .flatMap((item): MobileSavedConnection[] => {
      if (!item || typeof item !== 'object') return [];
      const c = item as Record<string, unknown>;
      if (typeof c.id !== 'string') return [];
      const candidates = Array.isArray(c.candidates)
        ? parseTransportCandidates(c.candidates)
        : migrateLegacyCandidates(c);
      if (candidates.length === 0) return [];
      const label =
        typeof c.label === 'string' && c.label.trim()
          ? c.label
          : getConnectionLabel(connectionDisplayUrl(candidates));
      const inlineToken = typeof c.clientToken === 'string' && c.clientToken.trim() ? c.clientToken : undefined;
      return [
        {
          id: c.id,
          label,
          candidates,
          lastUsedAt: typeof c.lastUsedAt === 'number' ? c.lastUsedAt : 0,
          hasToken: Boolean(c.hasToken) || Boolean(inlineToken),
        },
      ];
    })
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
};

export const writeMobileConnections = async (connections: MobileSavedConnection[]): Promise<void> => {
  const serialized = connections.slice(0, MOBILE_CONNECTIONS_LIMIT).map((c) => ({
    id: c.id,
    label: c.label,
    candidates: serializeTransportCandidates(c.candidates),
    lastUsedAt: c.lastUsedAt,
    hasToken: Boolean(c.hasToken),
  }));
  await getMetaStoreBackend().setItem(MOBILE_CONNECTIONS_STORAGE_KEY, JSON.stringify(serialized));
};

export const upsertMobileConnection = async (draft: {
  id?: string;
  label: string;
  candidates: MobileTransportCandidate[];
  clientToken?: string;
}): Promise<MobileSavedConnection[]> => {
  const current = await loadMobileConnections();
  const existing = current.find((item) =>
    (draft.id && item.id === draft.id) || candidateSetsMatch(item.candidates, draft.candidates),
  );
  const next: MobileSavedConnection = {
    id: draft.id || existing?.id || createUuid(),
    label: draft.label,
    candidates: draft.candidates,
    lastUsedAt: Date.now(),
    hasToken: Boolean(draft.clientToken) || existing?.hasToken || false,
  };

  if (draft.clientToken) {
    const key = secureTokenKeyOf(draft.candidates);
    const stored = await writeSecureToken(key, draft.clientToken);
    next.hasToken = stored || next.hasToken;
  }

  const list = [next, ...current.filter((item) => item.id !== next.id && !candidateSetsMatch(item.candidates, draft.candidates))].slice(
    0,
    MOBILE_CONNECTIONS_LIMIT,
  );
  await writeMobileConnections(list);
  return list;
};

export const deleteMobileConnection = async (id: string): Promise<MobileSavedConnection[]> => {
  const current = await loadMobileConnections();
  const removed = current.find((c) => c.id === id);
  if (removed) {
    const key = secureTokenKeyOf(removed.candidates);
    await deleteSecureToken(key);
  }
  const next = current.filter((c) => c.id !== id);
  await writeMobileConnections(next);
  return next;
};

export const readConnectionToken = async (connection: MobileSavedConnection): Promise<string | undefined> => {
  if (!connection.hasToken) return undefined;
  return readSecureToken(secureTokenKeyOf(connection.candidates));
};
