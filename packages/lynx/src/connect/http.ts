import type { LynxHttpInit, LynxSessionStatus } from './types.ts';

export const readSessionStatus = async (
  response: { json: () => Promise<unknown> } | null,
): Promise<LynxSessionStatus | null> => {
  if (!response) return null;
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  return {
    authenticated: typeof record.authenticated === 'boolean' ? record.authenticated : undefined,
    disabled: typeof record.disabled === 'boolean' ? record.disabled : undefined,
    scope: typeof record.scope === 'string' ? record.scope : undefined,
    serverId: typeof record.serverId === 'string' ? record.serverId : undefined,
  };
};

export const readHealthServerId = async (
  response: { json: () => Promise<unknown> } | null,
): Promise<string | null> => {
  if (!response) return null;
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object') return null;
  const reported = (payload as Record<string, unknown>).serverId;
  return typeof reported === 'string' && reported ? reported : null;
};

export const bearerHeaders = (token?: string): Record<string, string> | undefined =>
  token ? { Authorization: `Bearer ${token}` } : undefined;

export const jsonInit = (body: unknown, extra?: LynxHttpInit): LynxHttpInit => ({
  method: extra?.method ?? 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra?.headers,
  },
  body: typeof extra?.body === 'string' ? extra.body : JSON.stringify(body),
  timeoutMs: extra?.timeoutMs,
});

export const isAuthRejection = (status: LynxSessionStatus | null, httpStatus?: number): boolean => {
  if (httpStatus === 401) return true;
  return Boolean(status && status.disabled !== true && status.authenticated === false);
};

export const joinUrl = (base: string, path: string): string => {
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
};

