import {
  INITIAL_TRANSCRIPT_STALL_STATE,
  type TranscriptStallState,
} from './transcriptStallWatchdog';

/**
 * Whether the transcript stall poll interval should be armed.
 * Inactive surfaces (phone predecessor underlay, hidden retained views) must
 * not run the 2s timer — only the active chat surface repairs frozen tails.
 */
export function shouldArmTranscriptStallWatchdog(input: {
  active: boolean;
  sessionId: string | null | undefined;
  sessionKey: string | null | undefined;
  sessionIsWorking: boolean;
}): boolean {
  return Boolean(
    input.active
    && input.sessionId
    && input.sessionKey
    && input.sessionIsWorking,
  );
}

/**
 * Reset stall history when the surface leaves the armed set so a later
 * activate does not inherit a stale threshold clock and immediately refresh.
 */
export function resetTranscriptStallStateForInactive(
  state: TranscriptStallState,
): TranscriptStallState {
  if (state === INITIAL_TRANSCRIPT_STALL_STATE) return state;
  return INITIAL_TRANSCRIPT_STALL_STATE;
}
