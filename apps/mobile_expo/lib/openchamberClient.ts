import type { ActiveRuntime } from '@/lib/connectionController';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';

export type OpenchamberResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

const toOpenchamberResponse = async (response: Response): Promise<OpenchamberResponse> => {
  const clone = response.clone();
  return {
    ok: response.ok,
    status: response.status,
    json: async () => {
      try {
        return await response.json();
      } catch {
        return null;
      }
    },
    text: async () => {
      try {
        return await clone.text();
      } catch {
        return '';
      }
    },
  };
};

/**
 * Authenticated OpenChamber HTTP using the Connect Track 1 ActiveRuntime.
 * Direct: absolute URL on the chosen base. Relay: tunnel.fetch(path).
 */
export const openchamberFetch = async (
  active: ActiveRuntime,
  path: string,
  init?: RequestInit,
): Promise<OpenchamberResponse> => {
  const headers = new Headers(init?.headers);
  if (active.clientToken) {
    headers.set('Authorization', `Bearer ${active.clientToken}`);
  }
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  const nextInit: RequestInit = { ...init, headers };

  const transport = active.transport;
  if (transport.kind === 'direct') {
    const base = transport.url.replace(/\/+$/, '');
    const suffix = path.startsWith('/') ? path : `/${path}`;
    const response = await fetch(`${base}${suffix}`, nextInit);
    return toOpenchamberResponse(response);
  }

  let tunnel = transport.tunnel;
  if (!tunnel) {
    tunnel = createRelayTunnelClient({
      relayUrl: transport.relay.relayUrl,
      serverId: transport.relay.serverId,
      hostEncPubJwk: transport.relay.hostEncPubJwk,
    });
    transport.tunnel = tunnel;
  }

  const response = await tunnel.fetch(path.startsWith('/') ? path : `/${path}`, nextInit);
  return toOpenchamberResponse(response);
};
