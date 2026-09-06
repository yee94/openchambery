import type { LynxHostAdapters } from '../host/adapters.ts';
import { jsonInit } from './http.ts';
import { mobileClientDedupeKey } from './ids.ts';
import { LYNX_CLIENT_KIND, LYNX_CLIENT_LABEL } from './types.ts';
import type { LiveTransport } from './probe.ts';

export const loginWithPasswordOnTransport = async (
  transport: LiveTransport,
  password: string,
  host: LynxHostAdapters,
  options: { deviceId: string; devicePlatform?: 'ios' | 'android' },
): Promise<{ token: string } | null> => {
  const body = {
    password,
    trustDevice: true,
    issueClientToken: true,
    clientLabel: LYNX_CLIENT_LABEL,
    clientKind: LYNX_CLIENT_KIND,
    devicePlatform: options.devicePlatform ?? host.devicePlatform,
    dedupeKey: mobileClientDedupeKey(options.deviceId),
  };
  const init = jsonInit(body);
  const response = transport.kind === 'relay'
    ? await transport.tunnel.fetch('/auth/session', init).catch(() => null)
    : await host.request(`${transport.url}/auth/session`, init).catch(() => null);
  if (!response?.ok) return null;
  const payload = await response.json().catch(() => null) as { clientToken?: unknown } | null;
  const issuedToken = typeof payload?.clientToken === 'string' ? payload.clientToken.trim() : '';
  if (!issuedToken) return null;
  return { token: issuedToken };
};
