import type { PairingDirectCandidate, PairingEndpointCandidate, PairingRelayCandidate } from '@/lib/connectionPayload';

/** Official LAN-first / relay-fallback race from Cap `probeConnectionCandidates`. */
export const RELAY_RACE_HEADSTART_MS = 1_500;

export type ProbeStatus = 'ok' | 'needs-login' | 'unreachable';

export type MobileRelayConfig = {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
};

export type MobileTransportCandidate =
  | { kind: 'direct'; url: string }
  | { kind: 'relay'; relay: MobileRelayConfig };

export type CandidateProbeOutcome<T> = {
  status: ProbeStatus;
  value?: T;
  /** Close unused relay tunnel / discard loser work. */
  discard?: () => void;
};

export const probeOk = <T,>(value: T, discard?: () => void): CandidateProbeOutcome<T> => ({
  status: 'ok',
  value,
  discard,
});

export const probeNeedsLogin = <T,>(): CandidateProbeOutcome<T> => ({ status: 'needs-login' });

export const probeUnreachable = <T,>(): CandidateProbeOutcome<T> => ({ status: 'unreachable' });

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

export const getConnectionStorageKey = (url: string): string => {
  try {
    return normalizeConnectionUrl(url);
  } catch {
    return url.trim().replace(/\/+$/g, '');
  }
};

export const isSameConnectionUrl = (left: string, right: string): boolean =>
  getConnectionStorageKey(left) === getConnectionStorageKey(right);

export const getConnectionLabel = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const relayConnectionRuntimeKey = (relay: MobileRelayConfig): string =>
  `relay:${relay.serverId}@${relay.relayUrl.trim()}`;

export const canonicalRelayUrl = (relay: MobileRelayConfig): string => `relay://${relay.serverId}`;

export const directCandidatesOf = (
  candidates: MobileTransportCandidate[],
): Array<{ kind: 'direct'; url: string }> =>
  candidates.filter((c): c is { kind: 'direct'; url: string } => c.kind === 'direct');

export const relayCandidateOf = (candidates: MobileTransportCandidate[]): MobileRelayConfig | null => {
  const found = candidates.find((c) => c.kind === 'relay');
  return found && found.kind === 'relay' ? found.relay : null;
};

export const connectionDisplayUrl = (candidates: MobileTransportCandidate[]): string => {
  const direct = directCandidatesOf(candidates)[0];
  if (direct) return direct.url;
  const relay = relayCandidateOf(candidates);
  return relay ? canonicalRelayUrl(relay) : '';
};

export const secureTokenKeyOf = (candidates: MobileTransportCandidate[]): string => {
  const relay = relayCandidateOf(candidates);
  if (relay) return relayConnectionRuntimeKey(relay);
  const direct = directCandidatesOf(candidates)[0];
  return direct ? getConnectionStorageKey(direct.url) : '';
};

export const parseRelayConfig = (value: unknown): MobileRelayConfig | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.relayUrl !== 'string' || !record.relayUrl.trim()) return null;
  if (typeof record.serverId !== 'string' || !record.serverId.trim()) return null;
  const jwk = record.hostEncPubJwk;
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return null;
  const key = jwk as Record<string, unknown>;
  if (key.kty !== 'EC' || key.crv !== 'P-256') return null;
  if (typeof key.x !== 'string' || !key.x || typeof key.y !== 'string' || !key.y) return null;
  // Cap parity: MobileRelayConfig never carries pairing `grant` (never persisted).
  return {
    relayUrl: record.relayUrl.trim(),
    serverId: record.serverId.trim(),
    hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y },
  };
};

export const parseTransportCandidate = (value: unknown): MobileTransportCandidate | null => {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (c.kind === 'direct') {
    return typeof c.url === 'string' && c.url.trim() ? { kind: 'direct', url: c.url } : null;
  }
  if (c.kind === 'relay') {
    const relay = parseRelayConfig(c.relay);
    return relay ? { kind: 'relay', relay } : null;
  }
  return null;
};

/** Persist lan+relay+hostEncPubJwk+serverId (Cap: grant/token never land here). */
export const serializeTransportCandidate = (c: MobileTransportCandidate): unknown =>
  c.kind === 'relay'
    ? {
        kind: 'relay',
        relay: {
          relayUrl: c.relay.relayUrl,
          serverId: c.relay.serverId,
          hostEncPubJwk: c.relay.hostEncPubJwk,
        },
      }
    : { kind: 'direct', url: c.url };

export const serializeTransportCandidates = (candidates: MobileTransportCandidate[]): unknown[] =>
  candidates.map(serializeTransportCandidate);

export const parseTransportCandidates = (raw: unknown): MobileTransportCandidate[] => {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseTransportCandidate).filter((c): c is MobileTransportCandidate => Boolean(c));
};

