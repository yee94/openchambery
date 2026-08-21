import { isElectronShell } from '@/lib/desktop';
import { desktopLocalClientTokenGet, type DesktopHost } from '@/lib/desktopHosts';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { switchDesktopHostInstance } from '@/queries/desktopHostSwitchMutation';

/** Local in-process API origin (Electron injects `__OPENCHAMBER_LOCAL_ORIGIN__`). SSR-safe. */
export const getLocalRuntimeOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  return window.__OPENCHAMBER_LOCAL_ORIGIN__ || window.location.origin;
};

/** True when the active runtime is the local in-process server (or non-Electron). */
export const isLocalRuntimeActive = (): boolean => {
  if (!isElectronShell()) return true;
  return getRuntimeKey() === 'local';
};

const buildLocalHost = (localOrigin: string): DesktopHost => ({
  id: 'local',
  label: 'Local',
  url: localOrigin,
});

/**
 * Switch the desktop UI onto the local runtime instance.
 * No-op outside Electron or when already on local.
 */
export const switchToLocalDesktopRuntime = async (): Promise<
  { ok: true } | { ok: false; reason: string }
> => {
  if (!isElectronShell() || isLocalRuntimeActive()) {
    return { ok: true };
  }

  const localApiOrigin = getLocalRuntimeOrigin();
  const localClientToken = await desktopLocalClientTokenGet().catch(() => '');
  const result = await switchDesktopHostInstance({
    host: buildLocalHost(localApiOrigin),
    localApiOrigin,
    localClientToken,
  });

  if (result.ok) {
    return { ok: true };
  }
  return { ok: false, reason: result.reason };
};
