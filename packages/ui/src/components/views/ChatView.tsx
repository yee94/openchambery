import React from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import { WorkStatusPanel } from '@/components/chat/work-status/WorkStatusPanel';
import { useWorkStatusVisibility } from '@/components/chat/work-status/useWorkStatusVisibility';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionMessages } from '@/sync/sync-context';
import { useSessionUIStore } from '@/sync/session-ui-store';

const WorkStatusHost: React.FC<{
    sessionId: string | null;
    directory: string | null;
    visible: boolean;
    overlay?: boolean;
    publishVisible?: boolean;
}> = ({ sessionId, directory, visible, overlay = false, publishVisible = false }) => {
    const transcript = useSessionMessages(sessionId ?? '', directory ?? undefined);
    const setWorkStatusPanelVisible = useUIStore((state) => state.setWorkStatusPanelVisible);
    const hasConversation = Boolean(sessionId) && transcript.length > 0;
    React.useEffect(() => {
        if (!publishVisible) return undefined;
        setWorkStatusPanelVisible(visible && hasConversation);
        return () => setWorkStatusPanelVisible(false);
    }, [hasConversation, publishVisible, setWorkStatusPanelVisible, visible]);
    if (!hasConversation) return null;
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
    const { rowRef, visible, fits, layoutAllows } = useWorkStatusVisibility({ isMobile, isVSCode, directory });
    const mountable = active && layoutAllows && !isExpandedInput && (Boolean(selectionOverride) || !isDraftOpen) && Boolean(sessionId);
    const showInline = mountable && visible;
    const showOverlay = mountable && workStatusEnabled && !fits && workStatusOverlayOpen;

    React.useEffect(() => {
        setWorkStatusPanelFits(mountable && fits);
        return () => setWorkStatusPanelFits(false);
    }, [fits, mountable, setWorkStatusPanelFits]);

    return (
        <div ref={rowRef} className="relative flex h-full min-h-0 min-w-0">
            <div className="min-h-0 min-w-0 flex-1">
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
