import { useEffect, useRef } from 'react';
import { useEvent } from '@reactuses/core';

import {
  canUseNativeIosLiveActivity,
  createInitialNativeLiveActivityState,
  getNativeIosLiveActivityPlugin,
  runNativeLiveActivityStep,
  type NativeLiveActivityObservation,
  type NativeLiveActivityState,
} from '@/lib/native-ios-live-activity';
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
  const available = canUseNativeIosLiveActivity();
  const connected = useConfigStore((state) => state.isConnected);
  const sessionId = available ? (args.sessionId ?? '') : '';
  const directory = available ? (args.directory ?? undefined) : undefined;
  const status = useLiveSessionStatus(sessionId);
  const errorAt = useSessionErrorAt(sessionId, directory);
  const permissions = useSessionPermissions(sessionId, directory, { bootstrap: false });
  const questions = useSessionQuestions(sessionId, directory, { bootstrap: false });
  const stateRef = useRef<NativeLiveActivityState>(createInitialNativeLiveActivityState());
  const supportedRef = useRef<boolean | null>(null);
  const epochRef = useRef(0);
  const chainRef = useRef(Promise.resolve());

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

  useEffect(() => {
    if (!available) return;

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
        if (result.retry) retryCount += 1;
        else retryCount = 0;
        if (result.delayMs != null) {
          timer = setTimeout(() => {
            run();
          }, result.delayMs);
        }
      }).catch(() => undefined);
    };

    run();

    return () => {
      cancelled = true;
      if (epochRef.current === epoch) epochRef.current += 1;
      if (timer !== null) clearTimeout(timer);
    };
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
}
