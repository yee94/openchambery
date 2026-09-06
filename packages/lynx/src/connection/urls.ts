import type { LynxRelayConfig, LynxTransportCandidate } from './types';

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

export const getConnectionStorageKey = (url: string): string => {
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

export const mobileConnectionKey = secureTokenKeyOf;
