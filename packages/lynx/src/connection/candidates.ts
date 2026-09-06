import type { PairingEndpointCandidate } from '../pairing/payload';
import type { LynxConnectInput, LynxRelayConfig, LynxTransportCandidate } from './types';
import { getConnectionStorageKey, normalizeConnectionUrl } from './urls';

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

export const parseCandidate = (value: unknown): LynxTransportCandidate | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.kind === 'direct') {
    return typeof record.url === 'string' && record.url.trim() ? { kind: 'direct', url: record.url } : null;
  }
  if (record.kind === 'relay') {
    const relay = parseRelayConfig(record.relay);
    return relay ? { kind: 'relay', relay } : null;
  }
  return null;
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

export const migrateLegacyCandidates = (record: Record<string, unknown>): LynxTransportCandidate[] => {
  if (record.mode === 'relay') {
    const relay = parseRelayConfig(record.relay);
    return relay ? [{ kind: 'relay', relay }] : [];
  }
  return typeof record.url === 'string' ? directCandidatesFromUrl(record.url) : [];
};

export const directCandidatesFromUrl = (url: string): LynxTransportCandidate[] => {
  const normalized = (() => {
    try {
      return normalizeConnectionUrl(url);
    } catch {
      return '';
    }
  })();
  return normalized ? [{ kind: 'direct', url: normalized }] : [];
};

export const buildCandidatesFromInput = (input: LynxConnectInput): LynxTransportCandidate[] => {
  if (input.candidates && input.candidates.length > 0) return input.candidates;
  const list: LynxTransportCandidate[] = [];
  if (typeof input.url === 'string' && input.url.trim() && !/^relay:\/\//i.test(input.url.trim())) {
    list.push(...directCandidatesFromUrl(input.url));
  }
  if (input.relay) list.push({ kind: 'relay', relay: input.relay });
  return list;
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

export const pairingCandidatesToMobile = (candidates: PairingEndpointCandidate[]): LynxTransportCandidate[] =>
  [...candidates]
    .sort((left, right) => {
      const delta = (left.priority ?? 100) - (right.priority ?? 100);
      if (delta !== 0) return delta;
      const rank = (candidate: PairingEndpointCandidate): number => (
        candidate.type === 'relay' ? 2 : candidate.url.startsWith('https://') ? 0 : 1
      );
      return rank(left) - rank(right);
    })
    .flatMap((candidate): LynxTransportCandidate[] => {
      if (candidate.type === 'relay') {
        const relay = parseRelayConfig({
          relayUrl: candidate.relayUrl,
          serverId: candidate.serverId,
          hostEncPubJwk: candidate.hostEncPubJwk,
        });
        return relay ? [{ kind: 'relay', relay }] : [];
      }
      return directCandidatesFromUrl(candidate.url);
    });
