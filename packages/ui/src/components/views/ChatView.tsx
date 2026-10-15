import React from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import { WorkStatusPanel } from '@/components/chat/work-status/WorkStatusPanel';
import { useWorkStatusVisibility, WORK_STATUS_PANEL_WIDTH, WORK_STATUS_SCROLLBAR_LANE } from '@/components/chat/work-status/useWorkStatusVisibility';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { cn } from '@/lib/utils';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const WorkStatusHost: React.FC<{
    sessionId: string | null;
    directory: string | null;
    visible: boolean;
    overlay?: boolean;
    publishVisible?: boolean;
}> = ({ sessionId, directory, visible, overlay = false, publishVisible = false }) => {
    const setWorkStatusPanelVisible = useUIStore((state) => state.setWorkStatusPanelVisible);
    React.useEffect(() => {
        if (!publishVisible) return undefined;
        setWorkStatusPanelVisible(visible);
        return () => setWorkStatusPanelVisible(false);
    }, [publishVisible, setWorkStatusPanelVisible, visible]);
    return (
        <WorkStatusPanel
            overlay={overlay}
            visible={visible}
            sessionId={sessionId}
            directory={directory}
        />
    );
};

type ChatViewProps = {
    readOnly?: boolean;
    active?: boolean;
    selectionOverride?: {
        sessionId: string | null;
        directory: string | null;
        viewKey: string;
    };
};

export const ChatView: React.FC<ChatViewProps> = ({ readOnly = false, active = true, selectionOverride }) => {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
    const isDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
    const isDraftConversation = useSessionUIStore((state) => Boolean(
        state.newSessionDraft?.open && state.newSessionDraft.pendingUserMessage
        && (state.newSessionDraft.draftEstablishing || state.newSessionDraft.draftSubmitting)
    ));
    const effectiveDirectory = useEffectiveDirectory();
    const isMobile = useUIStore((state) => state.isMobile);
    const isExpandedInput = useUIStore((state) => state.isExpandedInput);
    const isVSCode = isVSCodeRuntime();
    const workStatusEnabled = useUIStore((state) => state.workStatusPanelEnabled);
    const workStatusOverlayOpen = useUIStore((state) => state.workStatusOverlayOpen);
    const setWorkStatusPanelFits = useUIStore((state) => state.setWorkStatusPanelFits);
    const errorSessionId = selectionOverride?.sessionId ?? currentSessionId;
    const sessionId = selectionOverride?.sessionId ?? currentSessionId;
    const directory = selectionOverride?.directory ?? currentSessionDirectory ?? effectiveDirectory ?? null;
    const { visible, fits, layoutAllows } = useWorkStatusVisibility({ isMobile, isVSCode, directory });
    const hasConversation = selectionOverride ? Boolean(selectionOverride.sessionId)
        : isDraftOpen ? isDraftConversation : Boolean(sessionId);
    const mountable = active && layoutAllows && !isExpandedInput && hasConversation;
    const showInline = mountable && visible;
    const showOverlay = mountable && workStatusEnabled && !fits && workStatusOverlayOpen;

    React.useEffect(() => {
        setWorkStatusPanelFits(mountable && fits);
        return () => setWorkStatusPanelFits(false);
    }, [fits, mountable, setWorkStatusPanelFits]);

    return (
        <div
            className={cn('relative h-full min-h-0 min-w-0', showInline && 'oc-chat-work-status-inline')}
            style={showInline ? { ['--oc-work-status-reserve' as string]: `${WORK_STATUS_PANEL_WIDTH + WORK_STATUS_SCROLLBAR_LANE}px` } : undefined}
        >
            <div className="absolute inset-0 min-h-0 min-w-0">
                <ChatErrorBoundary sessionId={errorSessionId || undefined}>
                    <ChatContainer readOnly={readOnly} active={active} explicitSession={selectionOverride ? { ...selectionOverride, active } : undefined} />
                </ChatErrorBoundary>
            </div>
            {mountable ? (
                <WorkStatusHost
                    publishVisible
                    visible={showInline}
                    sessionId={sessionId}
                    directory={directory}
                />
            ) : null}
            {mountable && workStatusEnabled && !fits ? (
                <WorkStatusHost
                    overlay
                    visible={showOverlay}
                    sessionId={sessionId}
                    directory={directory}
                />
            ) : null}
        </div>
    );
};
