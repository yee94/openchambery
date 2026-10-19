import { Capacitor, registerPlugin } from '@capacitor/core';
import { buildRuntimeAuthHeaders } from '@/lib/runtime-auth';
import { getActiveRelayDescriptor, getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';
import { loadMobileConnections, mobileConnectionKey } from '@/apps/mobileConnections';
import type { RelayRuntimeDescriptor } from '@/lib/relay/runtime-tunnel';

export interface AndroidNotificationConfig {
  runtimeKey: string;
  baseUrl: string;
  relay?: RelayRuntimeDescriptor;
  preferRelay: boolean;
  headers: Record<string, string>;
  labels: Record<string, string>;
}

interface AndroidNotificationsPlugin {
  configure(options: { config: AndroidNotificationConfig }): Promise<{ state: 'started' | 'pending' | 'denied' | 'unavailable' | 'stopped' }>;
  stop(): Promise<void>;
}

export const androidNotifications = registerPlugin<AndroidNotificationsPlugin>('OpenChamberNotifications');
export const canUseAndroidNotifications = (): boolean => Capacitor.getPlatform() === 'android'
  && Capacitor.isPluginAvailable('OpenChamberNotifications');

/** Snapshot current runtime credentials in memory only; the controller fences async endpoint changes. */
export async function resolveAndroidNotificationConfig(labels: Record<string, string>, locale: string): Promise<AndroidNotificationConfig | null> {
  const runtimeKey = getRuntimeKey();
  const activeRelay = getActiveRelayDescriptor();
  const baseUrl = activeRelay ? '' : getRuntimeApiBaseUrl();
  if (!activeRelay && !/^https?:\/\//.test(baseUrl)) return null;
  const headers = await buildRuntimeAuthHeaders();
  headers.set('Accept-Language', locale);
  const saved = (await loadMobileConnections()).find((entry) => mobileConnectionKey(entry) === runtimeKey);
  const candidate = saved?.candidates.find((entry) => entry.kind === 'relay');
  const relay = activeRelay ?? (candidate?.kind === 'relay' ? candidate.relay : undefined);
  return { runtimeKey, baseUrl, relay, preferRelay: Boolean(activeRelay), headers: Object.fromEntries(headers.entries()), labels };
}

/** Stops old credentials immediately; delayed config reads may never resurrect an old runtime. */
export function createAndroidNotificationController(deps: {
  plugin: AndroidNotificationsPlugin;
  resolveConfig: () => Promise<AndroidNotificationConfig | null>;
  onState: (state: string) => void;
  onError: () => void;
}) {
  let epoch = 0;
  let disposed = false;
  const refresh = async () => {
    const current = ++epoch;
    try {
      await deps.plugin.stop();
      if (disposed || current !== epoch) return;
      const config = await deps.resolveConfig();
      if (disposed || current !== epoch || !config) return;
      const result = await deps.plugin.configure({ config });
      if (!disposed && current === epoch) deps.onState(result.state);
    } catch {
      if (!disposed && current === epoch) deps.onError();
    }
  };
  return {
    refresh,
    stop: () => { ++epoch; void deps.plugin.stop().catch(deps.onError); },
    dispose: () => { disposed = true; ++epoch; void deps.plugin.stop().catch(deps.onError); },
  };
}
