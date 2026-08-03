import { describe, expect, test } from 'bun:test';

import type { TurnRecord } from '../lib/turns/types';
import { MAX_LIVE_TAIL_TURNS, resolveLiveTailStart, splitTurnRecordsByLiveTail } from './useTurnRecords';

const turn = (turnId: string): TurnRecord => ({ turnId } as TurnRecord);

describe('splitTurnRecordsByLiveTail', () => {
    test('keeps every turn in virtualized history when the tail is unclaimed', () => {
        const first = turn('turn-1');
        const latest = turn('turn-2');

        expect(splitTurnRecordsByLiveTail([first, latest], null)).toEqual({
            staticTurns: [first, latest],
            streamingTurns: [],
        });
    });

    test('hands the tail every turn from its start index onward', () => {
        const first = turn('turn-1');
        const second = turn('turn-2');
        const latest = turn('turn-3');

        expect(splitTurnRecordsByLiveTail([first, second, latest], 1)).toEqual({
            staticTurns: [first],
            streamingTurns: [second, latest],
        });
    });

    test('leaves history empty when the tail owns the whole session', () => {
        const only = turn('turn-1');

        expect(splitTurnRecordsByLiveTail([only], 0)).toEqual({
            staticTurns: [],
            streamingTurns: [only],
        });
    });
});

describe('resolveLiveTailStart', () => {
    test('claims the newest turn when the tail is first armed', () => {
        expect(resolveLiveTailStart({
            turnCount: 3,
            hasLiveTail: true,
            liveTailActive: true,
            previousStart: null,
        })).toBe(2);
    });

    test('latches the claimed index so later turns join the tail instead of evicting it', () => {
        expect(resolveLiveTailStart({
            turnCount: 5,
            hasLiveTail: true,
            liveTailActive: true,
            previousStart: 2,
        })).toBe(2);
    });

    test('releases the tail entirely when it is unclaimed', () => {
        expect(resolveLiveTailStart({
            turnCount: 4,
            hasLiveTail: false,
            liveTailActive: false,
            previousStart: 2,
        })).toBeNull();
    });

    test('holds an oversized window while a stream is running', () => {
        const turnCount = MAX_LIVE_TAIL_TURNS + 5;

        expect(resolveLiveTailStart({
            turnCount,
            hasLiveTail: true,
            liveTailActive: true,
            previousStart: 0,
        })).toBe(0);
    });

    test('flushes an oversized window in one batch once idle', () => {
        const turnCount = MAX_LIVE_TAIL_TURNS + 5;

        expect(resolveLiveTailStart({
            turnCount,
            hasLiveTail: true,
            liveTailActive: false,
            previousStart: 0,
        })).toBe(turnCount - 1);
    });

    test('never points past the newest turn when history shrinks', () => {
        expect(resolveLiveTailStart({
            turnCount: 2,
            hasLiveTail: true,
            liveTailActive: true,
            previousStart: 7,
        })).toBe(1);
    });
});
