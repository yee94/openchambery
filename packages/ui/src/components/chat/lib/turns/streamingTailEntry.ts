import type { Part } from '@opencode-ai/sdk/v2';

import { mergePartsForDisplay } from '@/sync/displayParts';

import { getNormalizedMessageForDisplay } from '../messageDisplayNormalization';
import { projectTurnRecords } from './projectTurnRecords';
import type { ChatMessageEntry, TurnRecord } from './types';

export type StreamingTailEntry =
    | {
        kind: 'ungrouped';
        key: string;
        message: ChatMessageEntry;
        previousMessage?: ChatMessageEntry;
        nextMessage?: ChatMessageEntry;
    }
    | { kind: 'turn'; key: string; turn: TurnRecord; isLastTurn: boolean };

type BuildLiveStreamingEntryOptions = {
    activeStreamingMessageId: string | null | undefined;
    liveParts: Part[];
    showTextJustificationActivity: boolean;
    showTurnChangedFiles: boolean;
};

/**
 * Overlay live part-store rows onto the streaming assistant for display.
 *
 * The tail subscribes to the raw part store so streaming text is not held back
 * by snapshot suspension. It applies the same `mergePartsForDisplay` contract the
 * snapshot uses, so both readers of repository parts agree on when a frame may shrink.
 */
const withLiveParts = (
    message: ChatMessageEntry,
    activeStreamingMessageId: string,
    liveParts: Part[],
): ChatMessageEntry => {
    if (message.info.id !== activeStreamingMessageId || message.parts === liveParts) {
        return message;
    }

    const mergedParts = mergePartsForDisplay(message.parts, liveParts, message.info);
    if (
        mergedParts.length === message.parts.length
        && mergedParts.every((part, index) => part === message.parts[index])
    ) {
        return message;
    }

    return getNormalizedMessageForDisplay({
        ...message,
        parts: mergedParts,
    });
};

export const buildLiveStreamingEntry = <TEntry extends StreamingTailEntry>(
    entry: TEntry,
    options: BuildLiveStreamingEntryOptions,
): TEntry => {
    const activeStreamingMessageId = options.activeStreamingMessageId;
    if (!activeStreamingMessageId) {
        return entry;
    }

    if (entry.kind === 'ungrouped') {
        const message = withLiveParts(entry.message, activeStreamingMessageId, options.liveParts);
        if (message === entry.message) {
            return entry;
        }
        return {
            ...entry,
            message,
        };
    }

    let changed = false;
    const assistantMessages = entry.turn.assistantMessages.map((message) => {
        const next = withLiveParts(message, activeStreamingMessageId, options.liveParts);
        if (next !== message) {
            changed = true;
        }
        return next;
    });

    if (!changed) {
        return entry;
    }

    const projection = projectTurnRecords([entry.turn.userMessage, ...assistantMessages], {
        showTextJustificationActivity: options.showTextJustificationActivity,
        showTurnChangedFiles: options.showTurnChangedFiles,
    });
    const turn = projection.turns[0] ?? {
        ...entry.turn,
        assistantMessages,
        assistantMessageIds: assistantMessages.map((message) => message.info.id),
    };

    return {
        ...entry,
        turn,
    };
};
