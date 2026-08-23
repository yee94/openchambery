import { isCapacitorApp } from '@/lib/platform';

declare const __APP_VERSION__: string | undefined;

const nonEmptyVersion = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
);

const getBundledClientVersion = (): string | null => (
  typeof __APP_VERSION__ !== 'undefined' ? nonEmptyVersion(__APP_VERSION__) : null
);

export const resolveMobileClientVersion = (nativeVersion: unknown, bundledVersion: string | null): string | null => {
  // Prefer the bundle-supplied complete version (`__APP_VERSION__`, from the
  // release package.json). iOS strips `-beta.N` from CFBundleShortVersionString
  // for TestFlight, so the native marketing version is an incomplete identity
  // there; the bundled version carries the full release version.
  const bundled = nonEmptyVersion(bundledVersion);
  if (bundled) return bundled;
  return nonEmptyVersion(nativeVersion);
};

/**
 * Format the client version row for the About page. iOS marketing versions
 * strip `-beta.N`, so the native build number is appended to disambiguate the
 * exact shell, e.g. `1.18.2-beta.33 (370)`. Falls back to the bare version when
 * the build number is unknown.
 */
export const formatMobileClientVersionLabel = (version: string | null, buildNumber: number | null): string | null => {
  const resolved = nonEmptyVersion(version);
  if (!resolved) return null;
  if (typeof buildNumber !== 'number' || !Number.isFinite(buildNumber)) return resolved;
  return `${resolved} (${buildNumber})`;
};

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

/**
 * Native shell marketing version (CFBundleShortVersionString / versionName)
 * only, without the bundled web-version fallback. iOS TestFlight strips
 * `-beta.N` here; pair with the native build number for a stable shell
 * identity. Use getMobileClientVersion for the running web release version.
 */
export const getMobileNativeVersion = async (): Promise<string | null> => {
  if (!isCapacitorApp()) return null;

  try {
    const { App } = await import('@capacitor/app');
    const info = await App.getInfo();
    return nonEmptyVersion(info.version);
  } catch {
    return null;
  }
};

/**
 * Native build number (CFBundleVersion / versionCode). Increments with every
 * shell release; iOS marketing versions strip `-beta.N`, so the build number is
 * the only reliable per-shell identity there. Returns null when unavailable.
 */
export const getMobileClientBuildNumber = async (): Promise<number | null> => {
  if (!isCapacitorApp()) return null;

  try {
    const { App } = await import('@capacitor/app');
    const info = await App.getInfo();
    const raw = typeof info.build === 'string' ? info.build.trim() : '';
    if (raw.length === 0) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
