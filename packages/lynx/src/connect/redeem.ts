import type { LynxHostAdapters } from '../host/adapters.ts';
import { jsonInit } from './http.ts';
import { mobileClientDedupeKey } from './ids.ts';
import { LYNX_CLIENT_KIND, LYNX_CLIENT_LABEL, type LynxPairingConnectionPayload } from './types.ts';
import type { LiveTransport } from './probe.ts';

export type PairingRedeemResponse = {
  ok?: boolean;
  clientToken?: unknown;
  client?: { label?: unknown } | null;
  server?: { label?: unknown; url?: unknown } | null;
};

export const redeemPairingOnTransport = async (
  transport: LiveTransport,
  payload: LynxPairingConnectionPayload,
  host: LynxHostAdapters,
  options: { deviceId: string; devicePlatform?: 'ios' | 'android' },
): Promise<{ token: string; serverLabel: string } | null> => {
  const body = {
    pairingId: payload.pairingId,
    secret: payload.secret,
    clientLabel: LYNX_CLIENT_LABEL,
    clientKind: LYNX_CLIENT_KIND,
    deviceName: LYNX_CLIENT_LABEL,
    devicePlatform: options.devicePlatform ?? host.devicePlatform,
    dedupeKey: mobileClientDedupeKey(options.deviceId),
  };
  const init = jsonInit(body);
  const response = transport.kind === 'relay'
    ? await transport.tunnel.fetch('/api/client-auth/pairing/redeem', init).catch(() => null)
    : await host.request(`${transport.url}/api/client-auth/pairing/redeem`, init).catch(() => null);
  if (!response?.ok) return null;
  const result = await response.json().catch(() => null) as PairingRedeemResponse | null;
  const issuedToken = typeof result?.clientToken === 'string' ? result.clientToken.trim() : '';
  if (!issuedToken) return null;
  const serverLabel = typeof result?.server?.label === 'string' ? result.server.label : '';
  return { token: issuedToken, serverLabel };
};
