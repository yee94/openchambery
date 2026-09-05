import type { PluginListenerHandle } from '@capacitor/core';
import { useEvent } from '@reactuses/core';
import { useEffect, useMemo, useRef } from 'react';

import { collectRunningSessionIds } from '@/components/session/sidebar/hooks/useAlwaysVisibleSessionIds';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import {
  applyNativeLiveActivityTokenCommands,
  buildNativeLiveActivityCatalog,
  canUseNativeIosLiveActivity,
  createInitialNativeLiveActivityState,
  createInitialNativeLiveActivityTokenState,
  getNativeIosLiveActivityPlugin,
  NATIVE_LIVE_ACTIVITY_ID,
  parseNativeLiveActivityPushTokenEvent,
  reduceNativeLiveActivityToken,
  runNativeLiveActivityStep,
  type NativeLiveActivityObservation,
  type NativeLiveActivityState,
  type NativeLiveActivityTokenAction,
  type NativeLiveActivityTokenState,
} from '@/lib/native-ios-live-activity';
import { getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useAllSessionStatuses } from '@/sync/sync-context';

const EMPTY_STATUS_BY_ID = new Map<string, { status: 'busy' | 'retry'; directory: string }>();
const EMPTY_SESSIONS: readonly { id: string; title?: string | null; parentID?: string | null }[] = [];

/**
 * Drives the Capacitor iOS Live Activity for every live working session.
 * Plugin calls are no-ops on web / Electron / VS Code / Android.
 */
