import React from 'react';
import { toast } from 'sonner';
import { useEvent, useEventListener } from '@reactuses/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { GuiPluginHost, PluginGuiBundle } from './host';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useCurrentSessionEntity } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { ThemeSystemContext } from '@/contexts/theme-system-context';
import { getRuntimeKey, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { guiBundleOptions, guiInventoryOptions } from '@/queries/guiPluginQueries';
import { guiPreferencesKey, readDisabledPlugins, writePluginEnabled } from './preferences';
import { GuiFileIconsContext, GuiPluginsContext, getEmptySnapshot, type GuiPluginsContextValue } from './react';
import { getDesktopGuiPluginBridge, getDesktopGuiPluginWindowBridge } from '@/lib/desktop';
import type { NativeGuiActivation } from './native-types';
import { NativeGuiError, requestNativeGui } from './native-errors';
import { afterGuiPaint, createGuiInstallQueue } from './scheduling';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
const noop = () => {};
const noopSubscribe = () => noop;
const message = (error: unknown): string | null => error ? error instanceof Error ? error.message : String(error) : null;
type BundleState = { loading: boolean; error: string | null };

const Surface = React.lazy(() => import('@/components/gui-plugins/GuiPluginSurface').then((module) => ({ default: module.GuiPluginSurface })));

function SurfaceFailure() {
  const { t } = useI18n();
  React.useEffect(() => { toast.error(t('guiPlugins.failed')); }, [t]);
  return null;
}

function LoadErrors({ error, inventory }: Pick<GuiPluginsContextValue, 'error' | 'inventory'>) {
  const { t } = useI18n();
  const reported = React.useRef(new Set<string>());
  React.useEffect(() => {
    const errors = [error, ...inventory.map((plugin) => plugin.error ? `${plugin.id}: ${plugin.error}` : null)].filter((value): value is string => Boolean(value));
    for (const detail of errors) {
      if (!reported.current.has(detail)) toast.error(t('guiPlugins.failed'), { description: detail });
    }
    reported.current = new Set(errors);
  }, [error, inventory, t]);
  return null;
}

/** One observer per enabled plugin; failed refreshes leave its last working bundle alive. */
function Activation({ host, id, transport, report, schedule }: {
  host: GuiPluginHost; id: string; transport: string; report(host: GuiPluginHost, id: string, state: BundleState | null): void;
  schedule: ReturnType<typeof createGuiInstallQueue>;
}) {
  const query = useQuery(guiBundleOptions(transport, id));
  const [activationState, setActivationState] = React.useState({ loading: false, error: null as string | null });
  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const install = (bundle: PluginGuiBundle, native?: import('./native').NativeGuiSession) => schedule(controller.signal, () => {
      if (getRuntimeTransportIdentity() !== transport) { native?.dispose(); return; }
      if (native) host.install(id, bundle, native);
      else host.install(id, bundle);
    }).catch((error) => { native?.dispose(); throw error; });
    const bridge = getDesktopGuiPluginBridge();
    const windowBridge = getDesktopGuiPluginWindowBridge();
    if (!query.data || (!bridge && !windowBridge)) {
      if (!query.data) { setActivationState({ loading: false, error: null }); return; }
      setActivationState({ loading: true, error: null });
      void install(query.data).then(() => {
        if (!cancelled) setActivationState({ loading: false, error: null });
      }).catch((cause) => { if (!cancelled) setActivationState({ loading: false, error: message(cause) }); });
      return () => { cancelled = true; controller.abort(); };
    }
    setActivationState({ loading: true, error: null });
    const installWindowOnly = async () => {
      if (windowBridge) await requestNativeGui(windowBridge, 'window-only', {});
      if (cancelled || getRuntimeTransportIdentity() !== transport) return;
      await install(query.data!);
      if (!cancelled) setActivationState({ loading: false, error: null });
    };
    void import('./native').then(async ({ NativeGuiSession }) => {
      if (cancelled) return;
      if (!bridge) { await installWindowOnly(); return; }
      const activation = await requestNativeGui(bridge, 'acquire', { id, revision: query.data!.revision }) as NativeGuiActivation;
      const native = new NativeGuiSession(bridge, activation);
      if (cancelled || getRuntimeTransportIdentity() !== transport) { native.dispose(); return; }
      await install(activation.bundle, native);
      if (!cancelled) setActivationState({ loading: false, error: null });
    }).catch(async (cause) => {
      if (cancelled) return;
      if (cause instanceof NativeGuiError && ['GUI_PLUGIN_UNTRUSTED_SOURCE', 'GUI_PLUGIN_DOCUMENT_RESTRICTED', 'GUI_PLUGIN_FORBIDDEN'].includes(cause.code)) {
        try { await installWindowOnly(); return; } catch (error) { cause = error; }
      }
      if (!cancelled) setActivationState({ loading: false, error: message(cause) });
    });
    return () => { cancelled = true; controller.abort(); };
  }, [host, id, transport, query.data, query.dataUpdatedAt, schedule]);
  React.useEffect(() => {
    report(host, id, { loading: activationState.loading || query.isPending || query.isFetching, error: activationState.error ?? message(query.error) });
  }, [host, id, activationState, query.error, query.isPending, query.isFetching, report]);
  React.useEffect(() => () => { host.uninstall(id); report(host, id, null); }, [host, id, report]);
  return null;
}

