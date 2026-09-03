import type { PluginListenerHandle } from '@capacitor/core';
import { useEvent } from '@reactuses/core';
import { useEffect, useRef } from 'react';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useIosNativeUiEnabled } from '@/lib/iosNativeUi';
import {
  applyNativeLiveActivityTokenCommands,
  canUseNativeIosLiveActivity,
  createInitialNativeLiveActivityState,
  createInitialNativeLiveActivityTokenState,
  getNativeIosLiveActivityPlugin,
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
import {
  useLiveSessionStatus,
  useSessionErrorAt,
  useSessionPermissions,
  useSessionQuestions,
} from '@/sync/sync-context';

export type UseNativeLiveActivityArgs = {
  sessionId: string | null | undefined;
  directory?: string | null;
};

/**
 * Drives the Capacitor iOS Live Activity for the MobileApp's current session.
 * Plugin calls are no-ops on web / Electron / VS Code / Android.
 */
export function useNativeLiveActivity(args: UseNativeLiveActivityArgs): void {
  const nativeUiEnabled = useIosNativeUiEnabled();
  const available = nativeUiEnabled && canUseNativeIosLiveActivity();
  const connected = useConfigStore((state) => state.isConnected);
  const sessionId = available ? (args.sessionId ?? '') : '';
  const directory = available ? (args.directory ?? undefined) : undefined;
  const status = useLiveSessionStatus(sessionId);
  const errorAt = useSessionErrorAt(sessionId, directory);
  const permissions = useSessionPermissions(sessionId, directory, { bootstrap: false });
  const questions = useSessionQuestions(sessionId, directory, { bootstrap: false });
  const stateRef = useRef<NativeLiveActivityState>(createInitialNativeLiveActivityState());
  const tokenStateRef = useRef<NativeLiveActivityTokenState>(createInitialNativeLiveActivityTokenState());
  const supportedRef = useRef<boolean | null>(null);
  const epochRef = useRef(0);
  const chainRef = useRef(Promise.resolve());
  const tokenChainRef = useRef(Promise.resolve());
  const pushTokenHandleRef = useRef<PluginListenerHandle | null>(null);

  const hasPendingPermissions = permissions.length > 0;
  const hasPendingQuestions = questions.length > 0;
  const hasSessionError = errorAt !== undefined;
  const statusType = status?.type;

  const observe = useEvent((): NativeLiveActivityObservation => ({
    sessionId: args.sessionId ?? null,
    statusType,
    hasPendingPermissions,
    hasPendingQuestions,
    hasSessionError,
    errorAt,
    now: Date.now(),
    connected,
  }));

  const dispatchTokenAction = useEvent((action: NativeLiveActivityTokenAction): void => {
    tokenChainRef.current = tokenChainRef.current.then(async () => {
      const reduced = reduceNativeLiveActivityToken(tokenStateRef.current, {
        selectedSessionId: args.sessionId ?? null,
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
    dispatchTokenAction({ type: 'pushToken', ...parsed });
  });

  useEffect(() => {
    dispatchTokenAction({ type: available ? 'sync' : 'dispose' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- available/sessionId/connected are the real inputs; dispatchTokenAction is useEvent-stable and must not control this effect.
  }, [available, args.sessionId, connected]);

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
          getCurrentSessionId: () => observe().sessionId,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session/status/connection identity is the real input; observe/handlePushToken/dispatchTokenAction are useEvent-stable and must not control this effect.
  }, [
    available,
    args.sessionId,
    connected,
    statusType,
    hasPendingPermissions,
    hasPendingQuestions,
    hasSessionError,
    errorAt,
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
