import { useEffect, useState } from 'react';

import { useConnection } from '@/context/ConnectionContext';
import type { ActiveRuntime } from '@/lib/connectionController';
import {
  dispatchHomeAttentionEvent,
  dispatchSetViewingSession,
  getHomeAttentionSnapshot,
  resetHomeAttentionStore,
  subscribeHomeAttention,
  type HomeAttentionSnapshot,
} from '@/lib/homeAttention';
import { subscribeGlobalEvents } from '@/lib/globalEventHub';

let bridgeRefCount = 0;
let bridgeStop: (() => void) | null = null;

/**
 * Ensures one global-event → homeAttention bridge while any consumer wants live updates.
 */
function acquireHomeAttentionBridge(runtime: ActiveRuntime) {
  bridgeRefCount += 1;
  if (bridgeRefCount === 1) {
    bridgeStop = subscribeGlobalEvents(runtime, (event) => {
      dispatchHomeAttentionEvent(event);
    });
  }
  return () => {
    bridgeRefCount = Math.max(0, bridgeRefCount - 1);
    if (bridgeRefCount === 0 && bridgeStop) {
      bridgeStop();
      bridgeStop = null;
    }
  };
}

/**
 * Live home unread + running. Shares the global event hub with Chat.
 * Prefer mounting once from root layout while connected; additional callers only subscribe.
 */
export function useHomeAttention(options?: {
  enabled?: boolean;
  viewingSessionId?: string | null;
  /** When false, only subscribe to store (root layout owns the bridge). Default true. */
  bridge?: boolean;
}): HomeAttentionSnapshot {
  const { state } = useConnection();
  const active = state.active;
  const enabled = options?.enabled ?? state.phase === 'connected';
  const bridge = options?.bridge ?? true;
  const [snapshot, setSnapshot] = useState<HomeAttentionSnapshot>(() => getHomeAttentionSnapshot());

  useEffect(() => subscribeHomeAttention(setSnapshot), []);

  useEffect(() => {
    if (options?.viewingSessionId === undefined) return;
    dispatchSetViewingSession(options.viewingSessionId);
  }, [options?.viewingSessionId]);

  useEffect(() => {
    if (!enabled || !active) {
      if (bridge) resetHomeAttentionStore();
      return;
    }
    if (!bridge) return;
    return acquireHomeAttentionBridge(active);
  }, [active, bridge, enabled]);

  return snapshot;
}
