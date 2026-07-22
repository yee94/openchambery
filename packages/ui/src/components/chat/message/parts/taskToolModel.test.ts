import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import {
    applyAuthoritativeTaskSessionIdToSubtaskParts,
    buildTaskSummaryEntriesFromSession,
    formatTaskStructuredOutputForMarkdown,
    parseTaskMetadataBlock,
    prepareTaskOutputForDisplay,
    readTaskSessionIdFromRecord,
    readTaskSessionIdFromOutput,
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
});