const priorityOf = (c: PairingEndpointCandidate): number => c.priority ?? 100;
const rankOf = (c: PairingEndpointCandidate): number =>
  c.type === 'relay' ? 2 : c.url.startsWith('https://') ? 0 : 1;

export const pairingCandidatesToMobile = (
  candidates: PairingEndpointCandidate[],
): MobileTransportCandidate[] =>
  [...candidates]
    .sort((left, right) => {
      const delta = priorityOf(left) - priorityOf(right);
      if (delta !== 0) return delta;
      return rankOf(left) - rankOf(right);
    })
    .flatMap((c): MobileTransportCandidate[] => {
      if (c.type === 'relay') {
        // Cap pairingCandidatesToMobile: drop grant when building MobileRelayConfig.
        const relay = parseRelayConfig({
          relayUrl: c.relayUrl,
          serverId: c.serverId,
          hostEncPubJwk: c.hostEncPubJwk,
        });
        return relay ? [{ kind: 'relay', relay }] : [];
      }
      try {
        const url = normalizeConnectionUrl(c.url);
        return url ? [{ kind: 'direct', url }] : [];
      } catch {
        return [];
      }
    });

export const directCandidatesFromUrl = (url: string): MobileTransportCandidate[] => {
  try {
    const normalized = normalizeConnectionUrl(url);
    return normalized ? [{ kind: 'direct', url: normalized }] : [];
  } catch {
    return [];
  }
};

export const candidateSetsMatch = (a: MobileTransportCandidate[], b: MobileTransportCandidate[]): boolean => {
  const aRelay = a.find((c) => c.kind === 'relay');
  const aServerId = aRelay && aRelay.kind === 'relay' ? aRelay.relay.serverId : null;
  const aRelayUrl = aRelay && aRelay.kind === 'relay' ? aRelay.relay.relayUrl.trim() : null;
  const aUrls = new Set(
    a.filter((c) => c.kind === 'direct').map((c) => getConnectionStorageKey((c as { url: string }).url)),
  );
  return b.some((c) => {
    if (c.kind === 'relay') {
      return aServerId !== null && c.relay.serverId === aServerId && c.relay.relayUrl.trim() === aRelayUrl;
    }
    return aUrls.has(getConnectionStorageKey(c.url));
  });
};

const defaultWait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * LAN-first / relay-fallback race.
 * - no relay → probe directs only
 * - no direct (relay-only) → probeRelay immediately (skip 1.5s headstart)
 * - both → direct first; start relay after headstart (or sooner if every direct is unreachable)
 */
export const probeConnectionCandidates = async <T,>(input: {
  hasDirect: boolean;
  hasRelay: boolean;
  probeDirects: () => Promise<CandidateProbeOutcome<T>>;
  probeRelay: () => Promise<CandidateProbeOutcome<T>>;
  headstartMs?: number;
  wait?: (ms: number) => Promise<void>;
}): Promise<CandidateProbeOutcome<T>> => {
  const {
    hasDirect,
    hasRelay,
    probeDirects,
    probeRelay,
    headstartMs = RELAY_RACE_HEADSTART_MS,
    wait = defaultWait,
  } = input;

  if (!hasRelay) return probeDirects();
  if (!hasDirect) return probeRelay();

  return new Promise<CandidateProbeOutcome<T>>((resolve) => {
    let settled = false;
    let relayCancelled = false;
    let relayStarted = false;
    let directResult: CandidateProbeOutcome<T> | null = null;
    let relayResult: CandidateProbeOutcome<T> | null = null;

    const closeUnused = (result: CandidateProbeOutcome<T> | null) => {
      result?.discard?.();
    };

    const finish = (result: CandidateProbeOutcome<T>) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const startRelayProbe = async () => {
      if (relayCancelled || settled || relayStarted) return;
      relayStarted = true;
      const result = await probeRelay();
      relayResult = result;
      if (settled || relayCancelled) {
        closeUnused(result);
        return;
      }
      if (result.status === 'ok' || result.status === 'needs-login') {
        finish(result);
        return;
      }
      if (directResult) finish(directResult);
    };

    void (async () => {
      const result = await probeDirects();
      directResult = result;
      if (settled) {
        closeUnused(result);
        return;
      }
      if (result.status === 'ok' || result.status === 'needs-login') {
        relayCancelled = true;
        closeUnused(relayResult);
        finish(result);
        return;
      }
      if (relayResult) {
        finish(relayResult);
        return;
      }
      await startRelayProbe();
    })();

    void (async () => {
      await wait(headstartMs);
      await startRelayProbe();
    })();
  });
};

export type ConnectionStatusKind = 'direct' | 'relay';

export const connectionStatusKey = (kind: ConnectionStatusKind): string =>
  kind === 'relay' ? 'mobile.instances.status.connectedRelay' : 'mobile.instances.status.connectedDirect';

export type { PairingDirectCandidate, PairingRelayCandidate };
