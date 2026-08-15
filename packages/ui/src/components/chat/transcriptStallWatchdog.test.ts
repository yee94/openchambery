import { describe, expect, test } from 'bun:test';
import {
    INITIAL_TRANSCRIPT_STALL_STATE,
    advanceTranscriptStallState,
    buildTranscriptTailFingerprint,
    type TranscriptStallState,
} from './transcriptStallWatchdog';

const THRESHOLD = 20_000;
const COOLDOWN = 60_000;
const MAX_ATTEMPTS = 3;

const record = (id: string, parts: Array<Record<string, unknown>> = []) => ({
    info: { id },
    parts: parts as never,
});

const tick = (
    state: TranscriptStallState,
    overrides: {
        fingerprint: string;
        now: number;
        working?: boolean;
        streaming?: boolean;
        sessionKey?: string | null;
    },
) => advanceTranscriptStallState(state, {
    sessionKey: overrides.sessionKey === undefined ? '/repo\nses_a' : overrides.sessionKey,
    working: overrides.working ?? true,
    streaming: overrides.streaming ?? false,
    fingerprint: overrides.fingerprint,
    now: overrides.now,
    thresholdMs: THRESHOLD,
    cooldownMs: COOLDOWN,
    maxAttempts: MAX_ATTEMPTS,
});

describe('buildTranscriptTailFingerprint', () => {
    test('empty transcript has a stable signature', () => {
        expect(buildTranscriptTailFingerprint([])).toBe('0');
    });

    test('a new trailing message changes the signature', () => {
        const before = buildTranscriptTailFingerprint([record('msg_1')]);
        const after = buildTranscriptTailFingerprint([record('msg_1'), record('msg_2')]);
        expect(after).not.toBe(before);
    });

    test('text growth under a stable part id changes the signature', () => {
        const before = buildTranscriptTailFingerprint([
            record('msg_1', [{ id: 'prt_1', type: 'text', text: 'ab' }]),
        ]);
        const after = buildTranscriptTailFingerprint([
            record('msg_1', [{ id: 'prt_1', type: 'text', text: 'abcd' }]),
        ]);
        expect(after).not.toBe(before);
    });

    test('tool status transitions change the signature', () => {
        const before = buildTranscriptTailFingerprint([
            record('msg_1', [{ id: 'prt_1', type: 'tool', state: { status: 'running' } }]),
        ]);
        const after = buildTranscriptTailFingerprint([
            record('msg_1', [{ id: 'prt_1', type: 'tool', state: { status: 'completed' } }]),
        ]);
        expect(after).not.toBe(before);
    });

    test('an unchanged tail keeps the same signature', () => {
        const rows = [record('msg_1', [{ id: 'prt_1', type: 'text', text: 'hello' }])];
        expect(buildTranscriptTailFingerprint(rows)).toBe(buildTranscriptTailFingerprint(rows));
    });
});

describe('advanceTranscriptStallState', () => {
    test('a frozen tail under an active status refreshes once the threshold passes', () => {
        let state = INITIAL_TRANSCRIPT_STALL_STATE;
        state = tick(state, { fingerprint: 'a', now: 0 }).state;
        expect(state.lastMovementAt).toBe(0);

        const beforeThreshold = tick(state, { fingerprint: 'a', now: THRESHOLD - 1 });
        expect(beforeThreshold.shouldRefresh).toBe(false);

        const atThreshold = tick(beforeThreshold.state, { fingerprint: 'a', now: THRESHOLD });
        expect(atThreshold.shouldRefresh).toBe(true);
        expect(atThreshold.state.attempts).toBe(1);
    });

    test('a moving tail never refreshes', () => {
        let state = INITIAL_TRANSCRIPT_STALL_STATE;
        state = tick(state, { fingerprint: 'a', now: 0 }).state;
        for (let elapsed = 1; elapsed <= 10; elapsed += 1) {
            const result = tick(state, { fingerprint: `f${elapsed}`, now: elapsed * THRESHOLD });
            expect(result.shouldRefresh).toBe(false);
            state = result.state;
        }
    });

    test('an idle session is allowed to sit still', () => {
        let state = INITIAL_TRANSCRIPT_STALL_STATE;
        state = tick(state, { fingerprint: 'a', now: 0 }).state;
        const result = tick(state, { fingerprint: 'a', now: THRESHOLD * 10, working: false });
        expect(result.shouldRefresh).toBe(false);
    });

    test('a live local stream suppresses the refresh', () => {
        let state = INITIAL_TRANSCRIPT_STALL_STATE;
        state = tick(state, { fingerprint: 'a', now: 0 }).state;
        const result = tick(state, { fingerprint: 'a', now: THRESHOLD * 10, streaming: true });
        expect(result.shouldRefresh).toBe(false);
    });

    test('the cooldown spaces repeated attempts', () => {
        let state = INITIAL_TRANSCRIPT_STALL_STATE;
        state = tick(state, { fingerprint: 'a', now: 0 }).state;

        const first = tick(state, { fingerprint: 'a', now: THRESHOLD });
        expect(first.shouldRefresh).toBe(true);

        const tooSoon = tick(first.state, { fingerprint: 'a', now: THRESHOLD + COOLDOWN - 1 });
        expect(tooSoon.shouldRefresh).toBe(false);

        const afterCooldown = tick(tooSoon.state, { fingerprint: 'a', now: THRESHOLD + COOLDOWN });
        expect(afterCooldown.shouldRefresh).toBe(true);
        expect(afterCooldown.state.attempts).toBe(2);
    });

    test('attempts are capped so a genuinely idle-but-busy session cannot loop', () => {
        let state = tick(INITIAL_TRANSCRIPT_STALL_STATE, { fingerprint: 'a', now: 0 }).state;
        let fired = 0;
        for (let step = 1; step <= 20; step += 1) {
            const result = tick(state, { fingerprint: 'a', now: THRESHOLD + step * COOLDOWN });
            if (result.shouldRefresh) fired += 1;
            state = result.state;
        }
        expect(fired).toBe(MAX_ATTEMPTS);
        expect(state.attempts).toBe(MAX_ATTEMPTS);
    });

    test('movement restores the full attempt budget', () => {
        let state = tick(INITIAL_TRANSCRIPT_STALL_STATE, { fingerprint: 'a', now: 0 }).state;
        state = tick(state, { fingerprint: 'a', now: THRESHOLD }).state;
        expect(state.attempts).toBe(1);

        state = tick(state, { fingerprint: 'b', now: THRESHOLD + 1 }).state;
        expect(state.attempts).toBe(0);
        expect(state.lastMovementAt).toBe(THRESHOLD + 1);
    });

    test('switching sessions drops the previous stall history', () => {
        let state = tick(INITIAL_TRANSCRIPT_STALL_STATE, { fingerprint: 'a', now: 0 }).state;
        state = tick(state, { fingerprint: 'a', now: THRESHOLD }).state;
        expect(state.attempts).toBe(1);

        const switched = tick(state, {
            fingerprint: 'a',
            now: THRESHOLD + 1,
            sessionKey: '/repo\nses_b',
        });
        expect(switched.shouldRefresh).toBe(false);
        expect(switched.state.attempts).toBe(0);
        expect(switched.state.lastRefreshAt).toBeNull();
    });

    test('no session resets to the initial state', () => {
        const state = tick(INITIAL_TRANSCRIPT_STALL_STATE, { fingerprint: 'a', now: 0 }).state;
        const result = tick(state, { fingerprint: 'a', now: THRESHOLD, sessionKey: null });
        expect(result.state).toEqual(INITIAL_TRANSCRIPT_STALL_STATE);
    });
});
