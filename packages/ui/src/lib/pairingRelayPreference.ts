export const DEFAULT_PAIRING_RELAY_URL = 'wss://relay.openchamber.dev/ws';

const PAIRING_RELAY_URL_STORAGE_KEY = 'openchamber.pairing.relayUrl.v1';

export const normalizePairingRelayUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
};

export const readPairingRelayUrlPreference = (storage: Pick<Storage, 'getItem'> | null = typeof window === 'undefined' ? null : window.localStorage): string | null => {
  if (!storage) return null;
  try {
    return normalizePairingRelayUrl(storage.getItem(PAIRING_RELAY_URL_STORAGE_KEY));
  } catch {
    return null;
  }
};

export const writePairingRelayUrlPreference = (
  relayUrl: string,
  storage: Pick<Storage, 'setItem'> | null = typeof window === 'undefined' ? null : window.localStorage,
): void => {
  if (!storage) return;
  const normalized = normalizePairingRelayUrl(relayUrl);
  if (!normalized) return;
  try {
    storage.setItem(PAIRING_RELAY_URL_STORAGE_KEY, normalized);
  } catch {
    // Storage is an optional convenience. Pairing still succeeds when it is
    // unavailable (private browsing, quota policy, or an embedded runtime).
  }
};
