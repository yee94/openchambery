import React from 'react';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import type { ChatMessageEntry, TurnProjectionResult, TurnRecord } from '../lib/turns/types';
import { buildProjectionCacheKey, getCachedProjectionByKey, setCachedProjection } from '../lib/turns/turnProjectionCache';
import { streamPerfMeasure } from '@/stores/utils/streamDebug';

interface UseTurnRecordsOptions {
    sessionKey?: string;
    showTextJustificationActivity: boolean;
    showTurnChangedFiles: boolean;
    hasLiveTail: boolean;
    // Whether a stream is running right now, as opposed to `hasLiveTail`, which
    // stays claimed after it ends. Only used to keep a tail flush out of a stream.
    liveTailActive: boolean;
}

export interface TurnRecordsResult {
    projection: TurnProjectionResult;
    staticTurns: TurnProjectionResult['turns'];
    streamingTurns: TurnProjectionResult['turns'];
}

const EMPTY_TURNS: TurnRecord[] = [];

const sameTurns = (a: TurnRecord[], b: TurnRecord[]): boolean => {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return false;
    }
    return true;
};

// Upper bound on turns parked in the (unvirtualized) tail. Reaching it costs one
// migration, so keep it well above a normal conversation's length.
export const MAX_LIVE_TAIL_TURNS = 12;

/**
 * Index of the first turn owned by the tail, or `null` when the tail is unclaimed.
 *
 * The tail must keep every turn it has ever streamed. Handing the slot to the
 * newest turn alone evicts the previous one into history, and because the two
 * live in different components that eviction unmounts a whole turn subtree and
 * rebuilds it from an empty node — a full-turn flash plus a viewport-sized
 * layout shift on every single turn. Latching the start index instead means a
 * turn's DOM is created once and never moves.
 */
export const resolveLiveTailStart = (input: {
    turnCount: number;
    hasLiveTail: boolean;
    liveTailActive: boolean;
    previousStart: number | null;
}): number | null => {
    if (!input.hasLiveTail || input.turnCount === 0) {
        return null;
    }

    const claimed = input.previousStart ?? input.turnCount - 1;
    const start = Math.min(Math.max(claimed, 0), input.turnCount - 1);

    // Flush the window in one batch rather than sliding it, which would restore
    // the per-turn migration this latch exists to remove. Only while idle, so a
    // flush never lands mid-stream.
    if (!input.liveTailActive && input.turnCount - start > MAX_LIVE_TAIL_TURNS) {
        return input.turnCount - 1;
    }

    return start;
};

export const splitTurnRecordsByLiveTail = (
    turns: TurnRecord[],
    tailStart: number | null,
): Pick<TurnRecordsResult, 'staticTurns' | 'streamingTurns'> => {
    if (tailStart === null) {
        return {
            staticTurns: turns,
            streamingTurns: EMPTY_TURNS,
        };
    }

    return {
        staticTurns: tailStart === 0 ? EMPTY_TURNS : turns.slice(0, tailStart),
        streamingTurns: turns.slice(tailStart),
    };
};

export const useTurnRecords = (
    messages: ChatMessageEntry[],
    options: UseTurnRecordsOptions,
): TurnRecordsResult => {
    const previousProjectionRef = React.useRef<TurnProjectionResult | null>(null);
    const staticTurnsRef = React.useRef<TurnRecord[]>([]);
    const streamingTurnsRef = React.useRef<TurnRecord[]>(EMPTY_TURNS);
    const liveTailStartRef = React.useRef<number | null>(null);
    const previousSessionKeyRef = React.useRef<string | undefined>(options.sessionKey);
    const previousShowTextJustificationActivityRef = React.useRef(options.showTextJustificationActivity);
    const previousShowTurnChangedFilesRef = React.useRef(options.showTurnChangedFiles);

    if (
        previousSessionKeyRef.current !== options.sessionKey
        || previousShowTextJustificationActivityRef.current !== options.showTextJustificationActivity
        || previousShowTurnChangedFilesRef.current !== options.showTurnChangedFiles
    ) {
        previousSessionKeyRef.current = options.sessionKey;
        previousShowTextJustificationActivityRef.current = options.showTextJustificationActivity;
        previousShowTurnChangedFilesRef.current = options.showTurnChangedFiles;
        previousProjectionRef.current = null;
        staticTurnsRef.current = [];
        streamingTurnsRef.current = EMPTY_TURNS;
        liveTailStartRef.current = null;
    }

    React.useEffect(() => {
        previousProjectionRef.current = null;
        staticTurnsRef.current = [];
        streamingTurnsRef.current = EMPTY_TURNS;
        liveTailStartRef.current = null;
    }, [options.sessionKey, options.showTextJustificationActivity, options.showTurnChangedFiles]);

    const projection = React.useMemo(() => {
        const sessionKey = options.sessionKey ?? '';
        const cacheKey = buildProjectionCacheKey(
            sessionKey,
            messages,
            options.showTextJustificationActivity,
            options.showTurnChangedFiles,
        );
        const cached = getCachedProjectionByKey(cacheKey);
        if (cached) {
            previousProjectionRef.current = cached;
            return cached;
        }

        return streamPerfMeasure('ui.turns.projection_ms', () => {
            const nextProjection = projectTurnRecords(messages, {
                previousProjection: previousProjectionRef.current,
                showTextJustificationActivity: options.showTextJustificationActivity,
                showTurnChangedFiles: options.showTurnChangedFiles,
            });
            previousProjectionRef.current = nextProjection;

            setCachedProjection(cacheKey, nextProjection);

            return nextProjection;
        });
    }, [messages, options.showTextJustificationActivity, options.showTurnChangedFiles, options.sessionKey]);

    const liveTailStart = resolveLiveTailStart({
        turnCount: projection.turns.length,
        hasLiveTail: options.hasLiveTail,
        liveTailActive: options.liveTailActive,
        previousStart: liveTailStartRef.current,
    });
    liveTailStartRef.current = liveTailStart;

    const staticTurns = React.useMemo(() => {
        const nextStatic = splitTurnRecordsByLiveTail(projection.turns, liveTailStart).staticTurns;
        return sameTurns(staticTurnsRef.current, nextStatic)
            ? staticTurnsRef.current
            : (staticTurnsRef.current = nextStatic);
    }, [liveTailStart, projection.turns]);

    const streamingTurns = React.useMemo(() => {
        const nextStreaming = splitTurnRecordsByLiveTail(projection.turns, liveTailStart).streamingTurns;
        return sameTurns(streamingTurnsRef.current, nextStreaming)
            ? streamingTurnsRef.current
            : (streamingTurnsRef.current = nextStreaming);
    }, [liveTailStart, projection.turns]);

    return {
        projection,
        staticTurns,
        streamingTurns,
    };
};
