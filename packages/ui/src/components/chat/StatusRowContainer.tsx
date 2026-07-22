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
    const abortRecord = useSessionUIStore(
        React.useCallback((state) => {
            if (!currentSessionId) {
                return null;
            }
            return state.sessionAbortFlags?.get(currentSessionId) ?? null;
        }, [currentSessionId]),
    );
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

    return (
        <StatusRow
            isWorking={working.isWorking}
            statusText={working.statusText}
            isGenericStatus={working.isGenericStatus}
            isWaitingForPermission={working.isWaitingForPermission}
            wasAborted={wasAborted || working.wasAborted}
            abortActive={wasAborted || working.abortActive}
            retryInfo={working.retryInfo}
            showAbortPrompt={showAbortPrompt}
            showAssistantStatus
            showTodos={false}
            agentName={currentAgentName}
        />
    );
});

StatusRowContainer.displayName = 'StatusRowContainer';
