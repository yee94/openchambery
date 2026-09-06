import React from 'react';

import { useAssistantStatus } from '@/hooks/useAssistantStatus';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { StatusRow } from './StatusRow';
import { useSessionSurface } from './SessionSurfaceContext';

/**
 * Status row wrapper.
 * Uses the dedicated assistant status hook so the row keeps accurate live activity
 * labels while still limiting subscriptions to the active assistant message.
 * Embedded/panel surfaces resolve status from SessionSurfaceContext; primary keeps
 * the global current-session selection.
 */
export const StatusRowContainer: React.FC = React.memo(() => {
    const surface = useSessionSurface();
    const primarySessionId = useSessionUIStore((state) => state.currentSessionId);
    const primarySessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
    const currentSessionId = surface.sessionId ?? primarySessionId;
    const currentSessionDirectory = surface.directory ?? primarySessionDirectory ?? undefined;
    const abortRecordSelector = React.useMemo(() => (
        state: ReturnType<typeof useSessionUIStore.getState>
    ) => {
            if (!currentSessionId) {
                return null;
            }
            return state.sessionAbortFlags?.get(currentSessionId) ?? null;
    }, [currentSessionId]);
    const abortRecord = useSessionUIStore(abortRecordSelector);
    const abortPromptSessionId = useSessionUIStore((state) => state.abortPromptSessionId);
    const abortPromptExpiresAt = useSessionUIStore((state) => state.abortPromptExpiresAt);
    const { working } = useAssistantStatus(currentSessionId, currentSessionDirectory);
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const wasAborted = Boolean(abortRecord && !abortRecord.acknowledged);
    const showAbortPrompt = Boolean(
        currentSessionId
        && abortPromptSessionId === currentSessionId
        && typeof abortPromptExpiresAt === 'number'
        && abortPromptExpiresAt > Date.now(),
    );
    // Keep the WorkingPlaceholder mounted through generic busy (no tool /
    // reasoning / text part yet). First-prompt claim otherwise blanks the slot
    // under the model header while Stop is still armed. Concrete parts replace
    // the generic phrase in place; settled turns drop the row via isWorking.
    const showAssistantStatus = working.isWaitingForPermission
        || Boolean(working.retryInfo)
        || wasAborted
        || working.wasAborted
        || working.isWorking;

    return (
        <StatusRow
            isWorking={working.isWorking}
            statusText={working.statusText}
            isGenericStatus={working.isGenericStatus}
            isWaitingForPermission={working.isWaitingForPermission}
            wasAborted={wasAborted || working.wasAborted}
            abortActive={wasAborted || working.abortActive}
            retryInfo={working.retryInfo}
            turnStartedAt={working.turnStartedAt}
            isTurnSettled={working.isTurnSettled}
            showAbortPrompt={showAbortPrompt}
            showAssistantStatus={showAssistantStatus}
            showTodos={false}
            agentName={currentAgentName}
        />
    );
});

StatusRowContainer.displayName = 'StatusRowContainer';
