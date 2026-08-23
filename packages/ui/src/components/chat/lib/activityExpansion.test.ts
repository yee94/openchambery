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

import { resolveActivityExpansionDisposition } from './activityExpansion';

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
