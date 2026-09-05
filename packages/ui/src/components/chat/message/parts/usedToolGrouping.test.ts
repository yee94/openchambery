import { describe, expect, test } from 'bun:test';

import {
    collectConsecutiveUsedTools,
    hasUsedRunSuccessor,
    isUsedGroupRunning,
    isUsedRunSuccessorPart,
    isUsedToolActive,
    summarizeUsedToolDiffs,
    summarizeUsedTools,
    usedToolCountKey,
} from './usedToolGrouping';

describe('used tool grouping', () => {
    test('merges consecutive edit/bash/custom names and splits on explore, skill, task, and question', () => {
        const tools = ['edit', 'write', 'bash', 'read', 'bash', 'skill', 'apply_patch', 'task', 'websearch', 'question', 'edit'];
        const first = collectConsecutiveUsedTools(tools, 0, (name) => name);
        expect(first.items).toEqual(['edit', 'write', 'bash']);
        expect(first.end).toBe(3);

        const afterRead = collectConsecutiveUsedTools(tools, 4, (name) => name);
        expect(afterRead.items).toEqual(['bash']);
        expect(afterRead.end).toBe(5);

        const afterSkill = collectConsecutiveUsedTools(tools, 6, (name) => name);
        expect(afterSkill.items).toEqual(['apply_patch']);
        expect(afterSkill.end).toBe(7);

        const afterTask = collectConsecutiveUsedTools(tools, 8, (name) => name);
        expect(afterTask.items).toEqual(['websearch']);
        expect(afterTask.end).toBe(9);

        const afterQuestion = collectConsecutiveUsedTools(tools, 10, (name) => name);
        expect(afterQuestion.items).toEqual(['edit']);
        expect(afterQuestion.end).toBe(11);
    });

    test('counts edits, commands, and leftover calls separately', () => {
        expect(usedToolCountKey('read')).toBeNull();
        expect(usedToolCountKey('task')).toBeNull();
        expect(usedToolCountKey('question')).toBeNull();
        expect(summarizeUsedTools(['edit', 'write', 'apply_patch', 'bash', 'shell', 'websearch', 'todowrite'])).toEqual({
            edit: 3,
            command: 2,
            other: 2,
        });
    });

    test('aggregates metadata, per-file, patch, and write-content line totals', () => {
        expect(summarizeUsedToolDiffs([
            { state: { metadata: { additions: 3, deletions: 1 } } },
            { state: { metadata: { files: [{ additions: 2, deletions: 4 }, { additions: 1, deletions: 0 }] } } },
            { state: { metadata: { diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n+extra\n' } } },
            { state: { input: { content: 'one\ntwo\nthree' } } },
        ])).toEqual({ added: 3 + 3 + 2 + 3, removed: 1 + 4 + 1 + 0 });
    });

    test('treats pending, running, and started tools as active', () => {
        expect(isUsedToolActive({ state: { status: 'pending' } })).toBe(true);
        expect(isUsedToolActive({ state: { status: 'running' } })).toBe(true);
        expect(isUsedToolActive({ state: { status: 'started' } })).toBe(true);
        expect(isUsedToolActive({ state: { status: 'completed' } })).toBe(false);
        expect(isUsedToolActive({ state: { status: 'error' } })).toBe(false);
    });

    test('keeps running until a later non-used part appears', () => {
        expect(isUsedRunSuccessorPart({ kind: 'reasoning' })).toBe(false);
        expect(isUsedRunSuccessorPart({ kind: 'justification' })).toBe(true);
        expect(isUsedRunSuccessorPart({ kind: 'tool', toolName: 'bash' })).toBe(false);
        expect(isUsedRunSuccessorPart({ kind: 'tool', toolName: 'grep' })).toBe(true);
        expect(isUsedRunSuccessorPart({ kind: 'tool', toolName: 'task' })).toBe(true);

        const timeline = [
            { kind: 'tool', toolName: 'bash' },
            { kind: 'reasoning' },
            { kind: 'tool', toolName: 'read' },
        ];
        expect(hasUsedRunSuccessor(timeline, 1, (item) => item)).toBe(true);
        expect(hasUsedRunSuccessor(timeline.slice(0, 2), 1, (item) => item)).toBe(false);

        const settledParts = [
            { state: { status: 'completed' } },
            { state: { status: 'completed' } },
        ];
        expect(isUsedGroupRunning(settledParts)).toBe(false);
        expect(isUsedGroupRunning({
            parts: settledParts,
            hasFollowingOtherType: false,
            isTurnLive: true,
        })).toBe(true);
        expect(isUsedGroupRunning({
            parts: settledParts,
            hasFollowingOtherType: true,
            isTurnLive: true,
        })).toBe(false);
        expect(isUsedGroupRunning({
            parts: [
                { state: { status: 'completed' } },
                { state: { status: 'running' } },
            ],
            hasFollowingOtherType: true,
            isTurnLive: false,
        })).toBe(true);
    });
});
