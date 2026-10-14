import React from 'react';
import { useEvent, useInterval } from '@reactuses/core';

import { useConfigStore } from '@/stores/useConfigStore';

const MAX_ATTEMPTS = 15;
const INTERVAL_MS = 2000;
// Fast retries cover a short plugin-activation race. A relay connect can keep
// locations booting for minutes; after the fast budget, keep a slow poll so an
// empty model list still fills in once OpenCode finishes activating.
const SLOW_MAX_ATTEMPTS = 40;
const SLOW_INTERVAL_MS = 20000;

/**
 * Polls force-refresh of empty Provider/Agent catalogs after a successful empty
 * warm load. Empty catalogs use staleTime 0 so ordinary ensure refetches; this
 * poll still force-refreshes store-empty catalogs after init swallows errors.
 * Shared across web, mobile, and mini-chat so recovery has one attempt budget,
 * one immediate kick, and one interval owner. After 15 fast attempts it slows to
 * 20s for up to 40 more, so a relay connect that is still activating plugins does
 * not leave the model list empty. Store-level single-flight keeps concurrent
 * force-refreshes merged.
 */
export const useStartupCatalogRecovery = (options: {
  enabled: boolean;
  source: string;
}): void => {
  const isConnected = useConfigStore((state) => state.isConnected);
  const providersCount = useConfigStore((state) => state.providers.length);
  const agentsCount = useConfigStore((state) => state.agents.length);
  const activeDirectoryKey = useConfigStore((state) => state.activeDirectoryKey);
  const refreshMissingCatalogs = useConfigStore((state) => state.refreshMissingCatalogs);

  const shouldRecover = options.enabled
    && isConnected
    && (providersCount === 0 || agentsCount === 0);

  const attemptsRef = React.useRef(0);
  const inFlightRef = React.useRef(false);
  const [phase, setPhase] = React.useState<'fast' | 'slow' | 'done'>('fast');
  const source = options.source;

  const runRecovery = useEvent(async () => {
    if (!shouldRecover || inFlightRef.current || phase === 'done') return;
    const limit = phase === 'fast' ? MAX_ATTEMPTS : SLOW_MAX_ATTEMPTS;
    if (attemptsRef.current >= limit) {
      if (phase === 'fast') {
        attemptsRef.current = 0;
        setPhase('slow');
        return;
      }
      setPhase('done');
      return;
    }
    const state = useConfigStore.getState();
    if (state.providers.length > 0 && state.agents.length > 0) return;
    inFlightRef.current = true;
    attemptsRef.current += 1;
    try {
      await refreshMissingCatalogs({ source });
    } catch {
      // Bound interval retries remain the recovery path.
    } finally {
      inFlightRef.current = false;
    }
  });

  React.useEffect(() => {
    attemptsRef.current = 0;
    inFlightRef.current = false;
    setPhase('fast');
    if (!shouldRecover) return;
    // Immediate kick uses the same attempt budget and single-flight entry as the interval.
    void runRecovery();
    // runRecovery is useEvent-stable; shouldRecover/activeDirectoryKey reopen a fresh budget.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runRecovery is useEvent-stable and must not control this effect.
  }, [shouldRecover, activeDirectoryKey]);

  const intervalMs = !shouldRecover || phase === 'done'
    ? null
    : phase === 'slow' ? SLOW_INTERVAL_MS : INTERVAL_MS;
  useInterval(runRecovery, intervalMs);
};
