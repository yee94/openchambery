import React from 'react';

import type { ChatMessageEntry, TurnMessageRecord } from '../lib/turns/types';

interface TurnAssistantBlockProps {
    assistantMessages: ChatMessageEntry[];
    messages: TurnMessageRecord[];
    activityExpanded: boolean;
    renderMessage: (message: ChatMessageEntry, activityExpanded: boolean) => React.ReactNode;
}

const TurnAssistantBlock: React.FC<TurnAssistantBlockProps> = ({ assistantMessages, messages, activityExpanded, renderMessage }) => {
    const rows = React.useMemo(() => {
        // Preserve upstream order without letting notices participate in assistant
        // lifecycle, activity grouping, or sorted-mode assistant visibility.
        const hasNotices = messages.some((record, index) => index > 0 && record.role !== 'assistant');
        if (!hasNotices) return assistantMessages;
        const visible = new Set(assistantMessages.map((message) => message.info.id));
        return messages.flatMap((record, index) => index > 0 && (record.role !== 'assistant' || visible.has(record.messageId)) ? [record.message] : []);
    }, [assistantMessages, messages]);
    return (
        <div className="relative z-0" data-turn-assistant-activity-expanded={activityExpanded}>
            {rows.map((message) => renderMessage(message, activityExpanded))}
        </div>
    );
};

export default React.memo(TurnAssistantBlock);
