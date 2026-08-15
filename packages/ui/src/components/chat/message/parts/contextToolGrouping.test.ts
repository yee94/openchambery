import { describe, expect, test } from 'bun:test';

import {
    collectConsecutiveContextTools,
    hasContextExploreSuccessor,
    isContextExploreSuccessorPart,
    isContextGroupExploring,
    isContextToolActive,
    summarizeContextTools,
} from './contextToolGrouping';

describe('context tool grouping', () => {
    test('merges consecutive read/glob/grep/list names and splits on other tools', () => {
        const tools = ['read', 'glob', 'grep', 'list', 'bash', 'read', 'edit', 'grep'];
        const first = collectConsecutiveContextTools(tools, 0, (name) => name);
        expect(first.items).toEqual(['read', 'glob', 'grep', 'list']);
        expect(first.end).toBe(4);

        const afterBash = collectConsecutiveContextTools(tools, 5, (name) => name);
        expect(afterBash.items).toEqual(['read']);
        expect(afterBash.end).toBe(6);

        const afterEdit = collectConsecutiveContextTools(tools, 7, (name) => name);
        expect(afterEdit.items).toEqual(['grep']);
        expect(afterEdit.end).toBe(8);
    });

    test('counts glob and grep together as searches', () => {
        expect(summarizeContextTools(['read', 'read', 'read', 'glob', 'grep', 'list'])).toEqual({
            read: 3,
            search: 2,
            list: 1,
        });
    });

    test('treats pending, running, and started tools as active', () => {
        expect(isContextToolActive({ state: { status: 'pending' } })).toBe(true);
        expect(isContextToolActive({ state: { status: 'running' } })).toBe(true);
        expect(isContextToolActive({ state: { status: 'started' } })).toBe(true);
        expect(isContextToolActive({ state: { status: 'completed' } })).toBe(false);
        expect(isContextToolActive({ state: { status: 'error' } })).toBe(false);
        expect(isContextToolActive({ state: { status: 'cancelled' } })).toBe(false);
    });

    test('keeps exploring until a later non-explore part appears', () => {
        expect(isContextExploreSuccessorPart({ kind: 'reasoning' })).toBe(false);
        expect(isContextExploreSuccessorPart({ kind: 'justification' })).toBe(true);
        expect(isContextExploreSuccessorPart({ kind: 'tool', toolName: 'grep' })).toBe(false);
        expect(isContextExploreSuccessorPart({ kind: 'tool', toolName: 'bash' })).toBe(true);

        const timeline = [
            { kind: 'tool', toolName: 'grep' },
            { kind: 'reasoning' },
            { kind: 'tool', toolName: 'bash' },
        ];
        expect(hasContextExploreSuccessor(timeline, 1, (item) => item)).toBe(true);
        expect(hasContextExploreSuccessor(timeline.slice(0, 2), 1, (item) => item)).toBe(false);

        expect(isContextGroupExploring([
            { state: { status: 'completed' } },
            { state: { status: 'completed' } },
        ])).toBe(false);
        expect(isContextGroupExploring([
            { state: { status: 'completed' } },
            { state: { status: 'running' } },
        ])).toBe(true);
    });
});
