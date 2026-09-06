import { describe, expect, test } from 'bun:test';

import {
    isContextGroupTool,
    isExpandableTool,
    isProcessGroupTool,
    isSkillGroupTool,
    isStaticTool,
    isToolPartActive,
    isToolPartSettled,
    isUsedGroupTool,
} from './toolRenderUtils';

describe('tool rendering classification', () => {
    test('keeps navigation tools compact', () => {
        expect(isStaticTool('read')).toBe(true);
        expect(isStaticTool('skill')).toBe(true);
        expect(isExpandableTool('read')).toBe(false);
        expect(isExpandableTool('skill')).toBe(false);
    });

    test('expands built-in tools without direct navigation', () => {
        expect(isExpandableTool('grep')).toBe(true);
        expect(isExpandableTool('webfetch')).toBe(true);
        expect(isExpandableTool('todowrite')).toBe(true);
    });

    test('expands custom and MCP tools', () => {
        expect(isExpandableTool('linear_list_issues')).toBe(true);
        expect(isExpandableTool('my-plugin_publish')).toBe(true);
        expect(isStaticTool('linear_list_issues')).toBe(false);
    });

    test('normalizes dotted and indexed tool names', () => {
        expect(isStaticTool('runtime.read:2')).toBe(true);
        expect(isExpandableTool('runtime.custom_tool:2')).toBe(true);
        expect(isContextGroupTool('runtime.grep:3')).toBe(true);
    });

    test('marks consecutive exploration tools as context-group members', () => {
        expect(isContextGroupTool('read')).toBe(true);
        expect(isContextGroupTool('glob')).toBe(true);
        expect(isContextGroupTool('grep')).toBe(true);
        expect(isContextGroupTool('list')).toBe(true);
        expect(isContextGroupTool('skill')).toBe(false);
        expect(isContextGroupTool('bash')).toBe(false);
        expect(isContextGroupTool('edit')).toBe(false);
    });

    test('marks explore and used tools as one process-group class', () => {
        expect(isProcessGroupTool('read')).toBe(true);
        expect(isProcessGroupTool('grep')).toBe(true);
        expect(isProcessGroupTool('edit')).toBe(true);
        expect(isProcessGroupTool('bash')).toBe(true);
        expect(isProcessGroupTool('websearch')).toBe(true);
        expect(isUsedGroupTool('edit')).toBe(true);
        expect(isUsedGroupTool('bash')).toBe(true);
        expect(isUsedGroupTool('read')).toBe(false);
        expect(isProcessGroupTool('skill')).toBe(false);
        expect(isProcessGroupTool('task')).toBe(false);
        expect(isProcessGroupTool('question')).toBe(false);
        expect(isUsedGroupTool('skill')).toBe(false);
        expect(isUsedGroupTool('task')).toBe(false);
        expect(isUsedGroupTool('question')).toBe(false);
    });

    test('marks skill tools as skill-group members', () => {
        expect(isSkillGroupTool('skill')).toBe(true);
        expect(isSkillGroupTool('runtime.skill:2')).toBe(true);
        expect(isSkillGroupTool('read')).toBe(false);
        expect(isSkillGroupTool('bash')).toBe(false);
    });

    test('keeps visible calls active until status or timing proves settlement', () => {
        expect(isToolPartActive({ state: undefined })).toBe(true);
        expect(isToolPartActive({ state: { status: 'pending' } })).toBe(true);
        expect(isToolPartActive({ state: { status: 'started' } })).toBe(true);
        expect(isToolPartActive({ state: { status: 'running', time: { start: 10, end: 20 } } })).toBe(true);
        expect(isToolPartActive({ state: { status: 'unknown' } })).toBe(true);
    });

    test('settles completed, failed, cancelled, and end-timed calls', () => {
        for (const status of ['completed', 'error', 'failed', 'aborted', 'timeout', 'cancelled']) {
            expect(isToolPartSettled({ state: { status } })).toBe(true);
        }
        expect(isToolPartSettled({ state: { status: 'unknown', time: { start: 10, end: 20 } } })).toBe(true);
        expect(isToolPartSettled({ state: { status: 'unknown', time: { start: 20, end: 10 } } })).toBe(false);
    });
});