export function useNativeLiveActivity(): void {
  const available = canUseNativeIosLiveActivity();
  const connected = useConfigStore((state) => state.isConnected);
  const liveStatuses = useAllSessionStatuses({ enabled: available });
  const fallbackStatuses = useGlobalSessionStatusStore((state) => (
    available ? state.statusById : EMPTY_STATUS_BY_ID
  ));
  const sessions = useGlobalSessionsStore((state) => (
    available ? state.activeSessions : EMPTY_SESSIONS
  ));
  const runningIds = useMemo(
    () => (available ? collectRunningSessionIds(liveStatuses, fallbackStatuses) : new Set<string>()),
    [available, fallbackStatuses, liveStatuses],
  );
  const catalog = useMemo(
    () => (available ? buildNativeLiveActivityCatalog({
      runningIds,
      statuses: liveStatuses,
      sessions,
    }) : []),
    [available, liveStatuses, runningIds, sessions],
  );
  const catalogSignature = useMemo(
    () => catalog.map((item) => `${item.sessionId}\0${item.title}\0${item.statusType ?? ''}`).join('\n'),
    [catalog],
  );
  const stateRef = useRef<NativeLiveActivityState>(createInitialNativeLiveActivityState());
  const tokenStateRef = useRef<NativeLiveActivityTokenState>(createInitialNativeLiveActivityTokenState());
  const supportedRef = useRef<boolean | null>(null);
  const epochRef = useRef(0);
  const chainRef = useRef(Promise.resolve());
  const tokenChainRef = useRef(Promise.resolve());
  const pushTokenHandleRef = useRef<PluginListenerHandle | null>(null);

  const observe = useEvent((): NativeLiveActivityObservation => ({
    sessionId: NATIVE_LIVE_ACTIVITY_ID,
    statusType: undefined,
    hasPendingPermissions: false,
    hasPendingQuestions: false,
    hasSessionError: false,
    now: Date.now(),
    connected,
    catalog,
  }));

  const dispatchTokenAction = useEvent((action: NativeLiveActivityTokenAction): void => {
    tokenChainRef.current = tokenChainRef.current.then(async () => {
      const reduced = reduceNativeLiveActivityToken(tokenStateRef.current, {
        selectedSessionId: NATIVE_LIVE_ACTIVITY_ID,
        runtimeIdentity: getRuntimeTransportIdentity(),
        connected,
        enabled: available,
      }, action);
      tokenStateRef.current = reduced.state;
      if (reduced.commands.length === 0) return;
      tokenStateRef.current = await applyNativeLiveActivityTokenCommands({
        state: tokenStateRef.current,
        commands: reduced.commands,
        getRuntimeIdentity: getRuntimeTransportIdentity,
        register: (payload) => getRegisteredRuntimeAPIs()?.push?.registerLiveActivityToken?.(payload) ?? Promise.resolve(null),
        unregister: (payload) => getRegisteredRuntimeAPIs()?.push?.unregisterLiveActivityToken?.(payload) ?? Promise.resolve(null),
      });
    }).catch(() => undefined);
  });

  const handlePushToken = useEvent((payload: unknown): void => {
    const parsed = parseNativeLiveActivityPushTokenEvent(payload);
    if (!parsed) return;
    dispatchTokenAction({ type: 'pushToken', ...parsed, sessionId: NATIVE_LIVE_ACTIVITY_ID });
  });

  useEffect(() => {
    dispatchTokenAction({ type: available ? 'sync' : 'dispose' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- available/connected are the real inputs; dispatchTokenAction is useEvent-stable and must not control this effect.
  }, [available, connected]);

  useEffect(
    () => subscribeRuntimeEndpointChanged(() => {
      dispatchTokenAction({ type: 'sync' });
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once on mount; dispatchTokenAction is useEvent-stable and must not control this effect.
    [],
  );

  useEffect(() => {
    if (!available) {
      void pushTokenHandleRef.current?.remove();
      pushTokenHandleRef.current = null;
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    const plugin = getNativeIosLiveActivityPlugin();
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;

    const run = (): void => {
      chainRef.current = chainRef.current.then(async () => {
        if (cancelled || epochRef.current !== epoch) return;
        if (supportedRef.current !== true) {
          if (supportedRef.current === false) return;
          const result = await plugin.isSupported().catch(() => ({ supported: false }));
          if (cancelled || epochRef.current !== epoch) return;
          supportedRef.current = result.supported === true;
          if (!supportedRef.current) return;
        }

        const observation = observe();
        const previousStarted = stateRef.current.started;
        const result = await runNativeLiveActivityStep({
          available: true,
          plugin,
          state: stateRef.current,
          observation,
          epoch,
          getCurrentEpoch: () => epochRef.current,
          retryCount,
        });
        if (cancelled || epochRef.current !== epoch || result.superseded) return;
        stateRef.current = result.state;
        if (previousStarted && !result.state.started) {
          dispatchTokenAction({ type: 'localEndSucceeded' });
        }
        if (result.retry) retryCount += 1;
        else retryCount = 0;
        if (result.delayMs != null) {
          timer = setTimeout(() => {
            run();
          }, result.delayMs);
        }
      }).catch(() => undefined);
    };

    chainRef.current = chainRef.current.then(async () => {
      if (cancelled || epochRef.current !== epoch) return;
      if (pushTokenHandleRef.current) return;
      try {
        const handle = await plugin.addListener('pushToken', (payload) => {
          handlePushToken(payload);
        });
        if (cancelled) {
          await handle.remove();
          return;
        }
        pushTokenHandleRef.current = handle;
      } catch {
        return;
      }
    }).then(() => {
      if (!cancelled && epochRef.current === epoch) run();
    }).catch(() => undefined);

    return () => {
      cancelled = true;
      if (epochRef.current === epoch) epochRef.current += 1;
      if (timer !== null) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catalog/connection identity is the real input; observe/handlePushToken/dispatchTokenAction are useEvent-stable and must not control this effect.
  }, [
    available,
    connected,
    catalogSignature,
  ]);

  useEffect(
    () => () => {
      void pushTokenHandleRef.current?.remove();
      pushTokenHandleRef.current = null;
      dispatchTokenAction({ type: 'dispose' });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount cleanup only; dispatchTokenAction is useEvent-stable and must not control this effect.
    [],
  );
}
