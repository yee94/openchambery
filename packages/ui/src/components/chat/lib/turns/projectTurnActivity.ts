import type {
    ChatMessageEntry,
    TurnActivityGroup,
    TurnActivityRecord,
    TurnCompletionDisposition,
    TurnPartRecord,
} from './types';

const getPartEndTime = (part: unknown): number | undefined => {
    const stateEnd = (part as { state?: { time?: { end?: unknown } } }).state?.time?.end;
    if (typeof stateEnd === 'number') {
        return stateEnd;
    }
    const timeEnd = (part as { time?: { end?: unknown } }).time?.end;
    return typeof timeEnd === 'number' ? timeEnd : undefined;
};

const getPartText = (part: unknown): string | undefined => {
    const text = (part as { text?: unknown }).text;
    if (typeof text === 'string' && text.trim().length > 0) {
        return text;
    }
    const content = (part as { content?: unknown }).content;
    if (typeof content === 'string' && content.trim().length > 0) {
        return content;
    }
    return undefined;
};

const getMessageFinish = (message: ChatMessageEntry): string | undefined => {
    const finish = (message.info as { finish?: unknown }).finish;
    return typeof finish === 'string' ? finish : undefined;
};

const buildTurnPartRecord = (
    turnId: string,
    messageId: string,
    part: ChatMessageEntry['parts'][number],
    partIndex: number,
): TurnPartRecord => {
    return {
        id: part.id ?? `${messageId}-part-${partIndex}-${part.type}`,
        turnId,
        messageId,
        part,
        partIndex,
        endedAt: getPartEndTime(part),
    };
};

interface ProjectActivityInput {
    turnId: string;
    assistantMessages: ChatMessageEntry[];
    summarySourceMessageId?: string;
    summarySourcePartId?: string;
    completionDisposition?: TurnCompletionDisposition;
    showTextJustificationActivity: boolean;
}

interface ProjectActivityResult {
    activityParts: TurnActivityRecord[];
    activitySegments: TurnActivityGroup[];
    hasTools: boolean;
    hasReasoning: boolean;
}

export const projectTurnActivity = (input: ProjectActivityInput): ProjectActivityResult => {
    const activityParts: TurnActivityRecord[] = [];
    let hasTools = false;
    let hasReasoning = false;

    input.assistantMessages.forEach((message) => {
        message.parts.forEach((part) => {
            if (part.type === 'tool') {
                hasTools = true;
                return;
            }

            if (part.type === 'reasoning' && getPartText(part)) {
                hasReasoning = true;
            }
        });
    });

    // Canonical stop summary: only when disposition is normal and summary source is a stop text.
    // Avoid treating interrupt/fallback text as a normal summary that would fold other text away.
    const hasCanonicalStopSummary = input.completionDisposition === 'normal'
        && Boolean(input.summarySourceMessageId)
        && Boolean(input.summarySourcePartId)
        && input.assistantMessages.some((message) => (
            message.info.id === input.summarySourceMessageId
            && getMessageFinish(message) === 'stop'
        ));

    input.assistantMessages.forEach((message) => {
        const finish = getMessageFinish(message);
        const messageHasTool = message.parts.some((part) => part.type === 'tool');

        message.parts.forEach((part, partIndex) => {
            const isTool = part.type === 'tool';

            const text = part.type === 'reasoning' || part.type === 'text'
                ? getPartText(part)
                : undefined;
            const partId = part.id ?? `${message.info.id}-part-${partIndex}-${part.type}`;

            const isConfirmedSummaryText = part.type === 'text'
                && typeof text === 'string'
                && finish === 'stop'
                && input.summarySourceMessageId === message.info.id
                && input.summarySourcePartId === partId;

            let kind: TurnActivityRecord['kind'] | null = null;
            if (isTool) {
                kind = 'tool';
            } else if (part.type === 'reasoning') {
                if (text) {
                    kind = 'reasoning';
                }
            } else if (
                input.showTextJustificationActivity
                && part.type === 'text'
                && text
                && !isConfirmedSummaryText
                && (
                    hasCanonicalStopSummary
                    || messageHasTool
                    || (typeof finish === 'string' && finish !== 'stop')
                )
            ) {
                kind = 'justification';
            }

            if (!kind) {
                return;
            }

            activityParts.push({
                ...buildTurnPartRecord(input.turnId, message.info.id, part, partIndex),
                kind,
            });
        });
    });

    const activitySegments: TurnActivityGroup[] = [];

    if (activityParts.length > 0) {
        const messageIdsWithActivity = new Set(activityParts.map((activity) => activity.messageId));
        let anchorMessageId: string | undefined;
        for (const message of input.assistantMessages) {
            if (messageIdsWithActivity.has(message.info.id)) {
                anchorMessageId = message.info.id;
                break;
            }
        }

        if (anchorMessageId) {
            activitySegments.push({
                id: `${input.turnId}:${anchorMessageId}:start`,
                anchorMessageId,
                afterToolPartId: null,
                parts: activityParts,
            });
        }
    }

    return {
        activityParts,
        activitySegments,
        hasTools,
        hasReasoning,
    };
};