export function GuiPluginsProvider({ children, ready = true }: { children: React.ReactNode; ready?: boolean }) {
  const { files, viewExport } = useRuntimeAPIs();
  const queryClient = useQueryClient();
  const transport = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeTransportIdentity, getRuntimeTransportIdentity);
  const preferenceKey = guiPreferencesKey(getRuntimeKey());
  const [paintedTransport, setPaintedTransport] = React.useState<string | null>(null);
  const painted = ready && paintedTransport === transport;
  React.useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    void afterGuiPaint(controller.signal).then(() => {
      if (!controller.signal.aborted && getRuntimeTransportIdentity() === transport) setPaintedTransport(transport);
    }).catch(() => {});
    return () => { controller.abort(); setPaintedTransport(null); };
  }, [ready, transport]);
  const inventoryQuery = useQuery({ ...guiInventoryOptions(transport), enabled: painted });
  const installQueue = React.useMemo(() => ({ transport, run: createGuiInstallQueue() }), [transport]);
  const [preferences, setPreferences] = React.useState<{ key: string; disabled: readonly string[] | null; error: string | null } | null>(null);
  const disabled = preferences?.key === preferenceKey ? preferences.disabled : null;
  const preferenceError = preferences?.key === preferenceKey ? preferences.error : null;
  const [demand, setDemand] = React.useState({ transport, requested: false });
  const requested = demand.transport === transport && demand.requested;
  const requestLoad = useEvent(() => setDemand((current) => current.transport === transport && current.requested ? current : { transport, requested: true }));
  const [hostError, setHostError] = React.useState<{ transport: string; error: string | null } | null>(null);
  if (demand.transport !== transport) {
    setDemand({ transport, requested: false });
    setHostError(null);
  }
  const loadError = hostError?.transport === transport ? hostError.error : null;
  const [hostAttempt, setHostAttempt] = React.useState(0);
  const [bundles, setBundles] = React.useState<{ host: GuiPluginHost; states: Record<string, BundleState> } | null>(null);
  const [resource, setResource] = React.useState<{ transport: string; host: GuiPluginHost } | null>(null);
  const host = resource?.transport === transport ? resource.host : null;
  const { locale } = useI18n();
  const theme = React.useContext(ThemeSystemContext);
  const mode = theme?.currentTheme.metadata.variant ?? 'dark';
  const narrow = useUIStore((state) => state.isMobile);
  const sessionID = useSessionUIStore((state) => state.currentSessionId);
  const directory = useCurrentSessionEntity(sessionID)?.directory;
  const environment = React.useRef({ locale, mode, narrow });
  React.useLayoutEffect(() => { environment.current = { locale, mode, narrow }; }, [locale, mode, narrow]);

  const readPreferences = useEvent(() => {
    try {
      setPreferences({ key: preferenceKey, disabled: readDisabledPlugins(window.localStorage, preferenceKey), error: null });
    } catch (error) {
      setPreferences({ key: preferenceKey, disabled: null, error: message(error) });
    }
  });
  React.useEffect(() => { readPreferences(); }, [preferenceKey, readPreferences]);
  useEventListener('storage', (event: StorageEvent) => {
    if (event.key === preferenceKey || event.key === null) readPreferences();
  });
  const setEnabled = useEvent((id: string, enabled: boolean) => {
    try {
      setPreferences({ key: preferenceKey, disabled: writePluginEnabled(window.localStorage, preferenceKey, id, enabled), error: null });
    } catch (error) { setPreferences({ key: preferenceKey, disabled, error: message(error) }); }
  });
  const report = useEvent((owner: GuiPluginHost, id: string, state: BundleState | null) => {
    if (owner !== host) return;
    setBundles((previous) => {
      const states = previous?.host === owner ? previous.states : {};
      if (states[id]?.loading === state?.loading && states[id]?.error === state?.error) return previous;
      const next = { ...states };
      if (state) next[id] = state;
      else delete next[id];
      return { host: owner, states: next };
    });
  });
  const inventory = React.useMemo(() => (inventoryQuery.data ?? []).flatMap((plugin) => {
    if (!plugin.id || !plugin.features.gui) return [];
    const error = plugin.state.status === 'failed' ? plugin.state.error : bundles?.host === host ? bundles.states[plugin.id]?.error : null;
    return [{ id: plugin.id, enabled: disabled !== null && !disabled.includes(plugin.id), ...(error ? { error } : {}) }];
  }), [inventoryQuery.data, disabled, bundles, host]);
  const hasEnabled = disabled !== null && inventory.some((plugin) => plugin.enabled);
  const hasGui = disabled !== null && inventory.length > 0;
  const activeIds = React.useMemo(() => new Set((inventoryQuery.data ?? [])
    .filter((plugin) => plugin.state.status === 'active').map((plugin) => plugin.id)), [inventoryQuery.data]);
  const wantsHost = painted && requested && hasGui && (hasEnabled || host !== null);

  React.useEffect(() => {
    if (!painted || requested || !hasEnabled || !inventory.some((plugin) => plugin.enabled && activeIds.has(plugin.id))) return;
    // Give initial navigation and input priority; explicit demand bypasses this idle wait.
    let cancelled = false;
    const start = () => {
      if (!cancelled && getRuntimeTransportIdentity() === transport) requestLoad();
    };
    if (typeof window.requestIdleCallback === 'function') {
      const task = window.requestIdleCallback(start, { timeout: 2_000 });
      return () => { cancelled = true; window.cancelIdleCallback(task); };
    }
    const task = window.setTimeout(start, 1_000);
    return () => { cancelled = true; window.clearTimeout(task); };
  }, [painted, requested, hasEnabled, inventory, activeIds, transport, requestLoad]);

  React.useEffect(() => {
    if (!wantsHost) return;
    const controller = new AbortController();
    let loaded: GuiPluginHost | undefined;
    setHostError(null);
    void afterGuiPaint(controller.signal).then(() => Promise.all([import('./host'), import('@/lib/opencode/gui'), import('@/components/chat/fileReferenceActions')])).then(([{ GuiPluginHost }, { createGuiClient }, { openFileReference }]) => {
      if (controller.signal.aborted || getRuntimeTransportIdentity() !== transport) return;
      loaded = new GuiPluginHost({
        client: createGuiClient(controller.signal), files, queryClient, transport, viewExport, toast,
        storage: window.localStorage, ...environment.current,
        focusFile: async (path, directory) => {
          if (!controller.signal.aborted) await openFileReference(path, false, { effectiveDirectory: directory });
        },
      });
      setResource({ transport, host: loaded });
    }).catch((error: unknown) => { if (!controller.signal.aborted) setHostError({ transport, error: message(error) }); });
    return () => {
      controller.abort();
      loaded?.dispose();
      setResource((current) => current?.host === loaded ? null : current);
      setBundles((current) => current?.host === loaded ? null : current);
    };
  }, [wantsHost, files, queryClient, transport, hostAttempt, viewExport]);

  React.useLayoutEffect(() => {
    host?.setSession(sessionID && directory ? { id: sessionID, directory } : undefined);
  }, [host, sessionID, directory]);
  React.useLayoutEffect(() => { host?.setAppearance({ locale, mode, narrow }); }, [host, locale, mode, narrow]);

  const subscribe = React.useMemo(() => host ? (listener: () => void) => host.subscribe(listener) : noopSubscribe, [host]);
  const getSnapshot = React.useMemo(() => host ? () => host.getSnapshot() : getEmptySnapshot, [host]);
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getEmptySnapshot);
  const refresh = useEvent(() => {
    readPreferences();
    if (requested && loadError) { setHostError(null); setHostAttempt((attempt) => attempt + 1); }
    void queryClient.invalidateQueries({ queryKey: requested ? [transport, 'plugins', 'gui'] : guiInventoryOptions(transport).queryKey });
  });
  const activationPending = requested && hasEnabled && !loadError && (!host || inventory.some((plugin) =>
    plugin.enabled && activeIds.has(plugin.id) && (bundles?.host !== host || (bundles.states[plugin.id]?.loading ?? true))));
  const value: GuiPluginsContextValue = {
    host, snapshot, inventory,
    error: preferenceError ?? loadError ?? message(inventoryQuery.error),
    loading: inventoryQuery.isPending || (disabled === null && !preferenceError) || activationPending,
    requested, requestLoad, setEnabled, refresh,
  };
  return <GuiPluginsContext.Provider value={value}>
    <GuiFileIconsContext.Provider value={host?.fileIcons ?? null}>
    {children}
    {host && inventory.filter((plugin) => plugin.enabled && activeIds.has(plugin.id)).map((plugin) =>
      <Activation key={plugin.id} host={host} id={plugin.id} transport={transport} report={report} schedule={installQueue.run} />)}
    {painted && <LoadErrors key={transport} error={value.error} inventory={inventory} />}
    {host && <ErrorBoundary key={`surface:${transport}`} fallback={<SurfaceFailure />}><React.Suspense fallback={null}><Surface /></React.Suspense></ErrorBoundary>}
    </GuiFileIconsContext.Provider>
  </GuiPluginsContext.Provider>;
}
