import type { LynxRelayConfig, LynxTransportCandidate } from './types.ts';

export const normalizeConnectionUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
};

export const getConnectionLabel = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const getConnectionStorageKey = (url: string): string => {
  try {
    return normalizeConnectionUrl(url);
  } catch {
    return url.trim().replace(/\/+$/g, '');
  }
};

export const isSameConnectionUrl = (left: string, right: string): boolean =>
  getConnectionStorageKey(left) === getConnectionStorageKey(right);

export const relayConnectionRuntimeKey = (relay: LynxRelayConfig): string =>
  `relay:${relay.serverId}@${relay.relayUrl.trim()}`;

export const canonicalRelayUrl = (relay: LynxRelayConfig): string => `relay://${relay.serverId}`;

export const directCandidates = (
  connection: { candidates: LynxTransportCandidate[] },
): Array<{ kind: 'direct'; url: string }> =>
  connection.candidates.filter((candidate): candidate is { kind: 'direct'; url: string } => candidate.kind === 'direct');

export const relayCandidateOf = (
  connection: { candidates: LynxTransportCandidate[] },
): LynxRelayConfig | null => {
  const found = connection.candidates.find((candidate) => candidate.kind === 'relay');
  return found && found.kind === 'relay' ? found.relay : null;
};

export const connectionDisplayUrl = (connection: { candidates: LynxTransportCandidate[] }): string => {
  const direct = directCandidates(connection)[0];
  if (direct) return direct.url;
  const relay = relayCandidateOf(connection);
  return relay ? canonicalRelayUrl(relay) : '';
};

export const secureTokenKeyOf = (connection: { candidates: LynxTransportCandidate[] }): string => {
  const relay = relayCandidateOf(connection);
  if (relay) return relayConnectionRuntimeKey(relay);
  const direct = directCandidates(connection)[0];
  return direct ? getConnectionStorageKey(direct.url) : '';
};

export const lynxConnectionKey = secureTokenKeyOf;

export const parseRelayConfig = (value: unknown): LynxRelayConfig | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.relayUrl !== 'string' || !record.relayUrl.trim()) return null;
  if (typeof record.serverId !== 'string' || !record.serverId.trim()) return null;
  const jwk = record.hostEncPubJwk;
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return null;
  const key = jwk as Record<string, unknown>;
  if (key.kty !== 'EC' || key.crv !== 'P-256') return null;
  if (typeof key.x !== 'string' || !key.x || typeof key.y !== 'string' || !key.y) return null;
  return {
    relayUrl: record.relayUrl,
    serverId: record.serverId,
    hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y },
  };
};

export const candidateSetsMatch = (left: LynxTransportCandidate[], right: LynxTransportCandidate[]): boolean => {
  const leftRelay = left.find((candidate) => candidate.kind === 'relay');
  const leftServerId = leftRelay && leftRelay.kind === 'relay' ? leftRelay.relay.serverId : null;
  const leftRelayUrl = leftRelay && leftRelay.kind === 'relay' ? leftRelay.relay.relayUrl.trim() : null;
  const leftUrls = new Set(
    left.filter((candidate) => candidate.kind === 'direct').map((candidate) => getConnectionStorageKey(candidate.url)),
  );
  return right.some((candidate) => {
    if (candidate.kind === 'relay') {
      return leftServerId !== null && candidate.relay.serverId === leftServerId && candidate.relay.relayUrl.trim() === leftRelayUrl;
    }
    return leftUrls.has(getConnectionStorageKey(candidate.url));
  });
};

export const serializeCandidate = (candidate: LynxTransportCandidate): unknown =>
  candidate.kind === 'relay'
    ? {
        kind: 'relay',
        relay: {
          relayUrl: candidate.relay.relayUrl,
          serverId: candidate.relay.serverId,
          hostEncPubJwk: candidate.relay.hostEncPubJwk,
        },
      }
    : { kind: 'direct', url: candidate.url };
