import { runtimeFetch } from '@/lib/runtime-fetch';

export type UpgradeScreenState = 'compatible' | 'incompatible' | 'unavailable';
export type UpgradeScreenInstallation = 'managed' | 'external' | 'bundled';

export type UpgradeScreenStatus = {
  state: UpgradeScreenState;
  version: string | null;
  installation: UpgradeScreenInstallation;
  minimumVersion: string;
  targetVersion: string;
  canInstall: boolean;
  guidance: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const readString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

export const parseUpgradeScreenStatus = (value: unknown): UpgradeScreenStatus => {
  if (!isRecord(value)) throw new Error('Could not check OpenCode compatibility');
  const state = value.state;
  const installation = value.installation;
  if (state !== 'compatible' && state !== 'incompatible' && state !== 'unavailable') {
    throw new Error('Could not check OpenCode compatibility');
  }
  if (installation !== 'managed' && installation !== 'external' && installation !== 'bundled') {
    throw new Error('Could not check OpenCode compatibility');
  }
  const minimumVersion = readString(value.minimumVersion);
  const targetVersion = readString(value.targetVersion);
  if (!minimumVersion || !targetVersion || typeof value.canInstall !== 'boolean') {
    throw new Error('Could not check OpenCode compatibility');
  }
  return {
    state,
    version: readString(value.version),
    installation,
    minimumVersion,
    targetVersion,
    canInstall: value.canInstall,
    guidance: readString(value.guidance),
  };
};

export const fetchUpgradeScreenStatus = async (): Promise<UpgradeScreenStatus> => {
  const response = await runtimeFetch('/api/opencode/compatibility', { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error('Could not check OpenCode compatibility');
  return parseUpgradeScreenStatus(await response.json());
};

export const installRequiredOpenCode = async (): Promise<{ version: string }> => {
  const response = await runtimeFetch('/api/opencode/install-required', { method: 'POST' });
  const body = await response.json().catch(() => null);
  const record = isRecord(body) ? body : null;
  const error = readString(record?.error);
  if (!response.ok || record?.success !== true || record?.upgraded !== true) {
    throw new Error(error || 'OpenCode installation failed');
  }
  const version = readString(record.version);
  if (!version) throw new Error(error || 'OpenCode installation did not report a verified version');
  return { version };
};
