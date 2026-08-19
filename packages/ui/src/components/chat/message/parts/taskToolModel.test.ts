import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import {
    applyAuthoritativeTaskSessionIdToSubtaskParts,
    buildTaskSummaryEntriesFromSession,
    formatTaskStructuredOutputForMarkdown,
    parseSubagentNotification,
    parseTaskMetadataBlock,
    prepareTaskOutputForDisplay,
    readTaskRunningFromOutput,
    readTaskSessionIdFromRecord,
    readTaskSessionIdFromOutput,
    readTaskStatusFromRecord,
    resolveTaskRowChrome,
} from './taskToolModel';

describe('taskToolModel', () => {
    test('reads the current OpenCode running-state identity contract', () => {
        expect(readTaskSessionIdFromRecord({ sessionId: 'child-live' })).toBe('child-live');
        expect(readTaskSessionIdFromRecord({})).toBe(undefined);
    });

    test('prefers sessionId when identity aliases conflict', () => {
        expect(readTaskSessionIdFromRecord({ sessionId: 'child-preferred', sessionID: 'child-legacy' })).toBe('child-preferred');
        expect(parseTaskMetadataBlock('<task_metadata>{"sessionId":"child-preferred","sessionID":"child-legacy"}</task_metadata>').sessionId).toBe('child-preferred');
    });

    test('reads authoritative session and summary metadata', () => {
        const output = 'result\n<task_metadata>{"sessionID":"child-1","calls":[{"id":"tool-1","tool":"read","title":"a.ts"}]}</task_metadata>';
        expect(parseTaskMetadataBlock(output)).toEqual({
            sessionId: 'child-1',
            summaryEntries: [{ id: 'tool-1', tool: 'read', state: { status: undefined, title: 'a.ts', input: undefined } }],
        });
        expect(readTaskSessionIdFromOutput(output)).toBe('child-1');
    });

    test('reads background running hints from settled task records and output', () => {
        expect(readTaskStatusFromRecord({ sessionId: 'child-1', status: 'running' })).toBe('running');
        expect(readTaskStatusFromRecord({ status: 'completed' })).toBe('completed');
        expect(readTaskStatusFromRecord('running')).toBe(undefined);
        expect(readTaskStatusFromRecord(undefined)).toBe(undefined);

        expect(parseTaskMetadataBlock('<task_metadata>{"sessionID":"child-1","status":"running"}</task_metadata>').status).toBe('running');

        expect(readTaskRunningFromOutput('<task_metadata>{"sessionID":"child-1","status":"running"}</task_metadata>')).toBe(true);
        expect(readTaskRunningFromOutput('Task started in background.\nsession_id: ses_child_1\nstatus: running')).toBe(true);
        expect(readTaskRunningFromOutput('All work finished. status: completed')).toBe(false);
        expect(readTaskRunningFromOutput(undefined)).toBe(false);
        expect(readTaskRunningFromOutput('')).toBe(false);
    });

    test('parses background subagent completion notifications', () => {
        const completed = '<subagent sessionID="ses_child_1" state="completed" description="探查同步层现状">\n结果正文\n</subagent>';
        expect(parseSubagentNotification(completed)).toEqual({
            sessionID: 'ses_child_1',
            state: 'completed',
            description: '探查同步层现状',
            body: '结果正文',
        });

        expect(parseSubagentNotification('<subagent sessionId="ses_child_2" state="error">失败</subagent>')?.state).toBe('error');
        expect(parseSubagentNotification('<subagent sessionID="ses_child_3" state="cancelled"></subagent>')?.body).toBe('');

        // 非 subagent 通知文本原样放行
        expect(parseSubagentNotification('普通用户输入')).toBe(undefined);
        expect(parseSubagentNotification('<subagent sessionID="ses_child_4">缺 state</subagent>')).toBe(undefined);
        expect(parseSubagentNotification(undefined)).toBe(undefined);
    });

    test('projects tool calls while excluding nested task and todo bookkeeping', () => {
        const message = {
            info: { id: 'message-1', role: 'assistant' } as Message,
            parts: [
                { id: 'read-1', type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'a.ts' } } },
                { id: 'task-1', type: 'tool', tool: 'task', state: { status: 'running' } },
                { id: 'todo-1', type: 'tool', tool: 'todowrite', state: { status: 'completed' } },
            ] as unknown as Part[],
        };

        expect(buildTaskSummaryEntriesFromSession([message])).toEqual([{
            id: 'read-1',
            tool: 'read',
            state: { status: 'completed', title: undefined, input: { filePath: 'a.ts' } },
        }]);
    });

    test('applies the bridge session ID over a synthesized subtask ID', () => {
        const parts = [{ type: 'subtask', taskSessionID: 'child-synthesized' }] as unknown as Part[];

        expect(applyAuthoritativeTaskSessionIdToSubtaskParts(parts, 'child-bridge')).toEqual([
            { type: 'subtask', taskSessionID: 'child-bridge' },
        ]);
    });

    test('converts structured subagent output tags into markdown sections', () => {
        const structured = [
            '<summary>',
            'Fixed the bug in `AssistantView.tsx`.',
            '</summary>',
            '',
            '<changes>',
            '- Updated `AssistantView.tsx`',
            '- Added tests in `taskToolModel.test.ts`',
            '</changes>',
            '',
            '<verification>',
            '- `bun test packages/ui/src/components/chat/message/parts/taskToolModel.test.ts`',
            '</verification>',
        ].join('\n');

        expect(formatTaskStructuredOutputForMarkdown(structured)).toBe([
            '## Summary',
            '',
            'Fixed the bug in `AssistantView.tsx`.',
            '',
            '## Changes',
            '',
            '- Updated `AssistantView.tsx`',
            '- Added tests in `taskToolModel.test.ts`',
            '',
            '## Verification',
            '',
            '- `bun test packages/ui/src/components/chat/message/parts/taskToolModel.test.ts`',
        ].join('\n'));
    });

    test('prepareTaskOutputForDisplay strips metadata and formats structured sections', () => {
        const output = [
            '<summary>Done</summary>',
            '<task_metadata>{"sessionID":"child-1"}</task_metadata>',
        ].join('\n');

        expect(prepareTaskOutputForDisplay(output)).toBe('## Summary\n\nDone');
    });

    test('ordinary running tools keep their own title instead of the delegating label', () => {
        expect(resolveTaskRowChrome({
            isTaskTool: false,
            isFinalized: false,
            displayName: '读取文件',
            delegatingLabel: '委派任务中...',
            formatName: (name) => name,
        })).toEqual({
            isDelegating: false,
            showAvatar: false,
            title: '读取文件',
        });
    });

    test('settled tasks never stay on the delegating label even without a child session', () => {
        const chrome = resolveTaskRowChrome({
            isTaskTool: true,
            isFinalized: true,
            displayName: 'Agent 任务',
            delegatingLabel: '委派任务中...',
            formatName: (name) => name.charAt(0).toUpperCase() + name.slice(1),
        });

        expect(chrome).toEqual({
            isDelegating: false,
            showAvatar: false,
            title: 'Agent 任务',
        });
    });

    test('assigned busy tasks keep the agent name instead of delegating', () => {
        expect(resolveTaskRowChrome({
            isTaskTool: true,
            isFinalized: false,
            taskSessionId: 'ses_child',
            taskAgentName: 'explorer',
            displayName: 'Agent 任务',
            delegatingLabel: '委派任务中...',
            formatName: (name) => name.charAt(0).toUpperCase() + name.slice(1),
        })).toEqual({
            isDelegating: false,
            showAvatar: true,
            title: 'Explorer',
        });
    });

    test('only live tasks without a session or agent stay delegating', () => {
        expect(resolveTaskRowChrome({
            isTaskTool: true,
            isFinalized: false,
            displayName: 'Agent 任务',
            delegatingLabel: '委派任务中...',
            formatName: (name) => name,
        })).toEqual({
            isDelegating: true,
            showAvatar: false,
            title: '委派任务中...',
        });
    });
});
