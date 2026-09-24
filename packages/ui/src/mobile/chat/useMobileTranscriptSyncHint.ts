import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { useI18n } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionMessageLoadState, useSessionMaterializationStatus } from '@/sync/sync-context';
import {
  isTranscriptAuthorityRefreshInFlight,
  subscribeTranscriptAuthorityRefresh,
} from '@/sync/transcript-authority-refresh-flight';
import {
  isTranscriptResyncInFlight,
  subscribeTranscriptResync,
} from '@/sync/transcript-resync-flight';

export type MobileTranscriptSyncHintKind = 'syncing';

export type MobileTranscriptSyncHintInput = {
  sessionId: string;
  hasRenderableTranscript: boolean;
  loadStatus?: 'loading' | 'ready' | 'error';
  userRefreshInFlight: boolean;
  backgroundResyncInFlight: boolean;
  isConnected: boolean;
  connectionPhase: 'connecting' | 'connected' | 'reconnecting';
};

/**
 * When the chat title should show a WeChat-style sync whisper.
 *
 * Warm prefetch `loading` is ignored: Relay can stick there, and load-older
 * already has its own spinner. Live work that proves the page is chasing the
 * remote state shows even when a transcript is already present: an in-flight
 * user authority refresh, or a background resync flight (reconnect recovery
 * pull, compensation reconcile, observe-time head check). When those clear,
 * the visible transcript has been reconciled against the server. Socket-level
 * `reconnecting` alone stays hidden for warm transcripts — HTTP catch-up can
 * finish while the socket is still backing off. V2 metadata-only rows are not
 * warm: the repository's content materialization status owns that decision,
 * including the idle-before-first-request and metadata-before-parts gaps.
 */
export function resolveMobileTranscriptSyncHint(
  input: MobileTranscriptSyncHintInput,
): MobileTranscriptSyncHintKind | null {
  if (!input.sessionId) return null;
  if (input.userRefreshInFlight) return 'syncing';
  if (input.backgroundResyncInFlight) return 'syncing';
  if (input.hasRenderableTranscript) return null;
  if (!input.isConnected && input.connectionPhase === 'reconnecting') return 'syncing';
  if (input.loadStatus !== 'error') return 'syncing';
  return null;
}

export const SYNC_HINT_SHOW_DELAY_MS = 250;
export const SYNC_HINT_HIDE_GRACE_MS = 1000;

/**
 * Display-level hysteresis for the sync whisper.
 *
 * Foreground resume fires several lifecycle events (visibilitychange,
 * pageshow, system-resume, debounced online) and each can run its own
 * abort → reconnect → recovery/reconcise relay, so the raw in-flight signal
 * legitimately toggles several times in a row. The smoother delays showing
 * (sub-delay blips never render) and grace-extends hiding (relayed flights
 * render as one continuous whisper). The flight registries stay exact;
 * only the painted hint is smoothed.
 */
export function createSyncHintSmoother(
  onChange: (visible: boolean) => void,
  options?: { showDelayMs?: number; hideGraceMs?: number },
) {
  const showDelayMs = options?.showDelayMs ?? SYNC_HINT_SHOW_DELAY_MS;
  const hideGraceMs = options?.hideGraceMs ?? SYNC_HINT_HIDE_GRACE_MS;
  let raw = false;
  let visible = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const apply = () => {
    timer = null;
    if (visible === raw) return;
    visible = raw;
    onChange(visible);
  };

  return {
    setRaw(next: boolean) {
      raw = next;
      if (timer) clearTimeout(timer);
      timer = setTimeout(apply, raw ? showDelayMs : hideGraceMs);
    },
    cancel() {
      raw = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

function useSmoothedSyncHintActive(raw: boolean, scopeKey: string): boolean {
  const scope = useMemo(() => ({ key: scopeKey }), [scopeKey]);
  const [state, setState] = useState({ scope, visible: false });
  const smoother = useMemo(() => createSyncHintSmoother(
    (visible) => setState({ scope, visible }),
  ), [scope]);

  useEffect(() => {
    smoother.setRaw(raw);
    return () => smoother.cancel();
  }, [raw, smoother]);

  return state.scope === scope && state.visible;
}

export function useMobileTranscriptSyncHint(
  sessionId: string,
  directory?: string,
): string | null {
  const { t } = useI18n();
  const load = useSessionMessageLoadState(sessionId, directory);
  const { renderable: hasRenderableTranscript } = useSessionMaterializationStatus(sessionId, directory);
  const isConnected = useConfigStore((state) => state.isConnected);
  const connectionPhase = useConfigStore((state) => state.connectionPhase);
  const userRefreshInFlight = useSyncExternalStore(
    subscribeTranscriptAuthorityRefresh,
    () => isTranscriptAuthorityRefreshInFlight(sessionId, directory),
    () => false,
  );
  const backgroundResyncInFlight = useSyncExternalStore(
    subscribeTranscriptResync,
    () => isTranscriptResyncInFlight(sessionId, directory),
    () => false,
  );

  const kind = resolveMobileTranscriptSyncHint({
    sessionId,
    hasRenderableTranscript,
    loadStatus: load?.status,
    userRefreshInFlight,
    backgroundResyncInFlight,
    isConnected,
    connectionPhase,
  });
  const visible = useSmoothedSyncHintActive(kind === 'syncing', JSON.stringify([directory, sessionId]));
  return visible ? t('mobile.chat.syncingMessages') : null;
}
