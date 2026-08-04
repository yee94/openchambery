import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useUIStore } from '@/stores/useUIStore';
import type { StreamPhase, ToolPopupContent } from '../types';
import AssistantTextPart from './AssistantTextPart';

type PartWithText = Part & { text?: string; content?: string; time?: { start?: number; end?: number } };
type PartWithSession = Part & { sessionID?: string };

interface JustificationBlockProps {
    part: Part;
    messageId: string;
    onContentChange?: (reason?: ContentChangeReason) => void;
    actions?: React.ReactNode;
    streamPhase?: StreamPhase;
    onShowPopup?: (content: ToolPopupContent) => void;
}

const JustificationBlock: React.FC<JustificationBlockProps> = ({
    part,
    messageId,
    onContentChange,
    actions,
    streamPhase,
    onShowPopup,
}) => {
    const chatRenderMode = useUIStore((state) => state.chatRenderMode);
    const partWithText = part as PartWithText;
    const rawText = typeof partWithText.text === 'string' ? partWithText.text : '';
    const contentText = typeof partWithText.content === 'string' ? partWithText.content : '';
    const textContent = contentText.length > rawText.length ? contentText : rawText;
    const time = partWithText.time;
    const sessionID = (part as PartWithSession).sessionID;
    const canBeStreaming = streamPhase === undefined || streamPhase !== 'completed';

    React.useEffect(() => {
        if (textContent.trim().length === 0) return;
        onContentChange?.('structural');
    }, [onContentChange, textContent]);

    // Don't render if there's no text content
    if (!textContent || textContent.trim().length === 0) {
        return null;
    }

    return (
        <div data-message-text-export-root="true">
            <div data-message-text-export-source="true">
                <AssistantTextPart
                    part={part}
                    sessionId={sessionID}
                    messageId={messageId}
                    streamPhase={streamPhase ?? 'streaming'}
                    chatRenderMode={chatRenderMode}
                    hasStreamingHapticLifecycle={canBeStreaming && typeof time?.end !== 'number'}
                    onContentChange={onContentChange}
                    onShowPopup={onShowPopup}
                />
            </div>
            {actions ? (
                <div className="mt-2 mb-1 flex items-center justify-start gap-1.5" data-message-actions="true">
                    <div className="flex items-center gap-1.5" data-message-action-group="true">
                        {actions}
                    </div>
                </div>
            ) : null}
        </div>
    );
};

export default React.memo(JustificationBlock);
