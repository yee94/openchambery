import React from 'react';
import { useEvent, useInterval } from '@reactuses/core';

import { useConfigStore } from '@/stores/useConfigStore';

const MAX_ATTEMPTS = 15;
const INTERVAL_MS = 2000;

/**
 * Polls force-refresh of empty Provider/Agent catalogs after a successful empty
 * warm load (TanStack Query staleTime: Infinity). Shared across web, mobile, and
 * mini-chat so recovery has one attempt budget, one immediate kick, and one
 * interval owner. Store-level single-flight keeps concurrent force-refreshes merged.
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
  const [exhausted, setExhausted] = React.useState(false);
  const source = options.source;

  const runRecovery = useEvent(async () => {
    if (!shouldRecover || inFlightRef.current) return;
    if (attemptsRef.current >= MAX_ATTEMPTS) {
      setExhausted(true);
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
    setExhausted(false);
    if (!shouldRecover) return;
    // Immediate kick uses the same attempt budget and single-flight entry as the interval.
    void runRecovery();
    // runRecovery is useEvent-stable; shouldRecover/activeDirectoryKey reopen a fresh budget.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runRecovery is useEvent-stable and must not control this effect.
  }, [shouldRecover, activeDirectoryKey]);

  useInterval(runRecovery, shouldRecover && !exhausted ? INTERVAL_MS : null);
};
