import type { LynxHostAdapters } from '../host/adapters.ts';
import { createLynxConnectionStore } from './store.ts';
import { LYNX_RELAY_CONNECT_TIMEOUT_MS, type LynxCandidateRefreshResult, type LynxSavedConnection, type LynxTransportCandidate } from './types.ts';
import { directCandidates, normalizeConnectionUrl, relayCandidateOf, serializeCandidate } from './urls.ts';
import { safeLogInfo } from './sanitizeLog.ts';

/**
 * Learn current LAN addresses over the already-bound runtime.
 * Official route: `GET /api/client-auth/connection/candidates`.
 */
export const refreshConnectionCandidates = async (
  active: LynxSavedConnection,
  host: LynxHostAdapters,
): Promise<{ result: LynxCandidateRefreshResult; next?: LynxSavedConnection }> => {
  const relay = relayCandidateOf(active);
  if (!relay || !host.runtimeFetch) {
    safeLogInfo(host.logger, 'candidates:refresh-skip', { reason: relay ? 'no-runtime-fetch' : 'no-relay-candidate' });
    return { result: 'skipped' };
  }
  const response = await host.runtimeFetch('/api/client-auth/connection/candidates', {
    method: 'GET',
    timeoutMs: LYNX_RELAY_CONNECT_TIMEOUT_MS,
  }).catch(() => null);
  if (!response?.ok) {
    safeLogInfo(host.logger, 'candidates:refresh-skip', { reason: 'fetch-failed', status: response?.status ?? null });
    return { result: 'skipped' };
  }
  const payload = await response.json().catch(() => null) as { serverId?: unknown; candidates?: unknown } | null;
  if (!payload || payload.serverId !== relay.serverId) {
    safeLogInfo(host.logger, 'candidates:refresh-skip', { reason: 'server-id-mismatch' });
    return { result: 'skipped' };
  }
  const reported = Array.isArray(payload.candidates) ? payload.candidates : [];
  const lanUrls: string[] = [];
  for (const entry of reported) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== 'lan' || typeof record.url !== 'string') continue;
    try {
      const url = normalizeConnectionUrl(record.url);
      if (url && !lanUrls.includes(url)) lanUrls.push(url);
    } catch {
      // drop invalid
    }
  }
  if (lanUrls.length === 0) {
    safeLogInfo(host.logger, 'candidates:refresh-skip', { reason: 'no-lan-reported' });
    return { result: 'skipped' };
  }
  const preservedHttps = directCandidates(active).filter((candidate) => candidate.url.startsWith('https://'));
  const nextCandidates: LynxTransportCandidate[] = [
    ...lanUrls.map((url): LynxTransportCandidate => ({ kind: 'direct', url })),
    ...preservedHttps,
    { kind: 'relay', relay },
  ];
  const unchanged = JSON.stringify(active.candidates.map(serializeCandidate)) === JSON.stringify(nextCandidates.map(serializeCandidate));
  if (unchanged) return { result: 'unchanged' };
  const store = createLynxConnectionStore(host.metadataStore);
  const list = store.upsert({
    id: active.id,
    label: active.label,
    candidates: nextCandidates,
    hasToken: active.hasToken,
    now: host.clock?.now(),
  });
  const next = list.find((connection) => connection.id === active.id);
  safeLogInfo(host.logger, 'candidates:refreshed', { lanCount: lanUrls.length });
  return { result: 'updated', next };
};
