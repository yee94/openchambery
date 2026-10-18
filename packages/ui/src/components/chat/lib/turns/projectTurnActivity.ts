import { countContinuationToolParts, isModelTextPart } from './assistantMessageLifecycle';
import type {
    ChatMessageEntry,
    TurnActivityGroup,
    TurnActivityRecord,
    TurnMessageRecord,
    TurnPartRecord,
} from './types';
import { resolveActivityPartId } from './resolveActivityPartId';
import { hasUserDisplayableParts } from '../../message/normalizeUserDisplayParts';
import { isRestartNotice } from '../../message/assistantErrorPresentation';
import { hasVisibleText } from '../../message/partUtils';

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
    if (typeof text === 'string' && hasVisibleText(text)) {
        return text;
    }
    const content = (part as { content?: unknown }).content;
    if (typeof content === 'string' && hasVisibleText(content)) {
        return content;
    }
    return undefined;
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
    messages?: readonly TurnMessageRecord[];
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
    const activityByMessage = new Map<string, TurnActivityRecord[]>();
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

    // Only the trailing model text can sit after Activity without changing
    // OpenCode's order. Earlier text parts remain at their original positions.
    const lastMessage = input.assistantMessages.at(-1);
    let bodyPartIndex = -1;
    if (lastMessage && countContinuationToolParts(lastMessage.parts) === 0) {
        for (let index = lastMessage.parts.length - 1; index >= 0; index -= 1) {
            const part = lastMessage.parts[index];
            if (isModelTextPart(part)) {
                bodyPartIndex = index;
                break;
            } else if (part.type === 'tool' || part.type === 'reasoning' || part.type === 'file' || part.type === 'agent' || part.type === 'subtask') {
                break;
            }
        }
    }

    input.assistantMessages.forEach((message) => {
        const messageActivity: TurnActivityRecord[] = [];
        message.parts.forEach((part, partIndex) => {
            const isTool = part.type === 'tool';

            const text = part.type === 'reasoning' || part.type === 'text'
                ? getPartText(part)
                : undefined;
            const isBodyText = message === lastMessage && partIndex === bodyPartIndex;

            let kind: TurnActivityRecord['kind'] | null = null;
            if (isTool) {
                kind = 'tool';
            } else if (part.type === 'reasoning') {
                // Slim first-packet traces drop the body. They still belong in
                // Activity so collapsed MessageBody cannot wrap a null
                // ReasoningPart in tool-row padding (hundreds of empty shells
                // between the disclosure header and the final answer).
                kind = 'reasoning';
            } else if (
                input.showTextJustificationActivity
                && part.type === 'text'
                && text
                && !isBodyText
            ) {
                kind = 'justification';
            }

            if (!kind) {
                return;
            }

            const activity: TurnActivityRecord = {
                ...buildTurnPartRecord(input.turnId, message.info.id, part, partIndex),
                kind,
            };
            activityParts.push(activity);
            messageActivity.push(activity);
        });
        activityByMessage.set(message.info.id, messageActivity);
    });

    const activitySegments: TurnActivityGroup[] = [];

    // Consolidate display-adjacent assistants only. A visible checkpoint/notice
    // is an order boundary; hidden native instructions are transparent.
    // Empty assistants still anchor their run so late parts cannot remount it.
    const records = input.messages ?? input.assistantMessages.map(message => ({ role: 'assistant', messageId: message.info.id, message }));
    let segment: TurnActivityGroup | undefined;
    for (const record of records) {
        if (record.role !== 'assistant') {
            // Match notice visibility before ending the adjacent assistant run.
            // Hidden native instructions have no position in the rendered list.
            if (record.message.info.nativeType === 'synthetic'
                && !isRestartNotice(record.message.info)
                && !hasUserDisplayableParts(record.message.parts)) continue;
            segment = undefined;
            continue;
        }
        if (!segment) {
            segment = {
                id: record.messageId === input.assistantMessages[0]?.info.id
                    ? `${input.turnId}:activity`
                    : `${input.turnId}:activity:${record.messageId}`,
                anchorMessageId: record.messageId,
                afterToolPartId: null,
                parts: [],
            };
            activitySegments.push(segment);
        }
        segment.parts.push(...(activityByMessage.get(record.messageId) ?? []));
    }

    const nonEmptySegments = activitySegments.filter(segment => segment.parts.length > 0);
    if (nonEmptySegments.length === 1) nonEmptySegments[0].parts = activityParts;
    return {
        activityParts,
        activitySegments: nonEmptySegments,
        hasTools,
        hasReasoning,
    };
};
