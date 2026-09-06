import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';
import Constants from 'expo-constants';

export class AboutApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'AboutApiError';
    this.status = status;
  }
}

export type AboutInfo = {
  clientVersion: string;
  clientName: string;
  serverOpenChamber?: string;
  serverOpenCode?: string;
  serverId?: string;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const clientAboutInfo = (): Pick<AboutInfo, 'clientVersion' | 'clientName'> => ({
  clientName: 'OpenChamber Expo',
  clientVersion:
    Constants.expoConfig?.version ??
    Constants.nativeAppVersion ??
    '1.19.7-beta.7',
});

/** GET /health — instance versions (not Capgo). */
export const loadAboutInfo = async (
  active: ActiveRuntime,
  options?: { signal?: AbortSignal },
): Promise<AboutInfo> => {
  const client = clientAboutInfo();
  const response = await openchamberFetch(active, '/health', {
    method: 'GET',
    signal: options?.signal,
  });
  if (!response.ok) {
    throw new AboutApiError('Failed to load instance health', response.status);
  }
  const row = asRecord(await response.json()) ?? {};
  return {
    ...client,
    serverOpenChamber:
      typeof row.version === 'string'
        ? row.version
        : typeof row.openchamberVersion === 'string'
          ? row.openchamberVersion
          : undefined,
    serverOpenCode:
      typeof row.opencodeVersion === 'string'
        ? row.opencodeVersion
        : typeof asRecord(row.opencode)?.version === 'string'
          ? (asRecord(row.opencode)!.version as string)
          : undefined,
    serverId: typeof row.serverId === 'string' ? row.serverId : undefined,
  };
};
