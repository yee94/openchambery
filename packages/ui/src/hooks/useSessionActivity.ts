import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionStatus, useSessionMessages, useSessionPermissions, useSessionQuestions, useSessionStatusObservedAt, useSessionStatusSnapshotAt } from '@/sync/sync-context';

// Mirrors OpenCode SessionStatus: busy|retry|idle.
type SessionActivityPhase = 'idle' | 'busy' | 'retry';

export interface SessionActivityResult {
  phase: SessionActivityPhase;
  isWorking: boolean;
  isBusy: boolean;
  isCooldown: boolean;
}

const IDLE_RESULT: SessionActivityResult = {
  phase: 'idle',
  isWorking: false,
  isBusy: false,
  isCooldown: false,
};

type ActivityMessage = {
  role?: string;
  time?: { created?: number; completed?: number };
};

/**
 * Pending-assistant isWorking fallback is warm-cache only.
 * During cold-start assemble (empty → slim → streaming) no assistant has
 * `time.completed` yet; enabling the fallback there invents busy from message
 * shape alone while status/message SSE still interleave → StatusRow flicker.
 * Once any assistant has completed, the transcript is warm and the trailing
 * incomplete assistant is a legitimate settle-gap signal.
 */
export const resolvePendingAssistantWorkingFallback = (input: {
  messages: readonly ActivityMessage[];
  hasPendingAssistant: boolean;
}): boolean => {
  if (!input.hasPendingAssistant) return false;
  const hasCompletedAssistant = input.messages.some(
    (message) => (
      message.role === 'assistant'
      && typeof message.time?.completed === 'number'
    ),
  );
  return hasCompletedAssistant;
};

/**
 * Determines if a session is actively working.
 * Checks session_status and, only when status is missing, falls back to the
 * trailing assistant message when its completion update has not landed yet.
 * Returns idle when permissions or questions are pending (the permission /
 * question indicator takes priority, and the send button must stay available so
 * the user can supersede the prompt with a new message).
 */
export function useSessionActivity(sessionId: string | null | undefined, directory?: string): SessionActivityResult {
  const status = useSessionStatus(sessionId ?? '', directory);
  const statusObservedAt = useSessionStatusObservedAt(sessionId ?? '', directory);
  const messages = useSessionMessages(sessionId ?? '', directory);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const questions = useSessionQuestions(sessionId ?? '', directory);
  const statusSnapshotAt = useSessionStatusSnapshotAt(directory);

  return React.useMemo<SessionActivityResult>(() => {
    if (!sessionId) return IDLE_RESULT;

    // Permissions or questions pending → idle (the blocking indicator takes
    // priority and the send button must remain a send, not a stop).
    if (permissions.length > 0 || questions.length > 0) return IDLE_RESULT;

    const phase: SessionActivityPhase = (status?.type ?? 'idle') as SessionActivityPhase;

    // Only trust the trailing assistant message as a transient fallback while
    // waiting for session.status/message.updated to settle — and only once the
    // transcript is warm (see resolvePendingAssistantWorkingFallback).
    const lastMessage = messages[messages.length - 1];
    const hasPendingAssistant = Boolean(
      lastMessage
      && lastMessage.role === 'assistant'
      && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== 'number',
    );
    const pendingAssistantFallback = resolvePendingAssistantWorkingFallback({
      messages: messages as readonly ActivityMessage[],
      hasPendingAssistant,
    });
    const pendingAssistantStartedAt = (lastMessage as { time?: { created?: number } } | undefined)?.time?.created;
    const pendingAssistantCoveredBySnapshot = Boolean(
      pendingAssistantFallback
      && typeof statusSnapshotAt === 'number'
      && typeof pendingAssistantStartedAt === 'number'
      && pendingAssistantStartedAt <= statusSnapshotAt,
    );

    const hasAuthoritativeStatus = status !== undefined;
    const statusWorking = hasAuthoritativeStatus && phase !== 'idle';
    const isWorking = statusWorking || (pendingAssistantFallback && !pendingAssistantCoveredBySnapshot);

    const idleCoversPendingAssistant = hasAuthoritativeStatus
      && !statusWorking
      && typeof statusObservedAt === 'number'
      && typeof pendingAssistantStartedAt === 'number'
      && pendingAssistantStartedAt <= statusObservedAt;
    if (hasAuthoritativeStatus && !statusWorking && (!pendingAssistantFallback || idleCoversPendingAssistant)) {
      return IDLE_RESULT;
    }

    if (!isWorking) return IDLE_RESULT;

    return {
      phase: statusWorking ? phase : 'busy',
      isWorking: true,
      isBusy: phase === 'busy' || (!statusWorking && pendingAssistantFallback),
      isCooldown: false,
    };
  }, [sessionId, status, statusObservedAt, messages, permissions, questions, statusSnapshotAt]);
}

export function useCurrentSessionActivity(): SessionActivityResult {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  return useSessionActivity(currentSessionId, currentSessionDirectory ?? undefined);
}
