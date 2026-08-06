import React from 'react';
import {
  useDirectoryStore,
  useSession,
  useSessionStatus,
  useSyncDirectory,
} from '@/sync/sync-context';
import { useTranscriptLastMessageSnapshot } from '@/sync/transcript-repository-observers';
import { getSessionAssist, type SessionAssistPayload } from '@/lib/sessionAssistMetadata';
import { useUIStore } from '@/stores/useUIStore';

// How long the chat must sit untouched before the recap becomes visible.
export const RECAP_VISIBILITY_DELAY_MS = 60 * 1000;

/** Narrow last-message snapshot via TranscriptRepository (Ticket 02 remediation). */
function useLastMessageSnapshot(sessionId: string, directory?: string) {
  const syncDirectory = useSyncDirectory();
  const targetDirectory = directory || syncDirectory;
  const store = useDirectoryStore(targetDirectory);
  return useTranscriptLastMessageSnapshot(sessionId, targetDirectory, store);
}

export interface SessionAssistState {
  /** Valid (fresh) assist payload, or null. */
  assist: SessionAssistPayload | null;
  /** Recap text, only when the 1-minute quiet window has elapsed. */
  visibleRecap: string | null;
}

export function useSessionAssistState(sessionId: string, directory?: string): SessionAssistState {
  const session = useSession(sessionId, directory);
  const status = useSessionStatus(sessionId, directory);
  const lastMessage = useLastMessageSnapshot(sessionId, directory);
  const sessionRecapEnabled = useUIStore((state) => state.sessionRecapEnabled);

  const isIdle = !status || status.type === 'idle';
  const payload = getSessionAssist(session);

  // Fresh = the payload's target message is still the session's last message.
  const assist = payload
    && lastMessage
    && lastMessage.role === 'assistant'
    && lastMessage.id === payload.forMessageID
    && isIdle
    ? payload
    : null;

  // Recap waits out the quiet window; re-render once when the boundary passes.
  const lastTimestamp = lastMessage?.timestamp ?? 0;
  const [, forceTick] = React.useReducer((tick: number) => tick + 1, 0);
  const quietElapsed = assist ? Date.now() - lastTimestamp >= RECAP_VISIBILITY_DELAY_MS : false;

  React.useEffect(() => {
    if (!assist || quietElapsed || !lastTimestamp) return undefined;
    const remaining = RECAP_VISIBILITY_DELAY_MS - (Date.now() - lastTimestamp);
    if (remaining <= 0) return undefined;
    const timer = setTimeout(forceTick, remaining + 250);
    return () => clearTimeout(timer);
  }, [assist, quietElapsed, lastTimestamp]);

  return {
    assist,
    visibleRecap: sessionRecapEnabled && assist && assist.recap && quietElapsed ? assist.recap : null,
  };
}
