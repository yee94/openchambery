/**
 * History vs live-tail entry order.
 *
 * The tail latches whole turns so a streaming turn is not destroyed when it
 * settles. Ungrouped rows (OpenCode 2 compaction checkpoints) are not turns.
 * They must stay at their message index relative to those latched turns.
 * Parking every ungrouped row in the history list paints a checkpoint above
 * the turn it follows.
 */

type TimelineMessage = {
    info: { id: string };
};

type TimelineTurn<TMessage extends TimelineMessage> = {
    turnId: string;
    userMessage: TMessage;
};

export type TimelineRenderEntry<TMessage extends TimelineMessage, TTurn> =
    | {
        kind: 'ungrouped';
        key: string;
        message: TMessage;
        previousMessage?: TMessage;
        nextMessage?: TMessage;
    }
    | {
        kind: 'turn';
        key: string;
        turn: TTurn;
        isLastTurn: boolean;
    };

const EMPTY_TAIL: TimelineRenderEntry<TimelineMessage, unknown>[] = [];

const turnEntry = <TMessage extends TimelineMessage, TTurn extends TimelineTurn<TMessage>>(
    turn: TTurn,
    lastTurnId: string | null,
): TimelineRenderEntry<TMessage, TTurn> => ({
    kind: 'turn',
    key: `turn:${turn.turnId}`,
    turn,
    isLastTurn: turn.turnId === lastTurnId,
});

const ungroupedEntry = <TMessage extends TimelineMessage>(
    messages: readonly TMessage[],
    index: number,
): TimelineRenderEntry<TMessage, never> => {
    const message = messages[index]!;
    return {
        kind: 'ungrouped',
        key: `msg:${message.info.id}`,
        message,
        previousMessage: index > 0 ? messages[index - 1] : undefined,
        nextMessage: index < messages.length - 1 ? messages[index + 1] : undefined,
    };
};

const walkEntries = <TMessage extends TimelineMessage, TTurn extends TimelineTurn<TMessage>>(
    messages: readonly TMessage[],
    turns: readonly TTurn[],
    ungroupedMessageIds: ReadonlySet<string>,
    lastTurnId: string | null,
): TimelineRenderEntry<TMessage, TTurn>[] => {
    const turnByUserMessageId = new Map<string, TTurn>();
    for (const turn of turns) {
        turnByUserMessageId.set(turn.userMessage.info.id, turn);
    }

    const ordered: TimelineRenderEntry<TMessage, TTurn>[] = [];
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]!;
        const turn = turnByUserMessageId.get(message.info.id);
        if (turn) {
            ordered.push(turnEntry(turn, lastTurnId));
            continue;
        }
        if (!ungroupedMessageIds.has(message.info.id)) {
            continue;
        }
        ordered.push(ungroupedEntry(messages, index));
    }
    return ordered;
};

export function splitTimelineRenderEntries<
    TMessage extends TimelineMessage,
    TTurn extends TimelineTurn<TMessage>,
>(input: {
    messages: readonly TMessage[];
    turns: readonly TTurn[];
    streamingTurns: readonly TTurn[];
    ungroupedMessageIds: ReadonlySet<string>;
    lastTurnId: string | null;
}): {
    history: TimelineRenderEntry<TMessage, TTurn>[];
    tail: TimelineRenderEntry<TMessage, TTurn>[];
} {
    const { messages, turns, streamingTurns, ungroupedMessageIds, lastTurnId } = input;

    if (ungroupedMessageIds.size === 0) {
        if (streamingTurns.length === 0) {
            return {
                history: turns.map((turn) => turnEntry(turn, lastTurnId)),
                tail: EMPTY_TAIL as TimelineRenderEntry<TMessage, TTurn>[],
            };
        }
        const tailTurnId = streamingTurns[0]!.turnId;
        const tailStart = turns.findIndex((turn) => turn.turnId === tailTurnId);
        if (tailStart < 0) {
            return {
                history: turns.map((turn) => turnEntry(turn, lastTurnId)),
                tail: streamingTurns.map((turn) => turnEntry(turn, lastTurnId)),
            };
        }
        return {
            history: turns.slice(0, tailStart).map((turn) => turnEntry(turn, lastTurnId)),
            tail: turns.slice(tailStart).map((turn) => turnEntry(turn, lastTurnId)),
        };
    }

    const ordered = walkEntries(messages, turns, ungroupedMessageIds, lastTurnId);

    if (streamingTurns.length === 0) {
        const lastMessage = messages[messages.length - 1];
        if (!lastMessage || !ungroupedMessageIds.has(lastMessage.info.id)) {
            return {
                history: ordered,
                tail: EMPTY_TAIL as TimelineRenderEntry<TMessage, TTurn>[],
            };
        }
        const trailing = ordered.find((entry) => (
            entry.kind === 'ungrouped' && entry.message.info.id === lastMessage.info.id
        ));
        return {
            history: ordered,
            tail: trailing ? [trailing] : EMPTY_TAIL as TimelineRenderEntry<TMessage, TTurn>[],
        };
    }

    const tailTurnId = streamingTurns[0]!.turnId;
    const tailStart = ordered.findIndex((entry) => entry.kind === 'turn' && entry.turn.turnId === tailTurnId);
    if (tailStart < 0) {
        return {
            history: ordered,
            tail: streamingTurns.map((turn) => turnEntry(turn, lastTurnId)),
        };
    }

    return {
        history: ordered.slice(0, tailStart),
        tail: ordered.slice(tailStart),
    };
}
