import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import type { StreamPhase, ToolPopupContent } from '../types';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import { resolveAssistantDisplayText, shouldRenderAssistantText } from './assistantTextVisibility';
import { streamPerfCount, streamPerfObserve } from '@/stores/utils/streamDebug';
import { GeneratedJsonResultCard } from './GeneratedJsonResultCard';
import { parseGeneratedJsonResult } from './generatedJsonResult';
import {
    emitStreamingHapticEvent,
    evaluateVisiblePartHaptic,
    hasStreamingHapticSubscribers,
    type VisiblePartHapticState,
} from '@/sync/streaming-haptic-events';

type PartWithText = Part & { text?: string; content?: string; value?: string; time?: { start?: number; end?: number } };

interface AssistantTextPartProps {
    part: Part;
    sessionId?: string;
    messageId: string;
    streamPhase: StreamPhase;
    chatRenderMode?: 'sorted' | 'live';
    /**
     * Sorted mode normally disables body streaming. When the parent has already
     * classified this part as the live final-conclusion body, allow paced
     * streaming for this segment only.
     */
    allowSortedFinalStreaming?: boolean;
    hasStreamingHapticLifecycle?: boolean;
    onContentChange?: (reason?: ContentChangeReason, messageId?: string) => void;
    onShowPopup?: (content: ToolPopupContent) => void;
}

const AssistantTextPart: React.FC<AssistantTextPartProps> = ({
    part,
    sessionId,
    messageId,
    streamPhase,
    chatRenderMode = 'live',
    allowSortedFinalStreaming = false,
    hasStreamingHapticLifecycle = false,
    onShowPopup,
}) => {
    // Use part directly from props — parent provides the latest version from the store.
    // No store subscription here to avoid re-render cascade from unrelated delta events.
    const partWithText = part as PartWithText;
    const rawText = typeof partWithText.text === 'string' ? partWithText.text : '';
    const contentText = typeof partWithText.content === 'string' ? partWithText.content : '';
    const valueText = typeof partWithText.value === 'string' ? partWithText.value : '';
    const textContent = [rawText, contentText, valueText].reduce((best, candidate) => {
        return candidate.length > best.length ? candidate : best;
    }, '');
    const isStreamingPhase = streamPhase === 'streaming';
    const isCooldownPhase = streamPhase === 'cooldown';
    const allowStreaming = chatRenderMode === 'live' || allowSortedFinalStreaming;
    const isStreaming = allowStreaming && (isStreamingPhase || isCooldownPhase);

    streamPerfCount('ui.assistant_text_part.render');
    if (isStreaming) {
        streamPerfCount('ui.assistant_text_part.render.streaming');
    }

    const throttledTextContent = useStreamingTextThrottle({
        text: textContent,
        isStreaming,
        identityKey: `${messageId}:${part.id ?? 'text'}`,
    });

    const displayTextContent = resolveAssistantDisplayText({
        textContent,
        throttledTextContent,
        isStreaming,
    });
    const hapticIdentity = `${messageId}:${part.id ?? 'text'}`;
    const hapticStateRef = React.useRef<VisiblePartHapticState | null>(null);

    React.useEffect(() => {
        if (!hasStreamingHapticSubscribers()) return;
        const isHapticPart = part.type === 'text' || part.type === 'reasoning';
        const decision = evaluateVisiblePartHaptic(hapticStateRef.current, {
            identity: hapticIdentity,
            content: displayTextContent,
            isActive: hasStreamingHapticLifecycle && isHapticPart,
            mode: part.type === 'reasoning' ? 'appearance' : 'changes',
        });
        hapticStateRef.current = decision.nextState;

        if (!decision.shouldEmit || !sessionId) return;
        emitStreamingHapticEvent({
            sessionID: sessionId,
            messageID: messageId,
            partID: part.id,
            kind: part.type === 'reasoning' ? 'thinking' : 'text',
        });
    }, [displayTextContent, hapticIdentity, hasStreamingHapticLifecycle, messageId, part.id, part.type, sessionId]);

    streamPerfObserve('ui.assistant_text_part.display_len', displayTextContent.length);

    const time = partWithText.time;
    const isFinalized = Boolean(time && typeof time.end !== 'undefined');

    const isRenderableTextPart = part.type === 'text' || part.type === 'reasoning';
    if (!isRenderableTextPart) {
        return null;
    }

    if (!shouldRenderAssistantText({
        displayTextContent,
        isFinalized,
    })) {
        return null;
    }

    const generatedResult = !isStreaming && isFinalized ? parseGeneratedJsonResult(displayTextContent) : null;
    if (generatedResult) {
        return (
            <div
                className={`group/assistant-text relative break-words ${chatRenderMode === 'live' ? 'my-1' : ''}`}
                key={part.id || `${messageId}-text`}
            >
                <GeneratedJsonResultCard result={generatedResult} />
            </div>
        );
    }

    return (
        <div
            className={`group/assistant-text relative break-words ${chatRenderMode === 'live' ? 'my-1' : ''}`}
            key={part.id || `${messageId}-text`}
        >
            <MarkdownRenderer
                content={displayTextContent}
                part={part}
                messageId={messageId}
                isAnimated={false}
                isStreaming={isStreaming}
                disableStreamAnimation={chatRenderMode === 'sorted' && !allowSortedFinalStreaming}
                variant={part.type === 'reasoning' ? 'reasoning' : 'assistant'}
                enableFileReferences={isFinalized}
                onShowPopup={onShowPopup}
            />
        </div>
    );
};

export default React.memo(AssistantTextPart);
