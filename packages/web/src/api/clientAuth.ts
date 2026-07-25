import type {
  ClientAuthAPI,
  PairingSessionCreateResult,
  PendingPairingRecord,
  RemoteClientCreateResult,
  RemoteClientPurgeRevokedResult,
  RemoteClientRecord,
  RemoteClientRevokeResult,
} from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';

const jsonOrNull = async <T>(response: Response): Promise<T | null> => {
  return (await response.json().catch(() => null)) as T | null;
};

// Normalize a user-entered HAPI Hub URL (http/https or bare host) into the
// private-relay WebSocket endpoint: ws(s)://<host>/api/openchamber/relay/ws
// Path is always rewritten to that exact route so a pasted dashboard URL works.
export const normalizeHapiHubRelayWsUrl = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withScheme);
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    else if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
    parsed.pathname = '/api/openchamber/relay/ws';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
};

export const createWebClientAuthAPI = (): ClientAuthAPI => ({
  async listClients(): Promise<RemoteClientRecord[]> {
    const response = await runtimeFetch('/api/client-auth/clients', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ clients?: RemoteClientRecord[]; error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load remote clients');
    }
    return Array.isArray(payload.clients) ? payload.clients : [];
  },

  async createClient(input = {}): Promise<RemoteClientCreateResult> {
    const response = await runtimeFetch('/api/client-auth/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ label: input.label ?? '' }),
    });
    const payload = await jsonOrNull<RemoteClientCreateResult & { error?: string }>(response);
    if (!response.ok || !payload?.client || typeof payload.token !== 'string') {
      throw new Error(payload?.error || response.statusText || 'Failed to create remote client token');
    }
    return payload;
  },

  async createPairingSession(input = {}): Promise<PairingSessionCreateResult> {
    const response = await runtimeFetch('/api/client-auth/pairing/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        label: input.label ?? '',
        ...(input.allowedClientKinds ? { allowedClientKinds: input.allowedClientKinds } : {}),
        ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}),
        ...(typeof input.includeRelay === 'boolean' ? { includeRelay: input.includeRelay } : {}),
        ...(typeof input.includeDirect === 'boolean' ? { includeDirect: input.includeDirect } : {}),
      }),
    });
    const payload = await jsonOrNull<PairingSessionCreateResult & { error?: string }>(response);
    if (!response.ok || typeof payload?.pairing?.secret !== 'string' || !payload?.server) {
      throw new Error(payload?.error || response.statusText || 'Failed to create pairing session');
    }
    return payload;
  },

  async listPendingPairings(): Promise<PendingPairingRecord[]> {
    const response = await runtimeFetch('/api/client-auth/pairing/sessions', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ pending?: PendingPairingRecord[]; error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load pending pairings');
    }
    return Array.isArray(payload.pending) ? payload.pending : [];
  },

  async getPairingTransports(): Promise<{ local: string | null; lan: string | null; relayAvailable: boolean }> {
    const response = await runtimeFetch('/api/client-auth/pairing/transports', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ local?: string | null; lan?: string | null; relayAvailable?: boolean; error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load pairing transports');
    }
    return { local: payload.local ?? null, lan: payload.lan ?? null, relayAvailable: payload.relayAvailable !== false };
  },

  async startHapiTunnel(input): Promise<{ url: string; provider: 'hapi' }> {
    const response = await runtimeFetch('/api/openchamber/tunnel/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        provider: 'hapi',
        mode: 'quick',
        hostname: input.gatewayUrl,
      }),
    });
    const payload = await jsonOrNull<{ ok?: boolean; url?: unknown; provider?: unknown; error?: string }>(response);
    const url = typeof payload?.url === 'string' ? payload.url.trim() : '';
    if (!response.ok || payload?.ok !== true || payload?.provider !== 'hapi' || !url) {
      throw new Error(payload?.error || response.statusText || 'Failed to start HAPI tunnel');
    }
    return { url, provider: 'hapi' };
  },

  async getRelayStatus(): Promise<{
    enabled: boolean;
    state: string;
    relayUrl?: string;
    transport?: 'hapi';
    hasAccessToken: boolean;
    serverId?: string;
    lastError?: string;
  }> {
    const response = await runtimeFetch('/api/openchamber/relay/status', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{
      enabled?: boolean;
      state?: string;
      relayUrl?: string;
      transport?: string;
      hasAccessToken?: boolean;
      serverId?: string;
      lastError?: string;
      error?: string;
      accessToken?: unknown;
    }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to read relay status');
    }
    // Never surface a raw accessToken even if a buggy server echoes one.
    return {
      enabled: payload.enabled === true,
      state: typeof payload.state === 'string' ? payload.state : 'disabled',
      ...(typeof payload.relayUrl === 'string' ? { relayUrl: payload.relayUrl } : {}),
      ...(payload.transport === 'hapi' ? { transport: 'hapi' as const } : {}),
      hasAccessToken: payload.hasAccessToken === true,
      ...(typeof payload.serverId === 'string' ? { serverId: payload.serverId } : {}),
      ...(typeof payload.lastError === 'string' ? { lastError: payload.lastError } : {}),
    };
  },

  // Point this PC's private-relay L1 at a HAPI Hub. accessToken is optional when
  // the server already has one persisted (status.hasAccessToken); omit to reuse.
  // Only resolves when host-control is connected (server readiness gate).
  async configureHapiRelay(input): Promise<{ enabled: boolean; relayUrl: string; transport: 'hapi'; serverId?: string; state?: string }> {
    const accessToken = typeof input.accessToken === 'string' ? input.accessToken.trim() : '';
    const relayUrl = normalizeHapiHubRelayWsUrl(input.hubUrl);
    if (!relayUrl) throw new Error('Invalid HAPI Hub URL');
    const body: { relayUrl: string; transport: 'hapi'; accessToken?: string } = {
      relayUrl,
      transport: 'hapi',
    };
    if (accessToken) body.accessToken = accessToken;
    const response = await runtimeFetch('/api/openchamber/relay/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await jsonOrNull<{
      enabled?: boolean;
      relayUrl?: string;
      transport?: string;
      serverId?: string;
      state?: string;
      error?: string;
    }>(response);
    if (!response.ok || !payload || payload.enabled !== true) {
      throw new Error(payload?.error || response.statusText || 'Failed to configure HAPI relay');
    }
    // Server only returns 2xx after host-control is connected for HAPI.
    if (payload.state && payload.state !== 'connected' && payload.state !== 'standby') {
      throw new Error(payload.error || `HAPI relay not ready (state=${payload.state})`);
    }
    return {
      enabled: true,
      relayUrl: typeof payload.relayUrl === 'string' ? payload.relayUrl : relayUrl,
      transport: 'hapi',
      ...(typeof payload.serverId === 'string' ? { serverId: payload.serverId } : {}),
      ...(typeof payload.state === 'string' ? { state: payload.state } : {}),
    };
  },

  // Restore classic OpenChamber Private Relay (drop HAPI transport + token).
  async configureClassicRelay(input = {}): Promise<{ enabled: boolean; relayUrl: string; transport?: 'hapi'; hasAccessToken?: boolean; state?: string }> {
    const response = await runtimeFetch('/api/openchamber/relay/classic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        ...(typeof input.relayUrl === 'string' ? { relayUrl: input.relayUrl } : {}),
        ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
      }),
    });
    const payload = await jsonOrNull<{
      enabled?: boolean;
      relayUrl?: string;
      transport?: string;
      hasAccessToken?: boolean;
      state?: string;
      error?: string;
    }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to configure classic relay');
    }
    return {
      enabled: payload.enabled === true,
      relayUrl: typeof payload.relayUrl === 'string' ? payload.relayUrl : '',
      ...(payload.transport === 'hapi' ? { transport: 'hapi' as const } : {}),
      hasAccessToken: payload.hasAccessToken === true,
      ...(typeof payload.state === 'string' ? { state: payload.state } : {}),
    };
  },

  async cancelPairing(id: string): Promise<{ cancelled: boolean }> {
    const response = await runtimeFetch(`/api/client-auth/pairing/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ cancelled?: boolean; error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to cancel pairing');
    }
    return { cancelled: payload.cancelled === true };
  },

  async revokeClient(id: string): Promise<RemoteClientRevokeResult> {
    const response = await runtimeFetch(`/api/client-auth/clients/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<RemoteClientRevokeResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to revoke remote client');
    }
    return payload;
  },

  async purgeRevokedClients(): Promise<RemoteClientPurgeRevokedResult> {
    const response = await runtimeFetch('/api/client-auth/clients', {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<RemoteClientPurgeRevokedResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to clear revoked clients');
    }
    return payload;
  },
});
