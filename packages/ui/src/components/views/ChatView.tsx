import React from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import { useSessionUIStore } from '@/sync/session-ui-store';

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
    const errorSessionId = selectionOverride?.sessionId ?? currentSessionId;

    return (
        <ChatErrorBoundary sessionId={errorSessionId || undefined}>
            <ChatContainer readOnly={readOnly} active={active} explicitSession={selectionOverride ? { ...selectionOverride, active } : undefined} />
        </ChatErrorBoundary>
    );
};
