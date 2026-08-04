import React from 'react';

import type { ChatMessageEntry, TurnRecord } from '../lib/turns/types';
import { useUIStore } from '@/stores/useUIStore';
import TurnActivity from './TurnActivity';
import TurnAssistantBlock from './TurnAssistantBlock';

const EMPTY_EXPANDED_TOOLS = new Set<string>();
const ignoreCompactionStatusToggle = () => {};
const ignoreCompactionToolToggle = () => {};
const ignoreCompactionPopup = () => {};

interface TurnItemProps {
    turn: TurnRecord;
    activityExpanded: boolean;
    showCompactionStatus: boolean;
    stickyUserHeader?: boolean;
    renderMessage: (message: ChatMessageEntry, activityExpanded: boolean) => React.ReactNode;
}

const TurnItem: React.FC<TurnItemProps> = ({ turn, activityExpanded, showCompactionStatus, stickyUserHeader = true, renderMessage }) => {
    const isMobile = useUIStore((state) => state.isMobile);
    const userMessageCreatedAt = (turn.userMessage.info.time as { created?: number } | undefined)?.created;

    return (
        <section
            className="relative w-full"
            id={`turn-${turn.turnId}`}
            data-turn-id={turn.turnId}
            data-turn-activity-expanded={activityExpanded}
            data-scroll-spy-id={turn.turnId}
        >
            {stickyUserHeader ? (
                <div className="sticky top-0 z-20 relative bg-[var(--surface-background)] [overflow-anchor:none]">
                    <div className="relative z-10">
                        {renderMessage(turn.userMessage, activityExpanded)}
                    </div>
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 top-full z-0 h-4 bg-gradient-to-b from-[var(--surface-background)] to-transparent sm:h-8"
                    />
                </div>
            ) : (
                renderMessage(turn.userMessage, activityExpanded)
            )}

            {showCompactionStatus ? (
                <div className={`group w-full ${isMobile ? 'pt-4' : 'pt-6'} ${turn.assistantMessages.length === 0 ? 'pb-8' : 'pb-0'}`}>
                    <div className="chat-message-column relative">
                        <TurnActivity
                            parts={[]}
                            isExpanded={activityExpanded}
                            completionDisposition={turn.completionDisposition}
                            activityPresentationKind="compaction"
                            durationMs={turn.durationMs}
                            startedAt={typeof userMessageCreatedAt === 'number' ? userMessageCreatedAt : undefined}
                            onToggle={ignoreCompactionStatusToggle}
                            isMobile={isMobile}
                            expandedTools={EMPTY_EXPANDED_TOOLS}
                            onToggleTool={ignoreCompactionToolToggle}
                            onShowPopup={ignoreCompactionPopup}
                            streamPhase={turn.completionDisposition === 'active' ? 'streaming' : 'completed'}
                            showHeader={true}
                            statusOnly={true}
                        />
                    </div>
                </div>
            ) : null}

            <TurnAssistantBlock
                assistantMessages={turn.assistantMessages}
                activityExpanded={activityExpanded}
                renderMessage={renderMessage}
            />
        </section>
    );
};

export default React.memo(TurnItem);
