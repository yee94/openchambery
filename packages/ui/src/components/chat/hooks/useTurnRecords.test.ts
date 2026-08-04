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

    test('keeps the claim through an empty projection frame', () => {
        expect(resolveLiveTailStart({
            turnCount: 0,
            hasLiveTail: true,
            liveTailActive: true,
            previousStart: 3,
        })).toBe(3);
    });

    test('an empty frame does not re-arm the tail at the newest turn', () => {
        // Trace-20260804T171706: a materialize/merge frame emptied the projection
        // mid-turn. Clearing the claim here handed the tail to the newest turn on
        // the next frame, evicting everything it owned into history and remounting
        // those subtrees — the user message and reasoning blinked out and back.
        const claimed = resolveLiveTailStart({
            turnCount: 4,
            hasLiveTail: true,
            liveTailActive: true,
            previousStart: null,
        });
        expect(claimed).toBe(3);

        const throughEmptyFrame = resolveLiveTailStart({
            turnCount: 0,
            hasLiveTail: true,
            liveTailActive: true,
            previousStart: claimed,
        });

        expect(resolveLiveTailStart({
            turnCount: 5,
            hasLiveTail: true,
            liveTailActive: true,
            previousStart: throughEmptyFrame,
        })).toBe(3);
    });

    test('still releases the tail when it is unclaimed and the projection is empty', () => {
        expect(resolveLiveTailStart({
            turnCount: 0,
            hasLiveTail: false,
            liveTailActive: false,
            previousStart: 2,
        })).toBeNull();
    });
});
