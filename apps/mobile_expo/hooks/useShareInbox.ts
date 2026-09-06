import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import {
  ackShare,
  listPendingShares,
  type ShareEnvelope,
} from '@/lib/systemShell/share';

/**
 * Polls App Group / Android share inbox (Cap listPending + shareReceived recovery).
 * Share Extension target itself is device-gated residual; inbox consumption is code-landed.
 */
export function useShareInbox(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const [pending, setPending] = useState<ShareEnvelope[]>([]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const envelopes = await listPendingShares();
      setPending(envelopes.filter((e) => !e.consumedAt));
    } catch {
      setPending([]);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const acknowledge = useCallback(
    async (operationID: string) => {
      await ackShare(operationID);
      await refresh();
    },
    [refresh],
  );

  return { pending, refresh, acknowledge };
}
