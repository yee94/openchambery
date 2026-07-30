import { isCapacitorApp } from '@/lib/platform';

declare const __APP_VERSION__: string | undefined;

const nonEmptyVersion = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
);

const getBundledClientVersion = (): string | null => (
  typeof __APP_VERSION__ !== 'undefined' ? nonEmptyVersion(__APP_VERSION__) : null
);

export const resolveMobileClientVersion = (nativeVersion: unknown, bundledVersion: string | null): string | null => (
  nonEmptyVersion(nativeVersion) ?? bundledVersion
);

export const getMobileClientVersion = async (): Promise<string | null> => {
  const bundledVersion = getBundledClientVersion();
  if (!isCapacitorApp()) return bundledVersion;

  try {
    const { App } = await import('@capacitor/app');
    const info = await App.getInfo();
    return resolveMobileClientVersion(info.version, bundledVersion);
  } catch {
    return bundledVersion;
  }
};
