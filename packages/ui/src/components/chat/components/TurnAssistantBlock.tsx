import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';

interface TurnAssistantBlockProps {
    assistantMessages: ChatMessageEntry[];
    activityExpanded: boolean;
    renderMessage: (message: ChatMessageEntry, activityExpanded: boolean) => React.ReactNode;
}

const TurnAssistantBlock: React.FC<TurnAssistantBlockProps> = ({ assistantMessages, activityExpanded, renderMessage }) => {
    return (
        <div className="relative z-0" data-turn-assistant-activity-expanded={activityExpanded}>
            {assistantMessages.map((message) => renderMessage(message, activityExpanded))}
        </div>
    );
};

export default React.memo(TurnAssistantBlock);
