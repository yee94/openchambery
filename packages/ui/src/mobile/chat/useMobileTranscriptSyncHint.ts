import { useSyncExternalStore } from 'react';

import { useI18n } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionMessageLoadState, useSessionMessagesResolved } from '@/sync/sync-context';
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
  hasTranscript: boolean;
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
 * finish while the socket is still backing off. Cold first paint and
 * reconnect-before-any-messages keep their original signals.
 */
export function resolveMobileTranscriptSyncHint(
  input: MobileTranscriptSyncHintInput,
): MobileTranscriptSyncHintKind | null {
  if (!input.sessionId) return null;
  if (input.userRefreshInFlight) return 'syncing';
  if (input.backgroundResyncInFlight) return 'syncing';
  if (input.hasTranscript) return null;
  if (!input.isConnected && input.connectionPhase === 'reconnecting') return 'syncing';
  if (input.loadStatus === 'loading') return 'syncing';
  return null;
}

export function useMobileTranscriptSyncHint(
  sessionId: string,
  directory?: string,
): string | null {
  const { t } = useI18n();
  const load = useSessionMessageLoadState(sessionId, directory);
  const hasTranscript = useSessionMessagesResolved(sessionId, directory);
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
    hasTranscript,
    loadStatus: load?.status,
    userRefreshInFlight,
    backgroundResyncInFlight,
    isConnected,
    connectionPhase,
  });
  return kind === 'syncing' ? t('mobile.chat.syncingMessages') : null;
}
