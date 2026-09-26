import { describe, expect, test } from 'vitest';

import { splitTimelineRenderEntries } from './timelineRenderEntries';

type Message = { info: { id: string } };
type Turn = { turnId: string; userMessage: Message };

const message = (id: string): Message => ({ info: { id } });

const turn = (id: string): Turn => ({
    turnId: id,
    userMessage: message(id),
});

const keys = (entries: readonly { key: string }[]) => entries.map((entry) => entry.key);

describe('splitTimelineRenderEntries', () => {
    test('keeps a compaction checkpoint after the latched tail turn it follows', () => {
        const earlier = turn('user-earlier');
        const watched = turn('user-watched');
        const later = turn('user-later');
        const compaction = message('msg-compact');
        const messages = [
            earlier.userMessage,
            message('asst-earlier'),
            watched.userMessage,
            message('asst-watched'),
            compaction,
            later.userMessage,
        ];

        const split = splitTimelineRenderEntries({
            messages,
            turns: [earlier, watched, later],
            streamingTurns: [watched, later],
            ungroupedMessageIds: new Set([compaction.info.id]),
            lastTurnId: later.turnId,
        });

        expect(keys(split.history)).toEqual(['turn:user-earlier']);
        expect(keys(split.tail)).toEqual([
            'turn:user-watched',
            'msg:msg-compact',
            'turn:user-later',
        ]);
    });

    test('leaves a compaction checkpoint in history when it precedes the latched tail', () => {
        const earlier = turn('user-earlier');
        const watched = turn('user-watched');
        const compaction = message('msg-compact');
        const messages = [
            earlier.userMessage,
            compaction,
            watched.userMessage,
        ];

        const split = splitTimelineRenderEntries({
            messages,
            turns: [earlier, watched],
            streamingTurns: [watched],
            ungroupedMessageIds: new Set([compaction.info.id]),
            lastTurnId: watched.turnId,
        });

        expect(keys(split.history)).toEqual(['turn:user-earlier', 'msg:msg-compact']);
        expect(keys(split.tail)).toEqual(['turn:user-watched']);
    });

    test('splits turns only when nothing is ungrouped', () => {
        const first = turn('user-1');
        const second = turn('user-2');
        const split = splitTimelineRenderEntries({
            messages: [first.userMessage, second.userMessage],
            turns: [first, second],
            streamingTurns: [second],
            ungroupedMessageIds: new Set(),
            lastTurnId: second.turnId,
        });

        expect(keys(split.history)).toEqual(['turn:user-1']);
        expect(keys(split.tail)).toEqual(['turn:user-2']);
        expect(split.tail[0]).toMatchObject({ isLastTurn: true });
    });

    test('keeps a trailing ungrouped row on the tail when no turn is latched', () => {
        const first = turn('user-1');
        const compaction = message('msg-compact');
        const split = splitTimelineRenderEntries({
            messages: [first.userMessage, compaction],
            turns: [first],
            streamingTurns: [],
            ungroupedMessageIds: new Set([compaction.info.id]),
            lastTurnId: first.turnId,
        });

        expect(keys(split.history)).toEqual(['turn:user-1']);
        expect(keys(split.tail)).toEqual(['msg:msg-compact']);
        expect(new Set(keys([...split.history, ...split.tail])).size).toBe(2);
    });
});
