import { hasConfirmedTerminalStop } from './assistantMessageLifecycle';
import type {
    ChatMessageEntry,
    TurnActivityGroup,
    TurnActivityRecord,
    TurnPartRecord,
} from './types';
import { resolveActivityPartId } from './resolveActivityPartId';

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
        id: resolveActivityPartId(messageId, part, partIndex),
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

    // Canonical stop summary: the summary source must be a confirmed terminal
    // stop message (finish === 'stop' with zero continuation tools, the runLoop
    // exit rule). A stop that still carries continuation tools is a step
    // boundary: its text stays in Activity justification instead of being
    // promoted to the canonical body, and it must not fold other text away.
    //
    // The check is made on the summary source message itself rather than on the
    // turn's disposition. Turn disposition is derived from the *last* assistant,
    // so a multi-step step gap flipped it to normal and back and took Activity
    // row membership with it — a text part moved between an Activity
    // justification row and the message body, unmounting the fold. Row
    // membership must depend only on facts local to the message that owns the
    // part.
    const hasCanonicalStopSummary = Boolean(input.summarySourceMessageId)
        && Boolean(input.summarySourcePartId)
        && input.assistantMessages.some((message) => (
            message.info.id === input.summarySourceMessageId
            && hasConfirmedTerminalStop(getMessageFinish(message), message.parts)
        ));

    input.assistantMessages.forEach((message) => {
        const finish = getMessageFinish(message);
        const messageHasTool = message.parts.some((part) => part.type === 'tool');

        message.parts.forEach((part, partIndex) => {
            const isTool = part.type === 'tool';

            const text = part.type === 'reasoning' || part.type === 'text'
                ? getPartText(part)
                : undefined;
            const partId = resolveActivityPartId(message.info.id, part, partIndex);

            const isConfirmedSummaryText = part.type === 'text'
                && typeof text === 'string'
                && hasConfirmedTerminalStop(finish, message.parts)
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
        // Host the disclosure on the turn's first assistant, and identify the
        // segment by the turn alone. Deriving either from "first message that
        // currently has activity" made the host migrate mid-turn: one empty-parts
        // frame moved the anchor to the next assistant, which changed the segment
        // key *and* the owning ChatMessage, so the whole nested fold unmounted and
        // remounted. Turn identity is the only stable host identity.
        const anchorMessageId = input.assistantMessages[0]?.info.id;

        if (anchorMessageId) {
            activitySegments.push({
                id: `${input.turnId}:activity`,
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
