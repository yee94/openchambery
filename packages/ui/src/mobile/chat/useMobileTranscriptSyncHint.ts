import { useSyncExternalStore } from 'react';

import { useI18n } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionMessageLoadState, useSessionMessagesResolved } from '@/sync/sync-context';
import {
  isTranscriptAuthorityRefreshInFlight,
  subscribeTranscriptAuthorityRefresh,
} from '@/sync/transcript-authority-refresh-flight';

export type MobileTranscriptSyncHintKind = 'syncing';

export type MobileTranscriptSyncHintInput = {
  sessionId: string;
  hasTranscript: boolean;
  loadStatus?: 'loading' | 'ready' | 'error';
  userRefreshInFlight: boolean;
  isConnected: boolean;
  connectionPhase: 'connecting' | 'connected' | 'reconnecting';
};

/**
 * When the chat title should show a WeChat-style sync whisper.
 *
 * Warm prefetch `loading` is ignored: Relay can stick there, and load-older
 * already has its own spinner. Once this session already has a transcript,
 * reconnecting must not keep the whisper — HTTP refresh can finish while the
 * socket is still catching up. Cold first paint, in-flight user refresh, and
 * reconnect-before-any-messages are the only live-work signals.
 */
export function resolveMobileTranscriptSyncHint(
  input: MobileTranscriptSyncHintInput,
): MobileTranscriptSyncHintKind | null {
  if (!input.sessionId) return null;
  if (input.userRefreshInFlight) return 'syncing';
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

  const kind = resolveMobileTranscriptSyncHint({
    sessionId,
    hasTranscript,
    loadStatus: load?.status,
    userRefreshInFlight,
    isConnected,
    connectionPhase,
  });
  return kind === 'syncing' ? t('mobile.chat.syncingMessages') : null;
}
