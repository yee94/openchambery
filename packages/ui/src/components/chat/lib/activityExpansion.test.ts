/**
 * Activity expansion contracts for queued/steered turns.
 *
 * A queued or steered user message makes the running turn non-last while its
 * tools are still executing (the queue gap before the next run's first
 * assistant can last minutes). Expansion must follow the turn's own
 * completion disposition, not turn position: folding then hid in-progress
 * steps inside a collapsed disclosure.
 */

import { describe, expect, test } from 'vitest';

import {
    resolveActivityExpansionDisposition,
    resolveTurnSettledForPresentation,
    shouldTightenWorkingBottomGap,
} from './activityExpansion';

describe('resolveTurnSettledForPresentation', () => {
    test('authoritative last-assistant settle overrides lagging sessionIsWorking on the last turn', () => {
        // Live SSE: finish/stop + completed + tokens land before sessionIsWorking
        // flips off; TPS must not wait for HTTP reconcile.
        expect(resolveTurnSettledForPresentation({
            completionDisposition: 'normal',
            isLastTurn: true,
            sessionIsWorking: true,
            hasConfirmedSettledAssistant: true,
        })).toBe(true);
    });

    test('without authoritative settle, last turn stays unsettled while sessionIsWorking', () => {
        expect(resolveTurnSettledForPresentation({
            completionDisposition: 'normal',
            isLastTurn: true,
            sessionIsWorking: true,
        })).toBe(false);
        expect(resolveTurnSettledForPresentation({
            completionDisposition: 'normal',
            isLastTurn: true,
            sessionIsWorking: true,
            hasConfirmedSettledAssistant: false,
        })).toBe(false);
    });

    test('active disposition stays unsettled even with authoritative settle signal', () => {
        expect(resolveTurnSettledForPresentation({
            completionDisposition: 'active',
            isLastTurn: true,
            sessionIsWorking: true,
            hasConfirmedSettledAssistant: true,
        })).toBe(false);
        expect(resolveTurnSettledForPresentation({
            completionDisposition: 'active',
            isLastTurn: true,
            sessionIsWorking: false,
            hasConfirmedSettledAssistant: true,
        })).toBe(false);
    });

    test('non-last turn is settled even while sessionIsWorking', () => {
        expect(resolveTurnSettledForPresentation({
            completionDisposition: 'abnormal',
            isLastTurn: false,
            sessionIsWorking: true,
        })).toBe(true);
    });
});

describe('resolveActivityExpansionDisposition', () => {
    test('running non-last turn (steered/queued) stays active for expansion', () => {
        // 插队后：正在跑工具的 turn 不再是 last，但 disposition 仍为
        // active（trailing assistant finish=tool-calls、run 继续）。
        expect(resolveActivityExpansionDisposition({
            isLastTurn: false,
            turnCompletionDisposition: 'active',
            headerPresentationDisposition: 'abnormal',
            hasAssistantMessages: true,
        })).toBe('active');
    });

    test('running last turn stays active even when header demoted to abnormal', () => {
        expect(resolveActivityExpansionDisposition({
            isLastTurn: true,
            turnCompletionDisposition: 'active',
            headerPresentationDisposition: 'abnormal',
            hasAssistantMessages: true,
        })).toBe('active');
    });

    test('empty queue placeholder turn does not expand on its own when non-last', () => {
        // 排队占位 turn（无 assistant、非 last）不因 disposition 恒为
        // active 而展开。
        expect(resolveActivityExpansionDisposition({
            isLastTurn: false,
            turnCompletionDisposition: 'active',
            headerPresentationDisposition: 'abnormal',
            hasAssistantMessages: false,
        })).toBe('abnormal');
    });

    test('settled turns follow header presentation demotion', () => {
        for (const disposition of ['normal', 'abnormal'] as const) {
            expect(resolveActivityExpansionDisposition({
                isLastTurn: false,
                turnCompletionDisposition: disposition,
                headerPresentationDisposition: disposition,
                hasAssistantMessages: true,
            })).toBe(disposition);
        }
    });
});

describe('shouldTightenWorkingBottomGap', () => {
    test('live working always tightens so StatusRow sits under the last tool', () => {
        expect(shouldTightenWorkingBottomGap({
            isWorking: true,
            isInActiveTurn: false,
            headerCompletionDisposition: 'active',
        })).toBe(true);
        // Queued/steered running turn is no longer last: header demotes to
        // Processed but tools are still executing — keep the tight gap.
        expect(shouldTightenWorkingBottomGap({
            isWorking: true,
            isInActiveTurn: true,
            headerCompletionDisposition: 'abnormal',
        })).toBe(true);
    });

    test('idle Processed chrome restores pb-8 even when isInActiveTurn never cleared', () => {
        // Incomplete last assistant (no time.completed) keeps the
        // streamingAssistantMessageId fallback after header demotion.
        // Idle Processed chrome still needs pb-8 so the next turn does not
        // overlap the Processed header.
        expect(shouldTightenWorkingBottomGap({
            isWorking: false,
            isInActiveTurn: true,
            headerCompletionDisposition: 'abnormal',
        })).toBe(false);
        expect(shouldTightenWorkingBottomGap({
            isWorking: false,
            isInActiveTurn: true,
            headerCompletionDisposition: 'normal',
        })).toBe(false);
    });

    test('in-flight last assistant without isWorking still tightens', () => {
        expect(shouldTightenWorkingBottomGap({
            isWorking: false,
            isInActiveTurn: true,
            headerCompletionDisposition: 'active',
        })).toBe(true);
        expect(shouldTightenWorkingBottomGap({
            isWorking: false,
            isInActiveTurn: false,
        })).toBe(false);
    });
});
