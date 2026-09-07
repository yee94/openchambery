import { describe, expect, test } from 'bun:test';

import {
    collectConsecutiveProcessTools,
    hasProcessSuccessor,
    isProcessGroupActive,
    isProcessSuccessorPart,
    isProcessToolActive,
    summarizeProcessTools,
    summarizeUsedToolDiffs,
} from './processToolGrouping';

describe('process tool grouping', () => {
    test('merges consecutive explore and used tools into one run', () => {
        const tools = ['read', 'glob', 'edit', 'bash', 'grep', 'write', 'skill', 'list', 'task', 'websearch', 'question', 'edit'];
        const first = collectConsecutiveProcessTools(tools, 0, (name) => name);
        expect(first.items).toEqual(['read', 'glob', 'edit', 'bash', 'grep', 'write']);
        expect(first.end).toBe(6);

        const afterSkill = collectConsecutiveProcessTools(tools, 7, (name) => name);
        expect(afterSkill.items).toEqual(['list']);
        expect(afterSkill.end).toBe(8);

        const afterTask = collectConsecutiveProcessTools(tools, 9, (name) => name);
        expect(afterTask.items).toEqual(['websearch']);
        expect(afterTask.end).toBe(10);

        const afterQuestion = collectConsecutiveProcessTools(tools, 11, (name) => name);
        expect(afterQuestion.items).toEqual(['edit']);
        expect(afterQuestion.end).toBe(12);
    });

    test('combines explore and used counts in one summary', () => {
        expect(summarizeProcessTools([
            'read',
            'read',
            'glob',
            'grep',
            'list',
            'edit',
            'write',
            'bash',
            'websearch',
        ])).toEqual({
            read: 2,
            search: 2,
            list: 1,
            edit: 2,
            command: 1,
            other: 1,
        });
    });

    test('aggregates line-diff totals from used tools in a mixed run', () => {
        expect(summarizeUsedToolDiffs([
            { state: { metadata: { additions: 3, deletions: 1 } } },
            { state: { metadata: { files: [{ additions: 2, deletions: 4 }] } } },
        ])).toEqual({ added: 5, removed: 5 });
    });

    test('treats pending, running, and started tools as active', () => {
        expect(isProcessToolActive({ state: { status: 'pending' } })).toBe(true);
        expect(isProcessToolActive({ state: { status: 'running' } })).toBe(true);
        expect(isProcessToolActive({ state: { status: 'started' } })).toBe(true);
        expect(isProcessToolActive({ state: { status: 'completed' } })).toBe(false);
        expect(isProcessToolActive({ state: { status: 'error' } })).toBe(false);
    });

    test('keeps the process fold live until body text or a special tool appears', () => {
        expect(isProcessSuccessorPart({ kind: 'reasoning' })).toBe(false);
        expect(isProcessSuccessorPart({ kind: 'justification' })).toBe(true);
        expect(isProcessSuccessorPart({ type: 'text' })).toBe(true);
        expect(isProcessSuccessorPart({ kind: 'tool', toolName: 'bash' })).toBe(false);
        expect(isProcessSuccessorPart({ kind: 'tool', toolName: 'grep' })).toBe(false);
        expect(isProcessSuccessorPart({ kind: 'tool', toolName: 'edit' })).toBe(false);
        expect(isProcessSuccessorPart({ kind: 'tool', toolName: 'skill' })).toBe(true);
        expect(isProcessSuccessorPart({ kind: 'tool', toolName: 'task' })).toBe(true);
        expect(isProcessSuccessorPart({ kind: 'tool', toolName: 'question' })).toBe(true);

        const timeline = [
            { kind: 'tool', toolName: 'grep' },
            { kind: 'reasoning' },
            { kind: 'tool', toolName: 'edit' },
            { kind: 'justification' },
        ];
        expect(hasProcessSuccessor(timeline, 1, (item) => item)).toBe(true);
        expect(hasProcessSuccessor(timeline.slice(0, 3), 1, (item) => item)).toBe(false);

        const settledParts = [
            { state: { status: 'completed' } },
            { state: { status: 'completed' } },
        ];
        expect(isProcessGroupActive(settledParts)).toBe(false);
        expect(isProcessGroupActive({
            parts: settledParts,
            hasFollowingOtherType: false,
            isTurnLive: true,
        })).toBe(true);
        expect(isProcessGroupActive({
            parts: settledParts,
            hasFollowingOtherType: true,
            isTurnLive: true,
        })).toBe(false);
        expect(isProcessGroupActive({
            parts: [
                { state: { status: 'completed' } },
                { state: { status: 'running' } },
            ],
            hasFollowingOtherType: true,
            isTurnLive: false,
        })).toBe(true);
    });
});
